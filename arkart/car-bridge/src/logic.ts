/**
 * The enforcer's pure core (docs/design/arkart-game-software-v1.md §5).
 *
 *   cap   = product of every active boost/slow multiplier for the kart, floor 0.2
 *   thr   = stunned ? 0 : input.throttle * cap      // and 0 unless state == running
 *   str   = dizzy   ? -input.steer : input.steer    // Dizzy Ray = physical control swap
 *   flags = shield_active ? 0x01 : 0x00             // bit0 drives the shield LED
 *
 * No clock, no sockets, no SpacetimeDB: `now` is passed in. Everything in this
 * file is deterministic and unit-testable.
 */

import {
  FLAG_SHIELD,
  MAX_THROTTLE,
  STEER_FULL_SCALE,
} from './packet.ts';
import type {
  CommandResult,
  EffectRow,
  InputRow,
  RaceState,
  WorldSnapshot,
} from './types.ts';

/** Speed cap can never fall below this, however many slows stack (§5). */
export const CAP_FLOOR = 0.2;

/** Input older than this is treated as dead (phone backgrounded / app crashed). */
export const INPUT_STALE_MS = 500;

/** Neutral input used when a kart has no `input` row at all. */
export const NEUTRAL_INPUT: Readonly<InputRow> = Object.freeze({
  kartId: 0,
  throttle: 0,
  steer: 0,
  updatedAt: 0,
});

export interface LogicOptions {
  /** override for tests; defaults to {@link INPUT_STALE_MS} */
  staleMs?: number;
}

/**
 * Clamp, with NaN/Infinity failing to the range's NEUTRAL value rather than to
 * its low bound — a garbage `steer` must centre the coil, not slam it to full
 * left lock. For `[0,1]` throttle the neutral value is the low bound anyway.
 */
function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo <= 0 && hi >= 0 ? 0 : lo;
  return v < lo ? lo : v > hi ? hi : v;
}

/** `true` only while the race is actually running — everything else parks the karts. */
export function isRunning(state: RaceState | null | undefined): boolean {
  return state === 'running';
}

/** An effect with no `expiresAt` never times out (shield: consumed on hit). */
export function isEffectActive(e: EffectRow, nowMs: number): boolean {
  return e.expiresAt === null || e.expiresAt > nowMs;
}

/** Active effects belonging to one kart. */
export function activeEffectsFor(
  effects: readonly EffectRow[],
  kartId: number,
  nowMs: number,
): EffectRow[] {
  return effects.filter((e) => e.kartId === kartId && isEffectActive(e, nowMs));
}

/**
 * Speed cap = product of every active boost/slow multiplier, floored at 0.2.
 * `ink` and `shield` never touch motion; `stun` is handled separately (it zeroes
 * throttle outright rather than scaling it); `dizzy` only flips steering.
 */
export function speedCap(activeEffects: readonly EffectRow[]): number {
  let cap = 1;
  for (const e of activeEffects) {
    if (e.kind !== 'boost' && e.kind !== 'slow') continue;
    const m = e.multiplier;
    if (!Number.isFinite(m) || m < 0) continue; // defensive: ignore garbage rows
    cap *= m;
  }
  return Math.max(CAP_FLOOR, cap);
}

/** Quantise a 0..1 throttle to the wire's u8. */
export function throttleToByte(unit: number): number {
  return Math.round(clamp(unit, 0, 1) * MAX_THROTTLE);
}

/**
 * Quantise a -1..1 steer to the wire's i8 (-127..127).
 *
 * Rounded on the magnitude so left and right are mirror images: JS `Math.round`
 * breaks .5 ties toward +Infinity, which would otherwise make a dizzy-inverted
 * stick quantise to a different deflection than the stick itself.
 */
export function steerToByte(unit: number): number {
  const c = clamp(unit, -1, 1);
  const mag = Math.round(Math.abs(c) * STEER_FULL_SCALE);
  if (mag === 0) return 0; // never emit -0
  return c < 0 ? -mag : mag;
}

/**
 * Resolve one kart's command for this tick. This is THE rule engine — the UDP
 * sender and the SpacetimeDB adapters are dumb plumbing around it.
 */
export function computeCommand(
  kartId: number,
  snap: WorldSnapshot,
  nowMs: number,
  opts: LogicOptions = {},
): CommandResult {
  const staleMs = opts.staleMs ?? INPUT_STALE_MS;

  const input = snap.inputs.get(kartId) ?? { ...NEUTRAL_INPUT, kartId };
  const active = activeEffectsFor(snap.effects, kartId, nowMs);

  const stunned = active.some((e) => e.kind === 'stun');
  const dizzy = active.some((e) => e.kind === 'dizzy');
  const shield = active.some((e) => e.kind === 'shield');
  const ink = active.some((e) => e.kind === 'ink');
  const cap = speedCap(active);

  const running = isRunning(snap.config?.state ?? null);
  // A kart with no input row at all (updatedAt 0) is stale by definition.
  const stale = nowMs - input.updatedAt > staleMs;

  // --- throttle -----------------------------------------------------------
  // Kill switch order matters: state gate and staleness both hard-zero, and
  // stun hard-zeroes regardless of how big a boost is stacked on top.
  let throttleUnit: number;
  if (!running || stale || stunned) {
    throttleUnit = 0;
  } else {
    throttleUnit = clamp(input.throttle, 0, 1) * cap;
  }

  // --- steer --------------------------------------------------------------
  // Dizzy Ray is a *physical* control swap, so it applies whenever the pilot
  // still has steering authority. A dead/stale link centres the coil instead of
  // leaving it energised at the last commanded deflection (safety).
  let steerUnit: number;
  if (!running || stale) {
    steerUnit = 0;
  } else {
    const s = clamp(input.steer, -1, 1);
    steerUnit = dizzy ? -s : s;
  }

  // --- flags --------------------------------------------------------------
  // bit0 is the shield LED and is *not* gated on race state: a shielded kart
  // sitting in the lobby should still show cyan.
  const flags = shield ? FLAG_SHIELD : 0x00;

  return {
    command: {
      kartId,
      throttle: throttleToByte(throttleUnit),
      steer: steerToByte(steerUnit),
      flags,
    },
    trace: {
      cap,
      stunned,
      dizzy,
      shield,
      ink,
      stale,
      running,
      throttleUnit,
      steerUnit,
    },
  };
}
