/**
 * Decoder tests pinned to REAL payloads captured from the live `arkart` module on 2026-09-20
 * (`curl -X POST --data 'SELECT * FROM <t>' localhost:3000/v1/database/arkart/sql`).
 * If the module's column names or encodings drift, these fail instead of the screen going blank.
 */
import { describe, expect, it } from 'vitest';
import { resultToObjects, type AlgebraicType } from './sql.ts';
import { assembleSnapshot } from './rows.ts';
import type { Json } from './coerce.ts';

const U32: AlgebraicType = { U32: [] };
const F32: AlgebraicType = { F32: [] };
const U64: AlgebraicType = { U64: [] };
const STR: AlgebraicType = { String: [] };
const TS: AlgebraicType = {
  Product: { elements: [{ name: { some: '__timestamp_micros_since_unix_epoch__' } }] },
};
const el = (name: string, algebraic_type: AlgebraicType) => ({ name: { some: name }, algebraic_type });
const optOf = (inner: AlgebraicType): AlgebraicType => ({
  Sum: {
    variants: [
      { name: { some: 'some' }, algebraic_type: inner },
      { name: { some: 'none' }, algebraic_type: { Product: { elements: [] } } },
    ],
  },
});

// --- verbatim captures ------------------------------------------------------

const CONFIG = {
  schema: {
    elements: [
      el('id', U32),
      el('lap_count', U32),
      el('item_roll_pct', U32),
      el('state', STR),
      el('countdown_ends_at', optOf(TS)),
    ],
  },
  rows: [[0, 3, 100, 'lobby', [1, []]]] as Json[][],
};

const KART = {
  schema: {
    elements: [
      el('kart_id', U32),
      el('name', STR),
      el('ip', STR),
      el('pilot_identity', optOf({ Product: { elements: [{ name: { some: '__identity__' } }] } })),
    ],
  },
  rows: [
    [1, 'Red Kart', '192.168.8.111', [1, []]],
    [2, 'Kart 2', '192.168.8.102', [1, []]],
  ] as Json[][],
};

const PROGRESS = {
  schema: {
    elements: [
      el('kart_id', U32),
      el('lap', U32),
      el('next_idx', U32),
      el('last_pass_at', TS),
      el('placement', U32),
      el('finished_at', optOf(TS)),
    ],
  },
  rows: [
    [2, 0, 1, [1789886431045596], 2, [1, []]],
    [1, 0, 1, [1789886431045596], 1, [1, []]],
  ] as Json[][],
};

/** slot_1 / slot_2 — note the underscore the spec table does not have. */
const INVENTORY = {
  schema: {
    elements: [el('kart_id', U32), el('slot_1', optOf(STR)), el('slot_2', optOf(STR))],
  },
  rows: [
    [2, [0, 'shield'], [1, []]],
    [1, [1, []], [1, []]],
  ] as Json[][],
};

const EFFECT = {
  schema: {
    elements: [
      el('id', U64),
      el('kart_id', U32),
      el('kind', STR),
      el('multiplier', F32),
      el('expires_at', optOf(TS)),
      el('source_kart', U32),
    ],
  },
  rows: [[4, 1, 'stun', 0.0, [0, [1789886429500000]], 2]] as Json[][],
};

const EVENT_LOG = {
  schema: { elements: [el('id', U64), el('at', TS), el('text', STR)] },
  rows: [
    [2, [1789886422879383], 'Setup started — drive the calibration lap'],
    [1, [1789886422719050], 'arkart module initialized'],
  ] as Json[][],
};

const TRACK = {
  schema: { elements: [el('seq', U32), el('tag_id', U32)] },
  rows: [
    [1, 3],
    [0, 7],
    [2, 9],
  ] as Json[][],
};

const SETUP_SEEN = {
  schema: { elements: [el('tag_id', U32), el('first_seen_at', TS), el('seen_idx', U32)] },
  rows: [
    [9, [1789886422930333], 2],
    [7, [1789886422896526], 0],
    [3, [1789886422916195], 1],
  ] as Json[][],
};

const INPUT = {
  schema: {
    elements: [el('kart_id', U32), el('throttle', F32), el('steer', F32), el('updated_at', TS)],
  },
  rows: [
    [1, 0.5, 0.2, [1789886430951227]],
    [2, 1.0, -1.0, [1789886427213247]],
  ] as Json[][],
};

// --- tests ------------------------------------------------------------------

describe('resultToObjects — live wire format', () => {
  it('decodes scalars, a plain-string enum and a `none` option', () => {
    expect(resultToObjects(CONFIG)).toEqual([
      { id: 0, lap_count: 3, item_roll_pct: 100, state: 'lobby', countdown_ends_at: null },
    ]);
  });

  it('decodes a Timestamp product into epoch MILLISECONDS', () => {
    const rows = resultToObjects(PROGRESS);
    expect(rows[0].last_pass_at).toBe(1789886431046); // 1789886431045596 µs → ms
    expect(rows[0].finished_at).toBeNull();
  });

  it('decodes `some` options, including a nested timestamp', () => {
    expect(resultToObjects(EFFECT)[0]).toEqual({
      id: 4,
      kart_id: 1,
      kind: 'stun',
      multiplier: 0,
      expires_at: 1789886429500,
      source_kart: 2,
    });
    expect(resultToObjects(INVENTORY)[0].slot_1).toBe('shield');
    expect(resultToObjects(INVENTORY)[0].slot_2).toBeNull();
  });

  it('survives an empty result and a missing result', () => {
    expect(resultToObjects({ schema: { elements: [] }, rows: [] })).toEqual([]);
    expect(resultToObjects(undefined)).toEqual([]);
  });
});

describe('assembleSnapshot — module rows → screen rows', () => {
  const snap = assembleSnapshot({
    config: resultToObjects(CONFIG),
    kart: resultToObjects(KART),
    input: resultToObjects(INPUT),
    track: resultToObjects(TRACK),
    setup_seen: resultToObjects(SETUP_SEEN),
    progress: resultToObjects(PROGRESS),
    inventory: resultToObjects(INVENTORY),
    effect: resultToObjects(EFFECT),
    event_log: resultToObjects(EVENT_LOG),
  });

  it('maps config and karts', () => {
    expect(snap.config).toEqual({
      lap_count: 3,
      item_roll_pct: 100,
      state: 'lobby',
      countdown_ends_at: null,
    });
    expect(snap.karts.map((k) => k.name)).toEqual(['Red Kart', 'Kart 2']);
    expect(snap.karts[0].pilot_identity).toBeNull();
  });

  it('bridges the module\'s slot_1/slot_2 naming to slot1/slot2', () => {
    const inv = snap.inventory.find((i) => i.kart_id === 2)!;
    expect(inv.slot1).toBe('shield');
    expect(inv.slot2).toBeNull();
  });

  it('orders track by seq, setup_seen by first sighting, events oldest-first', () => {
    expect(snap.track.map((t) => t.tag_id)).toEqual([7, 3, 9]);
    expect(snap.setupSeen.map((s) => s.tag_id)).toEqual([7, 3, 9]);
    expect(snap.events.map((e) => e.text)).toEqual([
      'arkart module initialized',
      'Setup started — drive the calibration lap',
    ]);
  });

  it('maps effects and inputs with ms timestamps', () => {
    expect(snap.effects[0]).toMatchObject({ kart_id: 1, kind: 'stun', expires_at: 1789886429500 });
    expect(snap.inputs[0]).toMatchObject({ kart_id: 1, throttle: 0.5, steer: 0.2 });
    expect(snap.inputs[0].updated_at).toBe(1789886430951);
  });

  it('degrades to empty rather than throwing on an empty database', () => {
    const empty = assembleSnapshot({});
    expect(empty.karts).toEqual([]);
    expect(empty.config.state).toBe('setup');
  });
});
