/**
 * The adapter contract — the ONLY seam between the director UI and SpacetimeDB.
 *
 * The module is being built in parallel, so no generated bindings exist yet. Everything above
 * this line (store + UI + placement) talks to `DirectorAdapter` and nothing else; swapping in
 * the real connection at integration time is a one-line change in `src/main.ts`.
 *
 * Three implementations ship:
 *   - `mock`  — a self-contained simulated race. Always works, no server. Demo/dev safety net.
 *   - `http`  — SpacetimeDB v1 HTTP API (`/call/:reducer` + `/sql` polling). No bindings needed.
 *   - `sdk`   — the real TS SDK with live WebSocket subscriptions, loading the generated
 *               `module_bindings` by dynamic import so this file compiles before they exist.
 */

import type { RaceSnapshot } from '../types.ts';

export type AdapterEvent =
  | { type: 'snapshot'; snapshot: RaceSnapshot }
  | { type: 'status'; status: 'connecting' | 'live' | 'error' | 'offline'; detail: string };

export type AdapterListener = (ev: AdapterEvent) => void;

/**
 * Reducers the director screen is allowed to call: the director-only actions of spec §4, plus
 * `set_input` — the pilot reducer, because the laptop doubles as a pilot station (see `drive.ts`:
 * bench-testing the car bridge, and the demo fallback when no phone is provisioned).
 */
export interface DirectorAdapter {
  /** Short name shown in the header pill: mock | http | sdk. */
  readonly name: string;
  /** Where it is pointed, for the header subtitle. */
  readonly endpoint: string;
  /**
   * True when the transport PUSHES (live subscriptions) rather than polling.
   *
   * A pushing transport is silent whenever nothing changes — an idle lobby produces no traffic at
   * all — so the header must not read "gone stale" into that silence. Pollers, which should
   * produce a snapshot every `pollMs`, are held to the staleness check.
   */
  readonly pushes?: boolean;

  start(listener: AdapterListener): void;
  stop(): void;

  beginSetup(): Promise<void>;
  confirmTrack(orderedTagIds: number[]): Promise<void>;
  startRace(): Promise<void>;
  resetRace(): Promise<void>;
  abortRace(): Promise<void>;

  /**
   * `set_input(kart_id, throttle, steer)` — the same reducer the iOS pilot calls at 25 Hz
   * (spec §1 D1). Called on EVERY tick, changed or not: the write doubles as the keep-alive the
   * car bridge's staleness watchdog is watching for.
   *
   * Throttle is 0..1 (no reverse — the Plan-M drive stage has no H-bridge on the rear motor),
   * steer is -1..1. Implementations must NOT trigger a read/poll per call: at 25 Hz that would
   * multiply into hundreds of SQL requests a second.
   */
  setInput(kartId: number, throttle: number, steer: number): Promise<void>;
}

export interface AdapterConfig {
  /** ws://localhost:3000 by default (spec §3: everything server-side on one laptop). */
  uri: string;
  /** Module name. */
  module: string;
  /** Poll interval for the HTTP adapter, ms. */
  pollMs: number;
  /**
   * Where the generated bindings live, as a URL the browser can import at runtime.
   *
   * ROOT-RELATIVE ON PURPOSE. A `./`-relative specifier resolves against the *page* URL, so on
   * any route it lands somewhere Vite answers with the SPA fallback — i.e. `index.html`, which
   * imports as HTML and fails. `/src/module_bindings/index.ts` is served and transformed by the
   * dev server, so a bare `?adapter=sdk` works with no extra query string.
   */
  bindingsPath: string;
}

export const DEFAULT_CONFIG: AdapterConfig = {
  uri: 'ws://localhost:3000',
  module: 'arkart',
  pollMs: 200,
  bindingsPath: '/src/module_bindings/index.ts',
};

/** ws://host:port → http://host:port (STDB serves both on the same port). */
export function httpBase(uri: string): string {
  return uri.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:').replace(/\/+$/, '');
}

/**
 * Read adapter config from the URL query string so the demo can be re-pointed without a rebuild:
 *   ?adapter=mock|http|sdk  ?uri=ws://192.168.8.1:3000  ?module=arkart  ?poll=200
 */
export function readUrlConfig(search: string): {
  adapter: 'mock' | 'http' | 'sdk' | null;
  config: AdapterConfig;
} {
  const q = new URLSearchParams(search);
  const raw = q.get('adapter');
  const adapter = raw === 'mock' || raw === 'http' || raw === 'sdk' ? raw : null;
  const poll = Number(q.get('poll'));
  return {
    adapter,
    config: {
      uri: q.get('uri') ?? DEFAULT_CONFIG.uri,
      module: q.get('module') ?? DEFAULT_CONFIG.module,
      pollMs: Number.isFinite(poll) && poll >= 50 ? poll : DEFAULT_CONFIG.pollMs,
      bindingsPath: q.get('bindings') ?? DEFAULT_CONFIG.bindingsPath,
    },
  };
}
