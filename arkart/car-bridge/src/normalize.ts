/**
 * Raw row -> our row types. Pure and tolerant on purpose: the module leg's
 * generated bindings hand us camelCase objects, the HTTP `/sql` endpoint hands
 * us snake_case JSON, and neither shape is nailed down until integration.
 * Every field is looked up under both spellings.
 */

import { toEpochMillis, tagToString } from './source.ts';
import {
  EFFECT_KINDS,
  RACE_STATES,
  type ConfigRow,
  type EffectKind,
  type EffectRow,
  type InputRow,
  type KartRow,
  type RaceState,
} from './types.ts';

type Raw = Record<string, unknown>;

function pick(row: Raw, ...names: string[]): unknown {
  for (const n of names) {
    if (n in row && row[n] !== undefined) return row[n];
  }
  return undefined;
}

function num(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

function str(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return fallback;
  return String(value);
}

/** Sum-variant index of `some` / `none` in SpacetimeDB's `Option<T>` layout. */
const OPTION_SOME = 0;
const OPTION_NONE = 1;

/**
 * SpacetimeDB `Option<T>` arrives in three shapes:
 *  - null / undefined                       (plain JSON null)
 *  - `{ tag: 'none' | 'some', value }`       (generated bindings / tagged JSON)
 *  - `[tagIndex, payload]`                   (HTTP /sql, POSITIONAL sum encoding)
 *
 * The positional form is what the live `/sql` endpoint actually returns:
 * `[1, []]` for none and `[0, [micros]]` for some. Missing it made every
 * `expires_at` decode to null — i.e. every timed boost/slow/stun/dizzy would
 * never expire.
 */
function unwrapOption(value: unknown): unknown {
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'number') {
    if (value[0] === OPTION_NONE) return null;
    if (value[0] === OPTION_SOME) return value[1] ?? null;
  }
  if (value && typeof value === 'object' && 'tag' in (value as Raw)) {
    const o = value as Raw;
    const tag = String(o.tag).toLowerCase();
    if (tag === 'none') return null;
    if (tag === 'some') return 'value' in o ? o.value : null;
  }
  return value ?? null;
}

export function normalizeRaceState(value: unknown): RaceState {
  const s = tagToString(value);
  return (RACE_STATES.find((x) => x === s) ?? 'lobby') as RaceState;
}

export function normalizeEffectKind(value: unknown): EffectKind | null {
  const s = tagToString(value);
  return (EFFECT_KINDS.find((x) => x === s) ?? null) as EffectKind | null;
}

export function normalizeConfig(raw: Raw): ConfigRow {
  const countdown = unwrapOption(pick(raw, 'countdownEndsAt', 'countdown_ends_at'));
  return {
    lapCount: num(pick(raw, 'lapCount', 'lap_count'), 3),
    itemRollPct: num(pick(raw, 'itemRollPct', 'item_roll_pct'), 100),
    state: normalizeRaceState(pick(raw, 'state')),
    countdownEndsAt: countdown === null ? null : toEpochMillis(countdown) || null,
  };
}

export function normalizeKart(raw: Raw): KartRow {
  const pilot = unwrapOption(pick(raw, 'pilotIdentity', 'pilot_identity'));
  return {
    kartId: num(pick(raw, 'kartId', 'kart_id')),
    name: str(pick(raw, 'name')),
    ip: str(pick(raw, 'ip')),
    pilotIdentity: pilot === null ? null : str(pilot),
  };
}

export function normalizeInput(raw: Raw): InputRow {
  return {
    kartId: num(pick(raw, 'kartId', 'kart_id')),
    throttle: num(pick(raw, 'throttle')),
    steer: num(pick(raw, 'steer')),
    updatedAt: toEpochMillis(pick(raw, 'updatedAt', 'updated_at')),
  };
}

/**
 * Returns `null` for rows whose `kind` we do not recognise — an unknown effect
 * must never accidentally read as `stun` or silently scale the throttle.
 */
export function normalizeEffect(raw: Raw): EffectRow | null {
  const kind = normalizeEffectKind(pick(raw, 'kind'));
  if (kind === null) return null;
  const expires = unwrapOption(pick(raw, 'expiresAt', 'expires_at'));
  const expiresMs = expires === null ? null : toEpochMillis(expires) || null;
  return {
    id: num(pick(raw, 'id')),
    kartId: num(pick(raw, 'kartId', 'kart_id')),
    kind,
    multiplier: num(pick(raw, 'multiplier'), 1),
    expiresAt: expiresMs,
  };
}

export function normalizeEffects(rows: readonly Raw[]): EffectRow[] {
  const out: EffectRow[] = [];
  for (const r of rows) {
    const e = normalizeEffect(r);
    if (e !== null) out.push(e);
  }
  return out;
}
