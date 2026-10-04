/**
 * Row mappers: raw JSON object → the typed rows in `src/types.ts`.
 * Shared by the HTTP adapter and the SDK adapter so both produce identical snapshots.
 */

import {
  EMPTY_CONFIG,
  type ConfigRow,
  type EffectKind,
  type EffectRow,
  type EventLogRow,
  type InputRow,
  type InventoryRow,
  type ItemKind,
  type KartRow,
  type ProgressRow,
  type RaceState,
  type SetupSeenRow,
  type TrackRow,
} from '../types.ts';
import { num, numOrNull, pick, str, strOrNull, ts, tsOrNull, variant, type Json } from './coerce.ts';

type Raw = Record<string, Json>;

const RACE_STATE_SET = new Set<string>(['setup', 'lobby', 'countdown', 'running', 'finished']);
const ITEM_SET = new Set<string>(['boost', 'stun', 'ink', 'dizzy', 'leader_strike', 'shield']);
const EFFECT_SET = new Set<string>(['boost', 'stun', 'ink', 'dizzy', 'slow', 'shield']);

/** Tolerates the module naming Stun `stun_shot`, Ink `ink_splat`, etc. */
const ITEM_ALIASES: Record<string, ItemKind> = {
  stun_shot: 'stun',
  ink_splat: 'ink',
  dizzy_ray: 'dizzy',
  leaderstrike: 'leader_strike',
  leader: 'leader_strike',
  strike: 'leader_strike',
};

export function toRaceState(v: Json): RaceState {
  const name = variant(v);
  return name && RACE_STATE_SET.has(name) ? (name as RaceState) : 'setup';
}

export function toItem(v: Json): ItemKind | null {
  const name = variant(v);
  if (!name) return null;
  if (ITEM_SET.has(name)) return name as ItemKind;
  return ITEM_ALIASES[name] ?? null;
}

export function toEffectKind(v: Json): EffectKind {
  const name = variant(v);
  if (name && EFFECT_SET.has(name)) return name as EffectKind;
  const alias = name ? ITEM_ALIASES[name] : null;
  if (alias === 'leader_strike') return 'slow';
  if (alias && EFFECT_SET.has(alias)) return alias as EffectKind;
  return 'slow';
}

export function toConfig(raw: Raw | undefined): ConfigRow {
  if (!raw) return { ...EMPTY_CONFIG };
  return {
    lap_count: num(pick(raw, 'lap_count'), 3),
    item_roll_pct: num(pick(raw, 'item_roll_pct'), 100),
    state: toRaceState(pick(raw, 'state')),
    countdown_ends_at: tsOrNull(pick(raw, 'countdown_ends_at')),
  };
}

export const toKart = (raw: Raw): KartRow => ({
  kart_id: num(pick(raw, 'kart_id')),
  name: str(pick(raw, 'name'), `KART ${num(pick(raw, 'kart_id'))}`),
  ip: str(pick(raw, 'ip')),
  pilot_identity: strOrNull(pick(raw, 'pilot_identity')),
});

export const toInput = (raw: Raw): InputRow => ({
  kart_id: num(pick(raw, 'kart_id')),
  throttle: num(pick(raw, 'throttle')),
  steer: num(pick(raw, 'steer')),
  updated_at: ts(pick(raw, 'updated_at')),
});

export const toTrack = (raw: Raw): TrackRow => ({
  seq: num(pick(raw, 'seq')),
  tag_id: num(pick(raw, 'tag_id')),
});

export const toSetupSeen = (raw: Raw): SetupSeenRow => ({
  tag_id: num(pick(raw, 'tag_id')),
  first_seen_at: ts(pick(raw, 'first_seen_at')),
});

export const toProgress = (raw: Raw): ProgressRow => ({
  kart_id: num(pick(raw, 'kart_id')),
  lap: num(pick(raw, 'lap')),
  next_idx: num(pick(raw, 'next_idx')),
  last_pass_at: ts(pick(raw, 'last_pass_at')),
  placement: num(pick(raw, 'placement')),
  finished_at: tsOrNull(pick(raw, 'finished_at')),
});

export const toInventory = (raw: Raw): InventoryRow => ({
  kart_id: num(pick(raw, 'kart_id')),
  slot1: toItem(pick(raw, 'slot1')),
  slot2: toItem(pick(raw, 'slot2')),
});

export const toEffect = (raw: Raw): EffectRow => ({
  id: num(pick(raw, 'id')),
  kart_id: num(pick(raw, 'kart_id')),
  kind: toEffectKind(pick(raw, 'kind')),
  multiplier: numOrNull(pick(raw, 'multiplier')) ?? 1,
  expires_at: tsOrNull(pick(raw, 'expires_at')),
});

export const toEvent = (raw: Raw): EventLogRow => ({
  at: ts(pick(raw, 'at')),
  text: str(pick(raw, 'text')),
});

/** The module tables the director subscribes to, in snake_case (spec §4). */
export const TABLES = [
  'config',
  'kart',
  'input',
  'track',
  'setup_seen',
  'progress',
  'inventory',
  'effect',
  'event_log',
] as const;

export type TableName = (typeof TABLES)[number];

/** Assemble a snapshot from per-table raw row arrays, applying the spec's sort orders. */
export function assembleSnapshot(tables: Partial<Record<TableName, Raw[]>>) {
  const track = (tables.track ?? []).map(toTrack).sort((a, b) => a.seq - b.seq);

  // The live module also stamps `seen_idx` on setup_seen and an autoinc `id` on event_log;
  // both are better ordering keys than the timestamp (same-millisecond rows keep their order).
  const setupSeen = [...(tables.setup_seen ?? [])]
    .sort((a, b) => num(pick(a, 'seen_idx'), 0) - num(pick(b, 'seen_idx'), 0))
    .map(toSetupSeen)
    .sort((a, b) => a.first_seen_at - b.first_seen_at);
  const events = [...(tables.event_log ?? [])]
    .sort((a, b) => {
      const at = ts(pick(a, 'at')) - ts(pick(b, 'at'));
      return at !== 0 ? at : num(pick(a, 'id'), 0) - num(pick(b, 'id'), 0);
    })
    .map(toEvent);
  return {
    config: toConfig((tables.config ?? [])[0]),
    karts: (tables.kart ?? []).map(toKart).sort((a, b) => a.kart_id - b.kart_id),
    inputs: (tables.input ?? []).map(toInput),
    track,
    setupSeen,
    progress: (tables.progress ?? []).map(toProgress),
    inventory: (tables.inventory ?? []).map(toInventory),
    effects: (tables.effect ?? []).map(toEffect),
    events,
  };
}
