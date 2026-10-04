/**
 * Drive control — the director screen as a pilot station.
 *
 * The iOS app (spec §8) is the real cockpit, but the director laptop has to be able to drive a
 * kart on its own: for bench-testing the car bridge before any phone is provisioned, and as the
 * demo fallback when the 7-day free-provisioning certificate has expired. It uses the SAME path
 * as the phone — `set_input` through SpacetimeDB (spec §1 D1) — so nothing about the control
 * chain is special-cased for the keyboard.
 *
 * Everything above `DriveLoop` is PURE (no DOM, no clock, no network) so the key/pad mapping is
 * unit-tested rather than eyeballed with a car on the bench — same split as `placement.ts`.
 *
 * Two deliberate matches to the phone:
 *   - **25 Hz, every tick, even when nothing changed.** The frame doubles as the keep-alive; the
 *     car bridge zeroes throttle when `input.updated_at` goes stale (300 ms, spec §1 D1).
 *   - **No reverse.** Throttle is 0..1 because the Plan-M drive stage is a low-side NPN with no
 *     H-bridge on the rear motor. `ArrowDown`/`S` is therefore a positive BRAKE (force 0), not
 *     reverse, and it outranks the throttle key so a panicking thumb always wins.
 */

export interface DriveVector {
  /** 0..1 — no reverse, by hardware. */
  throttle: number;
  /** -1..1, left negative. */
  steer: number;
}

export const NEUTRAL: DriveVector = { throttle: 0, steer: 0 };

/** Default send rate, matching the phone's `PilotEngine` (spec §8). */
export const DRIVE_HZ = 25;

/** Stick slop on a cheap pad is ±0.08 or so; below this it is not an input. */
export const STICK_DEADZONE = 0.12;

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export const clampThrottle = (n: number): number =>
  Number.isFinite(n) ? round3(Math.min(1, Math.max(0, n))) : 0;

export const clampSteer = (n: number): number =>
  Number.isFinite(n) ? round3(Math.min(1, Math.max(-1, n))) : 0;

export type DriveRole = 'throttle' | 'brake' | 'left' | 'right';

/**
 * Which driving role a key plays, or null if the key is not ours.
 *
 * Returning null is load-bearing: `main.ts` only calls `preventDefault()` on keys this map
 * claims, so Shift+Esc (ABORT) and every browser shortcut keep working while armed.
 */
export function keyRole(key: string): DriveRole | null {
  switch (key) {
    case 'ArrowUp':
    case 'w':
    case 'W':
      return 'throttle';
    case 'ArrowDown':
    case 's':
    case 'S':
      return 'brake';
    case 'ArrowLeft':
    case 'a':
    case 'A':
      return 'left';
    case 'ArrowRight':
    case 'd':
    case 'D':
      return 'right';
    default:
      return null;
  }
}

/**
 * Held keys → a drive vector.
 *
 * Opposites cancel (left+right = straight) and brake beats throttle, so no key combination can
 * produce a surprise. Keys are full-deflection: a toy car's steering is a two-position coil
 * (spec, Plan M), there is no proportional middle to aim for.
 */
export function driveFromKeys(held: Iterable<string>): DriveVector {
  let throttle = 0;
  let brake = false;
  let left = false;
  let right = false;
  for (const key of held) {
    switch (keyRole(key)) {
      case 'throttle':
        throttle = 1;
        break;
      case 'brake':
        brake = true;
        break;
      case 'left':
        left = true;
        break;
      case 'right':
        right = true;
        break;
      default:
        break;
    }
  }
  return {
    throttle: brake ? 0 : throttle,
    steer: left === right ? 0 : left ? -1 : 1,
  };
}

/** The slice of the browser Gamepad API we read — kept structural so tests need no DOM. */
export interface PadLike {
  readonly connected?: boolean;
  readonly id?: string;
  readonly axes: ReadonlyArray<number>;
  readonly buttons: ReadonlyArray<{ readonly value?: number; readonly pressed?: boolean }>;
}

/**
 * Gamepad → drive vector, Xbox layout, identical to the phone's `GamepadManager`:
 * RT (button 7, analogue) is throttle, left stick X (axis 0) is steer. A (button 0) is accepted
 * as a digital throttle so a pad whose triggers report as buttons-without-value still drives.
 */
export function driveFromGamepad(pad: PadLike | null | undefined): DriveVector | null {
  if (!pad || pad.connected === false) return null;
  const rt = pad.buttons?.[7];
  const a = pad.buttons?.[0];
  const analogue = typeof rt?.value === 'number' ? rt.value : rt?.pressed ? 1 : 0;
  const digital = a?.pressed || (typeof a?.value === 'number' && a.value > 0.5) ? 1 : 0;
  const raw = pad.axes?.[0] ?? 0;
  return {
    throttle: clampThrottle(Math.max(analogue, digital)),
    steer: Math.abs(raw) < STICK_DEADZONE ? 0 : clampSteer(raw),
  };
}

/** True when a vector asks for nothing — used to label the status line, never to skip a frame. */
export const isNeutral = (v: DriveVector): boolean => v.throttle === 0 && v.steer === 0;

export const sameVector = (a: DriveVector, b: DriveVector): boolean =>
  a.throttle === b.throttle && a.steer === b.steer;

// ---------------------------------------------------------------------- loop

export type DriveSource = 'keyboard' | 'gamepad' | 'touch';

export interface DriveStatus {
  /** False = the keys are inert. Arming is explicit so no stray keypress can move a car. */
  armed: boolean;
  kartId: number;
  source: DriveSource;
  /** Pad id when a gamepad is driving, else null. */
  padName: string | null;
  vector: DriveVector;
  /** `set_input` calls accepted since arming — the proof-of-life counter on screen. */
  frames: number;
  /** epoch ms of the last accepted frame. */
  sentAt: number | null;
  /** Last send failure, cleared by the next success. */
  error: string | null;
}

/** Disarmed, neutral, kart 1 — shared by `DriveLoop` and the store's initial `UiState`. */
export const initialDriveStatus = (kartId = 1): DriveStatus => ({
  armed: false,
  kartId,
  source: 'keyboard',
  padName: null,
  vector: NEUTRAL,
  frames: 0,
  sentAt: null,
  error: null,
});

export type SendInput = (kartId: number, throttle: number, steer: number) => Promise<void>;

/** Pad enumeration, injected so the loop is testable without a browser. */
export type PadSource = () => ReadonlyArray<PadLike | null>;

const browserPads: PadSource = () =>
  typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function'
    ? (navigator.getGamepads() as ReadonlyArray<PadLike | null>)
    : [];

/**
 * The 25 Hz sender. Owns the held-key set, picks keyboard vs. pad, and pushes one `set_input`
 * per tick while armed.
 *
 * Overlapping sends are dropped rather than queued (`inFlight`): if the laptop's link to
 * SpacetimeDB hiccups, the right behaviour is to skip the stale frame and send the current one
 * next tick — a backlog of 40 ms-old steering commands is worse than none.
 */
export class DriveLoop {
  private held = new Set<string>();
  /**
   * The phone pilot's thumbs (`src/pilot/`), or null on a page with no touch controls.
   *
   * null vs. NEUTRAL is the load-bearing distinction: null means "this page has no touch pads at
   * all", which is the director laptop, and leaves the keyboard/pad precedence exactly as it was.
   * A touch page pushes a vector on every change — including the all-zeros one on release — so the
   * HUD keeps saying `touch` instead of flipping to `keyboard` the moment a thumb lifts.
   */
  private touch: DriveVector | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private status: DriveStatus = initialDriveStatus();

  constructor(
    private readonly send: SendInput,
    private readonly onChange: (s: DriveStatus) => void,
    private readonly hz: number = DRIVE_HZ,
    private readonly pads: PadSource = browserPads,
  ) {}

  get(): DriveStatus {
    return this.status;
  }

  selectKart(kartId: number): void {
    if (!Number.isFinite(kartId) || kartId === this.status.kartId) return;
    // Hand-over through neutral: the kart being let go must not keep the last throttle.
    const previous = this.status.kartId;
    const wasArmed = this.status.armed;
    if (wasArmed) void this.sendNeutral(previous);
    this.held.clear();
    if (this.touch !== null) this.touch = NEUTRAL;
    this.patch({ kartId, vector: NEUTRAL, frames: 0, error: null });
  }

  arm(): void {
    if (this.status.armed) return;
    this.held.clear();
    if (this.touch !== null) this.touch = NEUTRAL;
    this.patch({ armed: true, vector: NEUTRAL, frames: 0, error: null });
    this.timer = setInterval(() => void this.tick(), Math.round(1000 / this.hz));
  }

  /** Disarm parks the kart with one explicit zero, exactly like `PilotEngine.stop()`. */
  disarm(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const wasArmed = this.status.armed;
    this.held.clear();
    if (this.touch !== null) this.touch = NEUTRAL;
    this.patch({ armed: false, vector: NEUTRAL, padName: null });
    if (wasArmed) void this.sendNeutral(this.status.kartId);
  }

  /**
   * Declare / update the touch vector (phone pilot). Call once with `NEUTRAL` at start-up to tell
   * the loop this page drives by thumb, then on every pad change.
   *
   * Passing null hands precedence back to the keyboard — used by nothing today, kept so a page can
   * drop its touch layer without reconstructing the loop.
   */
  setTouch(vector: DriveVector | null): void {
    this.touch =
      vector === null
        ? null
        : { throttle: clampThrottle(vector.throttle), steer: clampSteer(vector.steer) };
  }

  toggle(): void {
    if (this.status.armed) this.disarm();
    else this.arm();
  }

  /** @returns true when the key belongs to the drive control (so the caller can swallow it). */
  keyDown(key: string): boolean {
    if (!this.status.armed || keyRole(key) === null) return false;
    this.held.add(key);
    return true;
  }

  keyUp(key: string): boolean {
    if (keyRole(key) === null) return false;
    this.held.delete(key);
    return this.status.armed;
  }

  /**
   * Window blur / visibility loss: a key-up — or, on the phone, a `pointerup` eaten by the app
   * switcher, a notification or the screen locking — that we will never receive must not stick the
   * throttle. Releases keys AND thumbs; the loop stays armed and simply goes neutral.
   */
  releaseAll(): void {
    const hadTouch = this.touch !== null && !isNeutral(this.touch);
    if (this.held.size === 0 && !hadTouch) return;
    this.held.clear();
    if (this.touch !== null) this.touch = NEUTRAL;
    this.patch({ vector: NEUTRAL });
  }

  dispose(): void {
    this.disarm();
  }

  private livePad(): PadLike | null {
    for (const pad of this.pads()) {
      if (pad && pad.connected !== false && pad.axes) return pad;
    }
    return null;
  }

  /**
   * One frame. Precedence: **an actively-pushed gamepad > thumbs > keys**. "Actively pushed" is
   * what keeps an idle controller plugged in next to the laptop — or paired to the phone — from
   * vetoing the other inputs; it is also why a phone whose pads are at rest still reports `touch`
   * (the `touch !== null` tail) instead of pretending a keyboard it does not have is in charge.
   */
  private async tick(): Promise<void> {
    if (!this.status.armed) return;
    const keys = driveFromKeys(this.held);
    const pad = this.livePad();
    const padVector = driveFromGamepad(pad);
    const padActive = padVector !== null && !isNeutral(padVector);
    const touch = this.touch;
    const touchActive = touch !== null && !isNeutral(touch);

    let vector: DriveVector;
    let source: DriveSource;
    if (padActive) {
      vector = padVector!;
      source = 'gamepad';
    } else if (touchActive) {
      vector = touch!;
      source = 'touch';
    } else if (touch !== null && isNeutral(keys)) {
      vector = NEUTRAL;
      source = 'touch';
    } else {
      vector = keys;
      source = 'keyboard';
    }
    const padName = padVector !== null ? (pad?.id ?? 'gamepad') : null;

    if (
      !sameVector(vector, this.status.vector) ||
      source !== this.status.source ||
      padName !== this.status.padName
    ) {
      this.patch({ vector, source, padName });
    }

    if (this.inFlight) return; // skip the stale frame, never queue it
    this.inFlight = true;
    try {
      await this.send(this.status.kartId, vector.throttle, vector.steer);
      this.patch({ frames: this.status.frames + 1, sentAt: Date.now(), error: null });
    } catch (err) {
      this.patch({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.inFlight = false;
    }
  }

  private async sendNeutral(kartId: number): Promise<void> {
    try {
      await this.send(kartId, 0, 0);
    } catch {
      /* best effort — the bridge's staleness watchdog is the real safety net */
    }
  }

  private patch(next: Partial<DriveStatus>): void {
    this.status = { ...this.status, ...next };
    this.onChange(this.status);
  }
}
