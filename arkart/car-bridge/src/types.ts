/**
 * Row types for the AR Kart car bridge.
 *
 * These mirror the SpacetimeDB `arkart` module tables field-for-field
 * (docs/design/arkart-game-software-v1.md §4) but are declared HERE so that the
 * bridge's game logic stays pure and compiles with zero dependency on the
 * module's generated bindings (which are built in parallel by another leg).
 *
 * Normalisation rules applied by every adapter before handing rows to the logic:
 *  - snake_case module fields become camelCase here,
 *  - SpacetimeDB `Timestamp` (microseconds since epoch) becomes a plain
 *    JS epoch-**milliseconds** number,
 *  - optional/unset columns become `null` (never `undefined`).
 */

/** `config.state` — the race-wide state machine (§4). */
export type RaceState = 'setup' | 'lobby' | 'countdown' | 'running' | 'finished';

export const RACE_STATES: readonly RaceState[] = [
  'setup',
  'lobby',
  'countdown',
  'running',
  'finished',
];

/** `effect.kind` (§4). `slow` is Leader Strike's kind; `ink` is screen-only. */
export type EffectKind = 'boost' | 'stun' | 'ink' | 'dizzy' | 'slow' | 'shield';

export const EFFECT_KINDS: readonly EffectKind[] = [
  'boost',
  'stun',
  'ink',
  'dizzy',
  'slow',
  'shield',
];

/** Table `config` — singleton. */
export interface ConfigRow {
  lapCount: number;
  itemRollPct: number;
  state: RaceState;
  /** epoch ms, or null when no countdown is pending */
  countdownEndsAt: number | null;
}

/** Table `kart` — one row per kart (2 for the demo). */
export interface KartRow {
  kartId: number;
  name: string;
  /** dotted-quad the firmware listens on; may be empty until the kart checks in */
  ip: string;
  pilotIdentity: string | null;
}

/** Table `input` — rewritten ~25 Hz per kart by the pilot app. */
export interface InputRow {
  kartId: number;
  /** 0..1 */
  throttle: number;
  /** -1..1 */
  steer: number;
  /** epoch ms */
  updatedAt: number;
}

/** Table `effect` — one row per live effect. */
export interface EffectRow {
  id: number;
  kartId: number;
  kind: EffectKind;
  /** speed multiplier; only meaningful for `boost` / `slow` */
  multiplier: number;
  /** epoch ms, or null for effects with no timer (shield: consumed on hit) */
  expiresAt: number | null;
}

/**
 * Everything the 50 Hz loop needs for one tick. Adapters produce this; the
 * logic consumes it and nothing else (no clock, no sockets, no SDK).
 */
export interface WorldSnapshot {
  config: ConfigRow | null;
  karts: KartRow[];
  /** keyed by kartId */
  inputs: Map<number, InputRow>;
  effects: EffectRow[];
}

export function emptySnapshot(): WorldSnapshot {
  return { config: null, karts: [], inputs: new Map(), effects: [] };
}

/** The per-kart motion command, already quantised to the wire representation. */
export interface KartCommand {
  kartId: number;
  /** u8, 0..255 */
  throttle: number;
  /** i8, -127..127 */
  steer: number;
  /** u8 bitfield; bit0 = shield LED */
  flags: number;
}

/** Why the throttle ended up where it did — for logging / the director screen. */
export interface CommandTrace {
  cap: number;
  stunned: boolean;
  dizzy: boolean;
  shield: boolean;
  ink: boolean;
  stale: boolean;
  running: boolean;
  /** post-effect normalised throttle, 0..1, before u8 quantisation */
  throttleUnit: number;
  /** post-effect normalised steer, -1..1, before i8 quantisation */
  steerUnit: number;
}

export interface CommandResult {
  command: KartCommand;
  trace: CommandTrace;
}
