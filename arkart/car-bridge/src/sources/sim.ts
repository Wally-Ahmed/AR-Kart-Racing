/**
 * In-memory world source. No SpacetimeDB, no network.
 *
 * Two jobs:
 *  1. `BRIDGE_SOURCE=sim` — bench-test the firmware's UDP path and the shield
 *     LED without the module or the phones existing yet.
 *  2. Tests — `MutableSource` lets a test drive any world state it likes.
 */

import type { WorldSource } from '../source.ts';
import { emptySnapshot, type WorldSnapshot } from '../types.ts';

/** A source whose snapshot a test (or the sim driver) sets directly. */
export class MutableSource implements WorldSource {
  readonly kind = 'mutable';
  #snapshot: WorldSnapshot;
  #connected = false;

  constructor(initial: WorldSnapshot = emptySnapshot()) {
    this.#snapshot = initial;
  }

  set(snapshot: WorldSnapshot): void {
    this.#snapshot = snapshot;
  }

  start(): Promise<void> {
    this.#connected = true;
    return Promise.resolve();
  }

  snapshot(): WorldSnapshot {
    return this.#snapshot;
  }

  isConnected(): boolean {
    return this.#connected;
  }

  stop(): Promise<void> {
    this.#connected = false;
    return Promise.resolve();
  }
}

export interface SimOptions {
  kartIds: number[];
  /** peak normalised throttle of the sweep, 0..1 */
  throttle?: number;
  /** seconds per full steer sweep */
  periodSec?: number;
  now?: () => number;
}

/**
 * A running race with a gentle throttle + steer sweep, so a kart on the bench
 * visibly reacts. Refreshes `input.updatedAt` every call so it never reads stale.
 */
export class SimSource implements WorldSource {
  readonly kind = 'sim';
  readonly #opts: Required<SimOptions>;
  #started = 0;
  #connected = false;

  constructor(opts: SimOptions) {
    this.#opts = {
      kartIds: opts.kartIds,
      throttle: opts.throttle ?? 0.35,
      periodSec: opts.periodSec ?? 4,
      now: opts.now ?? (() => Date.now()),
    };
  }

  start(): Promise<void> {
    this.#started = this.#opts.now();
    this.#connected = true;
    return Promise.resolve();
  }

  snapshot(): WorldSnapshot {
    const now = this.#opts.now();
    const t = (now - this.#started) / 1000;
    const phase = (2 * Math.PI * t) / this.#opts.periodSec;
    const snap = emptySnapshot();
    snap.config = { lapCount: 3, itemRollPct: 100, state: 'running', countdownEndsAt: null };
    for (const kartId of this.#opts.kartIds) {
      snap.karts.push({ kartId, name: `sim-${kartId}`, ip: '', pilotIdentity: null });
      snap.inputs.set(kartId, {
        kartId,
        throttle: this.#opts.throttle,
        steer: Math.sin(phase + kartId),
        updatedAt: now,
      });
    }
    return snap;
  }

  isConnected(): boolean {
    return this.#connected;
  }

  stop(): Promise<void> {
    this.#connected = false;
    return Promise.resolve();
  }
}
