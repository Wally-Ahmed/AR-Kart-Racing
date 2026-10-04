/**
 * Decorator that can force any world source to report "no race, no input".
 *
 * Used on shutdown: because an empty snapshot has no `config`, the rule engine's
 * `state != running` branch emits throttle 0 / steer 0 / flags 0 for every kart,
 * so parking the karts reuses the exact same code path as `abort_race` instead
 * of hand-rolling a zero packet. The bridge keeps its sink and its per-kart
 * sequence counters, so the park packets CONTINUE the sequence rather than
 * restarting at 0 — firmware that drops out-of-order packets would otherwise
 * ignore the very packets meant to stop the car.
 */

import type { WorldSource } from '../source.ts';
import { emptySnapshot, type WorldSnapshot } from '../types.ts';

export class ParkableSource implements WorldSource {
  readonly kind = 'parkable';
  readonly #inner: WorldSource;
  #parked = false;

  constructor(inner: WorldSource) {
    this.#inner = inner;
  }

  get parked(): boolean {
    return this.#parked;
  }

  park(): void {
    this.#parked = true;
  }

  start(): Promise<void> {
    return this.#inner.start();
  }

  snapshot(): WorldSnapshot {
    return this.#parked ? emptySnapshot() : this.#inner.snapshot();
  }

  isConnected(): boolean {
    return this.#inner.isConnected();
  }

  stop(): Promise<void> {
    return this.#inner.stop();
  }
}
