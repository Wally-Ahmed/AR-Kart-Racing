import { describe, expect, it } from 'vitest';
import {
  absoluteProgress,
  activeEffects,
  buildStandings,
  clearedThisLap,
  comparePlacement,
  computePlacements,
  effectRemainingMs,
  gateGap,
  inventorySlots,
  moveItem,
  orderByPlacement,
  placementSource,
  speedCap,
  validateTrackOrder,
  type Rankable,
} from './placement.ts';
import type { EffectRow, InventoryRow, KartRow, ProgressRow, TrackRow } from './types.ts';

const r = (kart_id: number, lap: number, next_idx: number, last_pass_at: number): Rankable => ({
  kart_id,
  lap,
  next_idx,
  last_pass_at,
});

/** Every test below races on the same 3-gate track unless it says otherwise. */
const LEN = 3;

describe('clearedThisLap — the lap-wrap fix', () => {
  it('maps next_idx 0 to the full track length (all gates cleared, running at the line)', () => {
    expect(clearedThisLap(r(1, 1, 0, 0), LEN)).toBe(3);
    expect(clearedThisLap(r(1, 1, 1, 0), LEN)).toBe(1);
    expect(clearedThisLap(r(1, 1, 2, 0), LEN)).toBe(2);
  });

  it('passes next_idx through when no track is confirmed', () => {
    expect(clearedThisLap(r(1, 0, 0, 0), 0)).toBe(0);
    expect(clearedThisLap(r(1, 0, 2, 0), 0)).toBe(2);
  });
});

describe('comparePlacement — lap DESC, clearedThisLap DESC, ts ASC, kart_id ASC', () => {
  it('REGRESSION: a kart at next_idx 0 is running at the line, not stone last', () => {
    // The literal spec reading (next_idx DESC) ranks these the wrong way round: it would put
    // kart 2 first because 2 > 0. Kart 1 has cleared all three gates and is on the finish line.
    const onTheLine = r(1, 1, 0, 9000); // cleared = 3
    const midLap = r(2, 1, 2, 1000); // cleared = 2, and an EARLIER timestamp
    expect(comparePlacement(onTheLine, midLap, LEN)).toBeLessThan(0);
    expect(comparePlacement(midLap, onTheLine, LEN)).toBeGreaterThan(0);
    expect(orderByPlacement([midLap, onTheLine], LEN).map((x) => x.kart_id)).toEqual([1, 2]);
    // …and the naive rule really would have inverted it, which is the whole point:
    expect(orderByPlacement([midLap, onTheLine], 0).map((x) => x.kart_id)).toEqual([2, 1]);
  });

  it('ranks the higher lap first even with a lower checkpoint index', () => {
    const ahead = r(1, 2, 1, 5000); // lap 2, one gate in
    const behind = r(2, 1, 0, 4000); // lap 1 and on the line — still a lap down
    expect(comparePlacement(ahead, behind, LEN)).toBeLessThan(0);
    expect(comparePlacement(behind, ahead, LEN)).toBeGreaterThan(0);
  });

  it('on the same lap, ranks the higher cleared count first', () => {
    const ahead = r(1, 1, 2, 9000);
    const behind = r(2, 1, 1, 1000); // earlier timestamp must NOT rescue a lower index
    expect(comparePlacement(ahead, behind, LEN)).toBeLessThan(0);
    expect(comparePlacement(behind, ahead, LEN)).toBeGreaterThan(0);
  });

  it('breaks a lap+cleared tie with the EARLIER last_pass_at', () => {
    const sooner = r(7, 1, 2, 1000);
    const later = r(3, 1, 2, 1001);
    expect(comparePlacement(sooner, later, LEN)).toBeLessThan(0);
    expect(comparePlacement(later, sooner, LEN)).toBeGreaterThan(0);
    // and the earlier kart really does come out in front of the sort
    expect(orderByPlacement([later, sooner], LEN).map((x) => x.kart_id)).toEqual([7, 3]);
  });

  it('breaks a tie between two karts both sitting on the line', () => {
    const sooner = r(5, 2, 0, 4000);
    const later = r(4, 2, 0, 4500);
    expect(orderByPlacement([later, sooner], LEN).map((x) => x.kart_id)).toEqual([5, 4]);
  });

  it('falls back to kart_id for a total tie, deterministically', () => {
    const a = r(1, 0, 1, 0);
    const b = r(2, 0, 1, 0);
    expect(comparePlacement(a, b, LEN)).toBeLessThan(0);
    expect(comparePlacement(a, a, LEN)).toBe(0);
  });

  it('is a consistent total order over a mixed field including a wrap', () => {
    const field = [
      r(4, 0, 1, 100), // on the grid, nothing cleared
      r(1, 1, 1, 3000),
      r(2, 1, 1, 2000), // same progress as kart 1 but got there first
      r(3, 1, 0, 9000), // leader: all three gates cleared, on the line
    ];
    expect(orderByPlacement(field, LEN).map((x) => x.kart_id)).toEqual([3, 2, 1, 4]);
    // sorting is stable across input permutations
    expect(orderByPlacement([...field].reverse(), LEN).map((x) => x.kart_id)).toEqual([3, 2, 1, 4]);
    // and non-mutating
    expect(field.map((x) => x.kart_id)).toEqual([4, 1, 2, 3]);
  });

  it('computePlacements assigns 1-based placements leader-first', () => {
    const places = computePlacements([r(1, 1, 1, 3000), r(2, 1, 1, 2000), r(3, 1, 0, 8000)], LEN);
    expect(places.get(3)).toBe(1);
    expect(places.get(2)).toBe(2);
    expect(places.get(1)).toBe(3);
    expect(computePlacements([], LEN).size).toBe(0);
  });
});

describe('progress helpers', () => {
  it('absoluteProgress counts gates cleared across laps', () => {
    expect(absoluteProgress(r(1, 2, 3, 0), 5)).toBe(12); // 2 laps × 5 + 3 cleared − the grid
    expect(absoluteProgress(r(1, 2, 3, 0), 0)).toBe(2); // no track confirmed → laps only
    expect(absoluteProgress(r(1, 0, 1, 0), LEN)).toBe(0); // on the grid = nothing cleared
  });

  it('absoluteProgress increases monotonically across a wrap — bars can never contradict standings', () => {
    // one full lap of a 3-gate track: grid → g1 → g2 → on the line → lap done
    const walk: Array<[number, number]> = [
      [0, 1],
      [0, 2],
      [0, 0],
      [1, 1],
      [1, 2],
      [1, 0],
      [2, 1],
    ];
    const seq = walk.map(([lap, idx]) => absoluteProgress(r(1, lap, idx, 0), LEN));
    expect(seq).toEqual([0, 1, 2, 3, 4, 5, 6]);
    // and the comparator agrees with that ordering at every step
    for (let i = 1; i < walk.length; i++) {
      const ahead = r(1, walk[i][0], walk[i][1], 0);
      const behind = r(2, walk[i - 1][0], walk[i - 1][1], 0);
      expect(comparePlacement(ahead, behind, LEN)).toBeLessThan(0);
    }
  });

  it('gateGap measures how far back a kart is', () => {
    const leader = r(1, 1, 4, 0);
    const chaser = r(2, 1, 1, 0);
    expect(gateGap(leader, chaser, 5)).toBe(3);
    expect(gateGap(leader, leader, 5)).toBe(0);
  });
});

describe('inventory + effects', () => {
  const inv: InventoryRow = { kart_id: 1, slot1: 'boost', slot2: null };

  it('always yields exactly two slots', () => {
    expect(inventorySlots(inv)).toEqual(['boost', null]);
    expect(inventorySlots(undefined)).toEqual([null, null]);
  });

  const effects: EffectRow[] = [
    { id: 1, kart_id: 1, kind: 'boost', multiplier: 1.4, expires_at: 2000 },
    { id: 2, kart_id: 1, kind: 'shield', multiplier: 1, expires_at: null },
    { id: 3, kart_id: 1, kind: 'slow', multiplier: 0.3, expires_at: 900 }, // expired at now=1000
    { id: 4, kart_id: 2, kind: 'stun', multiplier: 0, expires_at: 5000 },
  ];

  it('filters to the kart, drops expired, keeps never-expiring shields', () => {
    const live = activeEffects(effects, 1, 1000);
    expect(live.map((e) => e.id)).toEqual([1, 2]); // soonest expiry first, shield last
  });

  it('reports remaining ms, null for the shield', () => {
    expect(effectRemainingMs(effects[0], 1000)).toBe(1000);
    expect(effectRemainingMs(effects[0], 9999)).toBe(0);
    expect(effectRemainingMs(effects[1], 1000)).toBeNull();
  });

  it('speedCap multiplies boost/slow, floors at 0.2, and zeroes on stun', () => {
    expect(speedCap(effects, 1, 1000)).toBeCloseTo(1.4);
    expect(speedCap(effects, 1, 500)).toBeCloseTo(0.42); // 1.4 * 0.3, still above the floor
    expect(speedCap(effects, 2, 1000)).toBe(0);
    expect(
      speedCap(
        [
          { id: 9, kart_id: 3, kind: 'slow', multiplier: 0.1, expires_at: 9999 },
          { id: 10, kart_id: 3, kind: 'slow', multiplier: 0.1, expires_at: 9999 },
        ],
        3,
        0,
      ),
    ).toBe(0.2); // floor
  });
});

describe('buildStandings', () => {
  const karts: KartRow[] = [
    { kart_id: 1, name: 'RED', ip: '10.0.0.11', pilot_identity: null },
    { kart_id: 2, name: 'BLUE', ip: '10.0.0.12', pilot_identity: null },
  ];
  const track: TrackRow[] = [
    { seq: 0, tag_id: 10 },
    { seq: 1, tag_id: 11 },
    { seq: 2, tag_id: 12 },
  ];

  it('ranks karts and fills in defaults for karts with no progress row', () => {
    const progress: ProgressRow[] = [
      { kart_id: 2, lap: 1, next_idx: 1, last_pass_at: 5000, placement: 1, finished_at: null },
    ];
    const standings = buildStandings({
      karts,
      progress,
      inventory: [{ kart_id: 2, slot1: 'shield', slot2: 'boost' }],
      effects: [],
      track,
      lapCount: 3,
      now: 6000,
    });
    expect(standings.map((s) => s.kart.name)).toEqual(['BLUE', 'RED']);
    expect(standings[0].placement).toBe(1);
    expect(standings[0].source).toBe('derived'); // RED has no row → module column unusable
    expect(standings[0].slots).toEqual(['shield', 'boost']);
    expect(standings[0].gateGap).toBe(0);
    expect(standings[1].gateGap).toBe(3); // leader has cleared a full lap; RED is on the grid
    expect(standings[1].progress.lap).toBe(0);
    expect(standings[1].progress.next_idx).toBe(1); // grid state, not "on the line"
    expect(standings[0].raceFraction).toBeCloseTo(3 / 9);
    expect(standings.every((s) => !s.finished)).toBe(true);
  });

  it('marks a finished kart', () => {
    const standings = buildStandings({
      karts,
      progress: [
        { kart_id: 1, lap: 3, next_idx: 0, last_pass_at: 9000, placement: 1, finished_at: 9000 },
      ],
      inventory: [],
      effects: [],
      track,
      lapCount: 3,
      now: 9500,
    });
    expect(standings[0].finished).toBe(true);
    expect(standings[0].raceFraction).toBe(1);
  });

  it('takes the MODULE placement as the source of truth when it is usable', () => {
    // The module says RED leads. The local comparator would disagree (BLUE has cleared more of
    // this lap). SpacetimeDB is authoritative, so RED must render P1 and the source say so.
    const progress: ProgressRow[] = [
      { kart_id: 1, lap: 1, next_idx: 1, last_pass_at: 5000, placement: 1, finished_at: null },
      { kart_id: 2, lap: 1, next_idx: 2, last_pass_at: 5500, placement: 2, finished_at: null },
    ];
    const args = { karts, progress, inventory: [], effects: [], track, lapCount: 3, now: 6000 };
    const standings = buildStandings(args);
    expect(standings.map((s) => s.kart.name)).toEqual(['RED', 'BLUE']);
    expect(standings.map((s) => s.source)).toEqual(['module', 'module']);
    // …and without the module's verdict the comparator really would have flipped them:
    const derived = buildStandings({
      ...args,
      progress: progress.map((p) => ({ ...p, placement: 0 })),
    });
    expect(derived.map((s) => s.kart.name)).toEqual(['BLUE', 'RED']);
    expect(derived[0].source).toBe('derived');
  });

  it('agrees with the module when the module applies the same wrap rule', () => {
    // Module's verdict for "kart 2 is on the line, kart 1 is mid-lap" — the exact wrap case.
    const progress: ProgressRow[] = [
      { kart_id: 1, lap: 1, next_idx: 2, last_pass_at: 5000, placement: 2, finished_at: null },
      { kart_id: 2, lap: 1, next_idx: 0, last_pass_at: 5500, placement: 1, finished_at: null },
    ];
    const args = { karts, progress, inventory: [], effects: [], track, lapCount: 3, now: 6000 };
    const fromModule = buildStandings(args).map((s) => s.kart.kart_id);
    const fromComparator = buildStandings({
      ...args,
      progress: progress.map((p) => ({ ...p, placement: 0 })),
    }).map((s) => s.kart.kart_id);
    expect(fromModule).toEqual([2, 1]);
    expect(fromComparator).toEqual(fromModule); // mock/fallback path == live path
  });
});

describe('placementSource', () => {
  const row = (kart_id: number, placement: number): ProgressRow => ({
    kart_id,
    lap: 0,
    next_idx: 1,
    last_pass_at: 0,
    placement,
    finished_at: null,
  });

  it('accepts a complete, distinct 1..n set', () => {
    expect(placementSource([row(1, 2), row(2, 1)])).toBe('module');
  });

  it('rejects zeroes, duplicates, out-of-range values and an empty table', () => {
    expect(placementSource([row(1, 0), row(2, 1)])).toBe('derived'); // pre-race
    expect(placementSource([row(1, 1), row(2, 1)])).toBe('derived'); // mid-write duplicate
    expect(placementSource([row(1, 1), row(2, 9)])).toBe('derived'); // stale/out of range
    expect(placementSource([])).toBe('derived');
  });
});

describe('track setup helpers', () => {
  it('validateTrackOrder enforces ≥3 checkpoints and no duplicates', () => {
    expect(validateTrackOrder([1, 2, 3]).ok).toBe(true);
    expect(validateTrackOrder([1, 2]).ok).toBe(false);
    expect(validateTrackOrder([1, 2, 2]).ok).toBe(false);
    expect(validateTrackOrder([1, 2, 2]).reason).toMatch(/duplicate/);
  });

  it('moveItem reorders without mutating', () => {
    const src = [10, 11, 12];
    expect(moveItem(src, 2, 0)).toEqual([12, 10, 11]);
    expect(moveItem(src, 0, 5)).toEqual([10, 11, 12]); // out of range → unchanged
    expect(src).toEqual([10, 11, 12]);
  });
});
