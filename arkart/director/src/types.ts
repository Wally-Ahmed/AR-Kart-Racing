/**
 * Row types for the AR Kart director screen.
 *
 * These mirror the SpacetimeDB module tables in `docs/design/arkart-game-software-v1.md` §4
 * field-for-field. They are OUR OWN declarations on purpose: the module (and therefore the
 * generated TS bindings) is built in parallel, so nothing here may import generated code.
 * The adapter layer (`src/adapters/`) is the only place allowed to touch the SDK, and it
 * normalises whatever the module produces into exactly these shapes.
 *
 * Normalisation contract for the adapters:
 *   - every timestamp field is **epoch milliseconds as a JS number**
 *     (SpacetimeDB `Timestamp` is micros since the epoch → divide by 1000).
 *   - every optional field is `null` when absent (never `undefined`, never `{none:[]}`).
 *   - every numeric id is a plain `number`.
 */

/** `config.state` — the race-wide state machine (spec §1 race flow). */
export type RaceState = 'setup' | 'lobby' | 'countdown' | 'running' | 'finished';

export const RACE_STATES: readonly RaceState[] = [
  'setup',
  'lobby',
  'countdown',
  'running',
  'finished',
];

/** Items in the 2-slot inventory (spec §1 Items / D2). */
export type ItemKind = 'boost' | 'stun' | 'ink' | 'dizzy' | 'leader_strike' | 'shield';

/** `effect.kind` (spec §4). `slow` is Leader Strike's effect kind. */
export type EffectKind = 'boost' | 'stun' | 'ink' | 'dizzy' | 'slow' | 'shield';

/** config — singleton row. */
export interface ConfigRow {
  lap_count: number;
  item_roll_pct: number;
  state: RaceState;
  /** epoch ms; null unless state === 'countdown'. */
  countdown_ends_at: number | null;
}

/** kart — 2 rows for the demo. */
export interface KartRow {
  kart_id: number;
  name: string;
  ip: string;
  pilot_identity: string | null;
}

/** input — rewritten ~25 Hz per kart by the pilot app. */
export interface InputRow {
  kart_id: number;
  /** 0..1 */
  throttle: number;
  /** -1..1 */
  steer: number;
  /** epoch ms */
  updated_at: number;
}

/** track — the confirmed ordered checkpoint list. seq 0 = start/finish. */
export interface TrackRow {
  seq: number;
  tag_id: number;
}

/** setup_seen — scratch table, appended during the calibration lap. */
export interface SetupSeenRow {
  tag_id: number;
  /** epoch ms */
  first_seen_at: number;
}

/** progress — one row per kart, recomputed on every checkpoint pass. */
export interface ProgressRow {
  kart_id: number;
  lap: number;
  /** index into `track` of the checkpoint this kart must pass next. */
  next_idx: number;
  /** epoch ms of the last checkpoint pass. */
  last_pass_at: number;
  /** 1-based, as computed by the module. The screen recomputes it locally too. */
  placement: number;
  /** epoch ms, or null while still racing. */
  finished_at: number | null;
}

/** inventory — max 2 slots by construction. */
export interface InventoryRow {
  kart_id: number;
  slot1: ItemKind | null;
  slot2: ItemKind | null;
}

/** effect — active effects. `shield` has no expiry (consumed on hit). */
export interface EffectRow {
  id: number;
  kart_id: number;
  kind: EffectKind;
  multiplier: number;
  /** epoch ms, or null for effects that expire on use (shield). */
  expires_at: number | null;
}

/** event_log — the ticker feed. */
export interface EventLogRow {
  /** epoch ms */
  at: number;
  text: string;
}

/** Everything the screen renders, as one immutable snapshot. */
export interface RaceSnapshot {
  config: ConfigRow;
  karts: KartRow[];
  inputs: InputRow[];
  track: TrackRow[];
  setupSeen: SetupSeenRow[];
  progress: ProgressRow[];
  inventory: InventoryRow[];
  effects: EffectRow[];
  events: EventLogRow[];
}

export type ConnectionStatus = 'connecting' | 'live' | 'error' | 'offline';

export interface ConnectionInfo {
  status: ConnectionStatus;
  /** Adapter name shown in the header: "mock" | "http" | "sdk". */
  source: string;
  /** Human-readable detail (endpoint, last error). */
  detail: string;
  /** epoch ms of the last successful data update, or null. */
  lastUpdateAt: number | null;
  /** True for a pushing transport (subscriptions), where silence is normal — see DirectorAdapter. */
  pushes: boolean;
}

export const EMPTY_CONFIG: ConfigRow = {
  lap_count: 3,
  item_roll_pct: 100,
  state: 'setup',
  countdown_ends_at: null,
};

export const EMPTY_SNAPSHOT: RaceSnapshot = {
  config: EMPTY_CONFIG,
  karts: [],
  inputs: [],
  track: [],
  setupSeen: [],
  progress: [],
  inventory: [],
  effects: [],
  events: [],
};

/** Display metadata for items/effects — kept next to the types so the UI stays dumb. */
export const ITEM_META: Record<ItemKind, { label: string; glyph: string; color: string }> = {
  boost: { label: 'Boost', glyph: '≫', color: '#ffd23f' },
  stun: { label: 'Stun Shot', glyph: '⚡', color: '#ff5c5c' },
  ink: { label: 'Ink Splat', glyph: '◍', color: '#b47cff' },
  dizzy: { label: 'Dizzy Ray', glyph: '⟲', color: '#ff8a3d' },
  leader_strike: { label: 'Leader Strike', glyph: '✦', color: '#ff4ecd' },
  shield: { label: 'Shield', glyph: '⛉', color: '#3ddbd9' },
};

export const EFFECT_META: Record<EffectKind, { label: string; glyph: string; color: string }> = {
  boost: { label: 'BOOST', glyph: '≫', color: '#ffd23f' },
  stun: { label: 'STUNNED', glyph: '⚡', color: '#ff5c5c' },
  ink: { label: 'INKED', glyph: '◍', color: '#b47cff' },
  dizzy: { label: 'DIZZY', glyph: '⟲', color: '#ff8a3d' },
  slow: { label: 'STRUCK', glyph: '✦', color: '#ff4ecd' },
  shield: { label: 'SHIELD', glyph: '⛉', color: '#3ddbd9' },
};
