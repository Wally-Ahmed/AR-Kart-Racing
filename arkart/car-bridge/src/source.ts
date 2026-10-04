/**
 * The seam between the bridge and SpacetimeDB.
 *
 * ISOLATION CONTRACT: the 50 Hz loop and the rule engine only ever see a
 * {@link WorldSnapshot} built from OUR row types (src/types.ts). Everything
 * SpacetimeDB-shaped — generated bindings, subscriptions, BSATN, Timestamps —
 * lives behind an implementation of this interface, so the module leg can land
 * its bindings later without touching a line of game logic.
 */

import type { WorldSnapshot } from './types.ts';

export interface WorldSource {
  readonly kind: string;
  /** Connect / start polling. Resolves once an initial snapshot is available. */
  start(): Promise<void>;
  /** Latest known world state. Must be cheap: it is called 50x/second. */
  snapshot(): WorldSnapshot;
  /** True once the underlying transport is live. */
  isConnected(): boolean;
  stop(): Promise<void>;
}

/** Microseconds (SpacetimeDB `Timestamp`) -> epoch milliseconds. */
export function microsToMillis(micros: number | bigint | null | undefined): number {
  if (micros === null || micros === undefined) return 0;
  return typeof micros === 'bigint' ? Number(micros / 1000n) : Math.floor(micros / 1000);
}

/**
 * Coerce whatever a SpacetimeDB row/SDK hands us for a timestamp into epoch ms.
 * Handles: SDK `Timestamp` objects (`microsSinceUnixEpoch`), bigints, numbers in
 * micros or millis, ISO strings, and `null`.
 */
export function toEpochMillis(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'bigint') return microsToMillis(value);
  if (typeof value === 'number') {
    // Heuristic: anything past ~1e14 is microseconds, not milliseconds.
    return value > 1e14 ? Math.floor(value / 1000) : value;
  }
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return toEpochMillis(n);
    const d = Date.parse(value);
    return Number.isNaN(d) ? 0 : d;
  }
  // The HTTP /sql endpoint serialises a Timestamp (a SATS Product with one
  // `__timestamp_micros_since_unix_epoch__` field) POSITIONALLY, as a
  // one-element array: [1789894296001911]. Without this branch every
  // `updated_at` decodes to 0, every input reads stale, and the SQL fallback
  // silently commands throttle 0 forever.
  if (Array.isArray(value)) {
    return value.length === 1 ? toEpochMillis(value[0]) : 0;
  }
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if ('microsSinceUnixEpoch' in o) return toEpochMillis(o.microsSinceUnixEpoch);
    if ('micros_since_unix_epoch' in o) return toEpochMillis(o.micros_since_unix_epoch);
    if ('__timestamp_micros_since_unix_epoch__' in o) {
      return toEpochMillis(o.__timestamp_micros_since_unix_epoch__);
    }
  }
  return 0;
}

/**
 * SpacetimeDB sum types (enums) arrive either as a plain string or as a tagged
 * object `{ tag: "Boost" }`. Normalise to our lowercase string unions.
 */
export function tagToString(value: unknown): string {
  if (typeof value === 'string') return value.toLowerCase();
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.tag === 'string') return o.tag.toLowerCase();
  }
  return String(value).toLowerCase();
}
