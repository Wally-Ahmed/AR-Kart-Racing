/**
 * Coercion from SpacetimeDB's JSON wire shapes into the plain row types in `src/types.ts`.
 *
 * The HTTP `/sql` endpoint and the SDK hand back slightly different encodings depending on
 * version (Option as `{some}`/`{none}`, sum-type variants as `{Boost: []}` or `{tag:'Boost'}`,
 * u64 as a string, Timestamp as micros). Everything funnels through here so the rest of the app
 * only ever sees `number | string | null`.
 */

export type Json = unknown;

const isObj = (v: Json): v is Record<string, Json> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Unwrap the option encodings the SDK can hand back: `{some: X}` / `{none: []}` and the
 * tagged form `{tag:'some', value: X}`. (The HTTP `/sql` array form `[0, X]` / `[1, []]` is
 * decoded upstream in `sql.ts`, where the schema says which index means what.)
 */
export function unwrapOption(v: Json): Json {
  if (v === null || v === undefined) return null;
  if (isObj(v)) {
    const keys = Object.keys(v);
    if (typeof v.tag === 'string' && (keys.length === 1 || 'value' in v)) {
      const tag = v.tag.toLowerCase();
      if (tag === 'none') return null;
      if (tag === 'some') return unwrapOption(v.value ?? null);
    }
    if (keys.length === 1) {
      const k = keys[0];
      if (k === 'some' || k === 'Some') return unwrapOption(v[k]);
      if (k === 'none' || k === 'None') return null;
    }
  }
  return v;
}

/** Any numeric encoding (number, decimal string, bigint) → number. NaN-safe with a fallback. */
export function num(v: Json, fallback = 0): number {
  const u = unwrapOption(v);
  if (u === null) return fallback;
  if (typeof u === 'number') return Number.isFinite(u) ? u : fallback;
  if (typeof u === 'bigint') return Number(u);
  if (typeof u === 'string') {
    const n = Number(u);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

export function numOrNull(v: Json): number | null {
  const u = unwrapOption(v);
  if (u === null || u === '') return null;
  const n = num(u, NaN);
  return Number.isFinite(n) ? n : null;
}

export function str(v: Json, fallback = ''): string {
  const u = unwrapOption(v);
  if (u === null) return fallback;
  if (typeof u === 'string') return u;
  if (typeof u === 'number' || typeof u === 'bigint') return String(u);
  return fallback;
}

export function strOrNull(v: Json): string | null {
  const u = unwrapOption(v);
  return u === null ? null : str(u, '');
}

/**
 * A sum-type variant name, normalised to snake_case:
 *   'Boost' | {Boost: []} | {tag: 'LeaderStrike'} | {LeaderStrike: []}  →  'boost' | 'leader_strike'
 */
export function variant(v: Json): string | null {
  const u = unwrapOption(v);
  if (u === null) return null;
  if (typeof u === 'string') return snake(u);
  if (isObj(u)) {
    if (typeof u.tag === 'string') return snake(u.tag);
    const keys = Object.keys(u);
    if (keys.length >= 1) return snake(keys[0]);
  }
  return null;
}

export function snake(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
}

export function camel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Any timestamp encoding → epoch **milliseconds**.
 * SpacetimeDB `Timestamp` is micros since the epoch; it may arrive as a bare number/string,
 * as `{__timestamp_micros_since_unix_epoch__: "..."}`, or as `{microsSinceUnixEpoch: ...}`.
 * Values that are clearly already-in-ms (< 1e12 ≈ year 2001 in micros) are passed through.
 */
export function ts(v: Json, fallback = 0): number {
  const u = unwrapOption(v);
  if (u === null) return fallback;
  if (isObj(u)) {
    const inner =
      u['__timestamp_micros_since_unix_epoch__'] ??
      u['microsSinceUnixEpoch'] ??
      u['micros_since_unix_epoch'] ??
      u['__time_duration_micros__'];
    if (inner !== undefined) return ts(inner, fallback);
  }
  const n = num(u, NaN);
  if (!Number.isFinite(n)) return fallback;
  // micros since epoch are ~1.7e15 today; ms are ~1.7e12. Anything above 1e14 is micros.
  return n > 1e14 ? Math.round(n / 1000) : n;
}

export function tsOrNull(v: Json): number | null {
  const u = unwrapOption(v);
  if (u === null) return null;
  const t = ts(u, NaN);
  return Number.isFinite(t) && t !== 0 ? t : null;
}

/**
 * Case/shape-insensitive field read.
 * `pick(row, 'slot1')` finds `slot1`, `slot_1` or `slot1` — the live module names the inventory
 * columns `slot_1`/`slot_2` while the spec table writes them `slot1`/`slot2`, and neither
 * snake_case nor camelCase bridges that, so the last resort strips separators entirely.
 */
export function pick(row: Record<string, Json>, field: string): Json {
  if (field in row) return row[field];
  const c = camel(field);
  if (c in row) return row[c];
  const s = snake(field);
  if (s in row) return row[s];
  const bySnake = Object.keys(row).find((k) => snake(k) === s);
  if (bySnake) return row[bySnake];
  const flat = field.replace(/_/g, '').toLowerCase();
  const byFlat = Object.keys(row).find((k) => k.replace(/_/g, '').toLowerCase() === flat);
  return byFlat ? row[byFlat] : undefined;
}
