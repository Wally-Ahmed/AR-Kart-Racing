/**
 * Placement derivation — the pure core of the director screen.
 *
 * Spec `docs/design/arkart-game-software-v1.md` §1 states the rule as:
 *
 *   "rank by `lap` (higher first), then `next_checkpoint_idx` (higher first), then
 *    `ts_of_last_pass` (**earlier** first)"
 *
 * …but taken literally that is WRONG at the lap wrap, and the module leg proved it:
 * `next_idx` wraps to 0 once a kart has cleared every gate and is running at the start/finish
 * line, so raw `next_idx DESC` ranks the kart closest to the line DEAD LAST for exactly the
 * moment that matters most on camera.
 *
 * The authoritative rule (matches the module's own `progress.placement` computation):
 *
 *   lap DESC → clearedThisLap DESC → last_pass_at ASC → kart_id ASC
 *   where clearedThisLap = (next_idx === 0 ? track_length : next_idx)
 *
 * `next_idx === 0` means "seq-0, the start/finish gate, is what I am driving at", i.e. every
 * other gate on this lap is already behind me — the maximum, not the minimum.
 *
 * The live screen does not rely on this at all: it sorts by the module's published
 * `progress.placement` whenever that is usable (see `buildStandings`), so the authoritative
 * server is the source of truth by construction. This comparator is the fallback, and what the
 * mock adapter races on.
 *
 * No DOM, no SDK, no clock: everything here is a pure function of its arguments so it can be
 * unit-tested and reused by the module/bridge if useful.
 */

import type {
  EffectRow,
  InventoryRow,
  ItemKind,
  KartRow,
  ProgressRow,
  TrackRow,
} from './types.ts';

/** The subset of `progress` the ranking actually reads. */
export interface Rankable {
  kart_id: number;
  lap: number;
  next_idx: number;
  /** epoch ms of the last checkpoint pass */
  last_pass_at: number;
}

/**
 * Gates cleared on the current lap, 1..trackLength.
 *
 * THE lap-wrap fix. `next_idx` counts *forward* to the gate being driven at, so it collapses to
 * 0 at the top of the lap — the moment a kart has cleared everything and is on the line. Mapping
 * that 0 to `trackLength` turns the field back into a monotonic "how far round am I" measure.
 *
 * With no confirmed track (`trackLength <= 0`) there is nothing to wrap against, so `next_idx`
 * passes through unchanged.
 */
export function clearedThisLap(row: Rankable, trackLength: number): number {
  if (trackLength <= 0) return row.next_idx;
  return row.next_idx === 0 ? trackLength : row.next_idx;
}

/**
 * The placement comparator: negative when `a` is ahead of `b`.
 *
 * Order, in priority: lap DESC → clearedThisLap DESC → last_pass_at ASC (earlier wins the tie:
 * the kart that reached this progress point sooner is ahead) → kart_id ASC (deterministic final
 * tiebreak so rendering never flickers; two karts cannot share a gate-pass timestamp in practice
 * — R§4g keys detection per (kart, tag)).
 *
 * `trackLength` is required for the wrap fix; it defaults to 0 only so a caller with no track
 * yet still gets a stable order.
 */
export function comparePlacement(a: Rankable, b: Rankable, trackLength = 0): number {
  if (a.lap !== b.lap) return b.lap - a.lap;
  const ca = clearedThisLap(a, trackLength);
  const cb = clearedThisLap(b, trackLength);
  if (ca !== cb) return cb - ca;
  if (a.last_pass_at !== b.last_pass_at) return a.last_pass_at - b.last_pass_at;
  return a.kart_id - b.kart_id;
}

/** A 2-arg comparator bound to a track length, for `Array.prototype.sort`. */
export function placementComparator(trackLength: number) {
  return (a: Rankable, b: Rankable): number => comparePlacement(a, b, trackLength);
}

/** Sorted copy of `rows`, leader first. Never mutates the input. */
export function orderByPlacement<T extends Rankable>(rows: readonly T[], trackLength = 0): T[] {
  return [...rows].sort(placementComparator(trackLength));
}

/** kart_id → 1-based placement, derived locally (cross-checks the module's `placement`). */
export function computePlacements(
  rows: readonly Rankable[],
  trackLength = 0,
): Map<number, number> {
  const out = new Map<number, number>();
  orderByPlacement(rows, trackLength).forEach((row, i) => out.set(row.kart_id, i + 1));
  return out;
}

/**
 * Gates cleared since the race started — the scalar behind the progress bar and the gap text.
 *
 * `clearedThisLap` is 1-based (a kart sitting on the grid has `next_idx = 1`, i.e. one "cleared"
 * gate: the start line it is parked on), so the −1 normalises the grid to zero. Strictly
 * monotonic with the comparator's (lap, cleared) ordering, so the bars can never disagree with
 * the standings. `trackLength` of 0 (track not confirmed) degrades to the lap count.
 */
export function absoluteProgress(row: Rankable, trackLength: number): number {
  if (trackLength <= 0) return row.lap;
  return Math.max(0, row.lap * trackLength + clearedThisLap(row, trackLength) - 1);
}

/** Gates the leader is ahead by. 0 when level (gap then reads as a time delta). */
export function gateGap(leader: Rankable, other: Rankable, trackLength: number): number {
  return absoluteProgress(leader, trackLength) - absoluteProgress(other, trackLength);
}

/** Item slots as a fixed-length pair, so the UI always draws exactly two boxes. */
export function inventorySlots(inv: InventoryRow | undefined): [ItemKind | null, ItemKind | null] {
  return [inv?.slot1 ?? null, inv?.slot2 ?? null];
}

/**
 * Active effects for one kart at time `now`.
 * An effect with `expires_at === null` never times out (shield: consumed on hit).
 * Sorted soonest-expiring first so the HUD chips are stable.
 */
export function activeEffects(
  effects: readonly EffectRow[],
  kartId: number,
  now: number,
): EffectRow[] {
  return effects
    .filter((e) => e.kart_id === kartId && (e.expires_at === null || e.expires_at > now))
    .sort((a, b) => (a.expires_at ?? Infinity) - (b.expires_at ?? Infinity));
}

/** Milliseconds left on an effect, or null when it has no expiry (shield). */
export function effectRemainingMs(effect: EffectRow, now: number): number | null {
  if (effect.expires_at === null) return null;
  return Math.max(0, effect.expires_at - now);
}

/**
 * Speed cap the car bridge would currently apply (spec §5): product of the multipliers,
 * floored at 0.2; `stun` forces 0. Purely informational on this screen — it lets the
 * director see *why* a kart is crawling.
 */
export function speedCap(effects: readonly EffectRow[], kartId: number, now: number): number {
  const mine = activeEffects(effects, kartId, now);
  if (mine.some((e) => e.kind === 'stun')) return 0;
  const product = mine
    .filter((e) => e.kind === 'boost' || e.kind === 'slow')
    .reduce((acc, e) => acc * (Number.isFinite(e.multiplier) ? e.multiplier : 1), 1);
  return Math.max(0.2, product);
}

/** Everything the standings list needs for one kart, already derived. */
export interface Standing {
  kart: KartRow;
  progress: ProgressRow;
  placement: number;
  /** 'module' when the order came straight off `progress.placement`, 'derived' when computed here. */
  source: PlacementSource;
  slots: [ItemKind | null, ItemKind | null];
  effects: EffectRow[];
  speedCap: number;
  /** Gates behind the leader; 0 for the leader itself. */
  gateGap: number;
  /** Fraction 0..1 of the whole race completed. */
  raceFraction: number;
  finished: boolean;
}

/**
 * Stand-in for a kart with no `progress` row yet (pre-race lobby).
 * `next_idx: 1` is the grid state — parked on seq 0, driving at seq 1 — NOT `0`, which under the
 * wrap rule would claim the kart had already cleared the whole lap.
 */
const DEFAULT_PROGRESS = (kartId: number): ProgressRow => ({
  kart_id: kartId,
  lap: 0,
  next_idx: 1,
  last_pass_at: 0,
  placement: 0,
  finished_at: null,
});

export type PlacementSource = 'module' | 'derived';

/**
 * The module publishes its verdict in `progress.placement`. That is authoritative — SpacetimeDB
 * decides the race, not this screen — so it is usable whenever every kart carries a distinct
 * 1-based placement. Anything less (a kart with no progress row yet, a pre-race table of zeroes,
 * duplicate placements mid-write) falls back to the local comparator.
 */
export function placementSource(rows: readonly ProgressRow[]): PlacementSource {
  if (rows.length === 0) return 'derived';
  const places = rows.map((r) => r.placement);
  if (!places.every((p) => Number.isInteger(p) && p > 0 && p <= rows.length)) return 'derived';
  return new Set(places).size === rows.length ? 'module' : 'derived';
}

/**
 * Build the ranked standings table. Karts with no `progress` row yet (pre-race) are
 * included with a zeroed row so the lobby still shows the grid.
 *
 * Ordering prefers the module's own `placement` column; the pure comparator is the fallback.
 */
export function buildStandings(input: {
  karts: readonly KartRow[];
  progress: readonly ProgressRow[];
  inventory: readonly InventoryRow[];
  effects: readonly EffectRow[];
  track: readonly TrackRow[];
  lapCount: number;
  now: number;
}): Standing[] {
  const { karts, progress, inventory, effects, track, lapCount, now } = input;
  const progressById = new Map(progress.map((p) => [p.kart_id, p]));
  const invById = new Map(inventory.map((i) => [i.kart_id, i]));
  const rows: ProgressRow[] = karts.map(
    (k) => progressById.get(k.kart_id) ?? DEFAULT_PROGRESS(k.kart_id),
  );
  const trackLength = track.length;
  const source = placementSource(rows);
  const ordered =
    source === 'module'
      ? [...rows].sort((a, b) => a.placement - b.placement || a.kart_id - b.kart_id)
      : orderByPlacement(rows, trackLength);
  const leader = ordered[0];
  const totalGates = Math.max(1, trackLength * Math.max(1, lapCount));
  const kartById = new Map(karts.map((k) => [k.kart_id, k]));

  return ordered.map((row, i) => {
    const kart = kartById.get(row.kart_id)!;
    return {
      kart,
      progress: row,
      placement: i + 1,
      source,
      slots: inventorySlots(invById.get(row.kart_id)),
      effects: activeEffects(effects, row.kart_id, now),
      speedCap: speedCap(effects, row.kart_id, now),
      gateGap: leader ? gateGap(leader, row, trackLength) : 0,
      raceFraction: Math.min(1, absoluteProgress(row, trackLength) / totalGates),
      finished: row.finished_at !== null,
    };
  });
}

/**
 * Validate a proposed track order against the confirm-time constraints in spec §2:
 * ≥3 checkpoints and no duplicates. (The printed-whitelist check lives in the module —
 * the screen has no whitelist to check against.)
 */
export function validateTrackOrder(tagIds: readonly number[]): { ok: boolean; reason: string } {
  if (tagIds.length < 3) return { ok: false, reason: 'need at least 3 checkpoints' };
  if (new Set(tagIds).size !== tagIds.length) return { ok: false, reason: 'duplicate tag ids' };
  return { ok: true, reason: '' };
}

/** Move an item within an array, returning a new array. Used by the manual reorder path. */
export function moveItem<T>(arr: readonly T[], from: number, to: number): T[] {
  const out = [...arr];
  if (from < 0 || from >= out.length || to < 0 || to >= out.length) return out;
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item);
  return out;
}
