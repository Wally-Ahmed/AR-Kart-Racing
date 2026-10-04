/**
 * Touch mapping for the phone pilot page — PURE (no DOM, no clock, no network).
 *
 * The phone is the real cockpit (spec §8 D3 was a native iOS app; this is the web pilot that
 * replaces it, same wire contract: `set_input` through SpacetimeDB at 25 Hz, spec §1 D1). The
 * geometry below is the only genuinely new logic in the pilot, so it lives here and is unit-tested
 * instead of eyeballed with a car on the bench — same split as `drive.ts` and `placement.ts`.
 *
 * Layout, phone held in landscape:
 *
 *     ┌───────────────────────────┬───────────────────────────┐
 *     │  STEER PAD                │  THROTTLE PAD             │
 *     │  absolute horizontal      │  relative drag UP from    │
 *     │  position → -1 .. +1      │  wherever the thumb landed│
 *     │  (snaps to 0 on release)  ├───────────────────────────┤
 *     │                           │  BRAKE  (outranks thr.)   │
 *     └───────────────────────────┴───────────────────────────┘
 *
 * Two deliberate asymmetries:
 *
 *   - **Steer is ABSOLUTE, throttle is RELATIVE.** A thumb on a steering pad wants a fixed centre
 *     it can find without looking, so steer reads the x position straight off the pad. Throttle
 *     must never jump: an absolute vertical pad would launch the car the instant a thumb landed
 *     half way up it, so throttle starts at 0 wherever the thumb touches down and grows as the
 *     thumb is dragged up.
 *   - **The throttle anchor sinks but never rises.** Dragging below the touch-down point re-anchors
 *     at the thumb (`throttleDrag` returns a new `anchorY`), so a pilot who over-shoots downward
 *     does not have to drag that same distance back up before the car responds. Dragging up never
 *     moves the anchor, so the 0→1 travel stays honest.
 */

import { clampSteer, clampThrottle, type DriveVector } from '../drive.ts';

/** The slice of `DOMRect` the mapping needs — structural, so tests need no DOM. */
export interface PadRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A resting thumb is never perfectly centred; inside this the pad reads as straight. */
export const STEER_DEADZONE = 0.08;

/**
 * Fraction of the pad's half-width that reaches full lock. 0.9 leaves a sliver of over-travel at
 * each edge so a thumb that slides off the side of the phone still means "full lock", not "87%".
 */
export const STEER_TRAVEL = 0.9;

/** Fraction of the pad's height the thumb drags up for throttle 0 → 1. */
export const THROTTLE_TRAVEL = 0.55;

/**
 * Pad-relative x → steer, -1 (left) .. +1 (right).
 *
 * Past the deadzone the output is rescaled so it starts from 0 rather than jumping to ±0.08 —
 * the car's steering is a two-position coil, but the module/bridge contract is proportional and a
 * discontinuity here would show up as a twitch in the telemetry.
 */
export function steerFromPointer(x: number, rect: PadRect): number {
  const half = (rect.width / 2) * STEER_TRAVEL;
  if (!(half > 0) || !Number.isFinite(x)) return 0;
  const raw = (x - (rect.left + rect.width / 2)) / half;
  const mag = Math.abs(raw);
  if (mag <= STEER_DEADZONE) return 0;
  const scaled = (mag - STEER_DEADZONE) / (1 - STEER_DEADZONE);
  return clampSteer(raw < 0 ? -scaled : scaled);
}

export interface ThrottleDrag {
  /** The anchor to carry into the next move — may have sunk to the current y. */
  anchorY: number;
  /** 0..1 */
  throttle: number;
}

/**
 * Vertical drag → throttle, anchored at `anchorY` (the y the thumb touched down at).
 *
 * Up is negative in client coordinates, hence `anchorY - y`.
 */
export function throttleDrag(anchorY: number, y: number, rect: PadRect): ThrottleDrag {
  const travel = rect.height * THROTTLE_TRAVEL;
  if (!(travel > 0) || !Number.isFinite(y) || !Number.isFinite(anchorY)) {
    return { anchorY: Number.isFinite(y) ? y : 0, throttle: 0 };
  }
  const raw = (anchorY - y) / travel;
  if (raw <= 0) return { anchorY: y, throttle: 0 }; // anchor sinks with the thumb
  return { anchorY, throttle: clampThrottle(raw) };
}

/** Everything the three touch targets own between them. */
export interface TouchState {
  /** null = no thumb on the steer pad (straight). */
  steer: number | null;
  /** 0..1 from the throttle pad. */
  throttle: number;
  /** A thumb is on the BRAKE zone. */
  brake: boolean;
}

export const NEUTRAL_TOUCH: TouchState = { steer: null, throttle: 0, brake: false };

/**
 * Touch state → drive vector.
 *
 * **Brake outranks throttle**, exactly as `driveFromKeys` makes `S`/`ArrowDown` beat `W`/`ArrowUp`
 * (spec: the Plan-M drive stage is a low-side NPN with no H-bridge, so "brake" is force-0, not
 * reverse). A panicking thumb always wins, even mid-throttle-drag.
 */
export function vectorFromTouch(t: TouchState): DriveVector {
  return {
    throttle: t.brake ? 0 : clampThrottle(t.throttle),
    steer: clampSteer(t.steer ?? 0),
  };
}

/**
 * `?kart=N` → N, or null when absent/garbage.
 *
 * Deliberately strict: a typo'd `?kart=one` must land on the picker, never silently on kart 1 —
 * one phone claiming the wrong car is the one failure mode that makes a race unraceable.
 */
export function parseKartParam(search: string): number | null {
  const raw = new URLSearchParams(search).get('kart');
  if (raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * The kart's MJPEG endpoint.
 *
 * Firmware contract (`firmware/main/camera_stream.c`): `httpd` on **port 80**, handler `/stream`,
 * `multipart/x-mixed-replace; boundary=arkartframe`, `Access-Control-Allow-Origin: *`. A plain
 * `<img src>` renders it, so there is no decoding code on this page at all.
 *
 * `REAL_CAR_IP`-style placeholders (anything that is not an address) return null so the page shows
 * the no-video placeholder instead of hammering a hostname that cannot resolve.
 */
export function streamUrl(ip: string | null | undefined, cacheBust = 0): string | null {
  const host = (ip ?? '').trim();
  if (host === '' || !/^[a-zA-Z0-9.:[\]-]+$/.test(host) || !/[.:]/.test(host)) return null;
  const base = `http://${host}/stream`;
  return cacheBust > 0 ? `${base}?r=${cacheBust}` : base;
}
