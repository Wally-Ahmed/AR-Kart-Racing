/**
 * HTTP adapter — SpacetimeDB v1 REST API, no generated bindings required.
 *
 *   reducers : POST {base}/v1/database/{module}/call/{reducer}   body = JSON array of args
 *   reads    : POST {base}/v1/database/{module}/sql              body = ONE SQL statement
 *
 * Verified against the live `arkart` module (2026-09-20): the endpoint rejects multi-statement
 * bodies with `400 Multiple SQL statements are not supported`, so the nine tables are fetched as
 * nine parallel requests per poll. On localhost that is ~1 ms of work; this is the same transport
 * the iOS pilot app uses (spec §8), so it is the path most likely to work the moment the module
 * is published. The SDK adapter is the WebSocket-subscription upgrade.
 */

import {
  httpBase,
  type AdapterConfig,
  type AdapterListener,
  type DirectorAdapter,
} from './adapter.ts';
import type { Json } from './coerce.ts';
import { assembleSnapshot, TABLES, type TableName } from './rows.ts';
import { resultToObjects, type SqlResult } from './sql.ts';

export { resultToObjects } from './sql.ts';

export class HttpAdapter implements DirectorAdapter {
  readonly name = 'http';
  readonly endpoint: string;

  private listener: AdapterListener | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private stopped = false;
  private everLive = false;

  constructor(private readonly cfg: AdapterConfig) {
    this.endpoint = `${httpBase(cfg.uri)}/v1/database/${cfg.module}`;
  }

  start(listener: AdapterListener): void {
    this.listener = listener;
    this.stopped = false;
    this.emitStatus('connecting', `${this.endpoint} (SQL poll ${this.cfg.pollMs} ms)`);
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.cfg.pollMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.listener = null;
  }

  beginSetup = () => this.call('begin_setup', []);
  confirmTrack = (ordered: number[]) => this.call('confirm_track', [ordered]);
  startRace = () => this.call('start_race', []);
  resetRace = () => this.call('reset_race', []);
  abortRace = () => this.call('abort_race', []);

  /**
   * The pilot reducer — `[kart_id, throttle, steer]`, the body the iOS app sends (its README's
   * wire contract, pinned by `ios/tools/selfcheck`).
   *
   * Deliberately `post` and NOT `call`: a director action is rare and wants its effect on screen
   * immediately, but this one fires 25× a second and `call`'s courtesy re-poll would turn that
   * into ~225 SQL requests a second. The normal poll loop picks the new `input` row up within
   * `pollMs` anyway.
   */
  setInput = (kartId: number, throttle: number, steer: number) =>
    this.post('set_input', [kartId, throttle, steer]);

  /** POST a reducer call and refresh the screen. Throws on non-2xx so the UI can show it. */
  async call(reducer: string, args: unknown[]): Promise<void> {
    await this.post(reducer, args);
    void this.poll(); // reflect the change now instead of waiting out the poll interval
  }

  /** POST a reducer call, nothing else. Throws on non-2xx with the server's own message. */
  private async post(reducer: string, args: unknown[]): Promise<void> {
    const res = await fetch(`${this.endpoint}/call/${reducer}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
    }
  }

  /** One statement per request — the endpoint refuses `a; b`. */
  private async selectAll(table: TableName): Promise<Array<Record<string, Json>>> {
    const res = await fetch(`${this.endpoint}/sql`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: `SELECT * FROM ${table}`,
    });
    if (!res.ok) throw new Error(`SELECT ${table} → HTTP ${res.status}`);
    const results = (await res.json()) as SqlResult[];
    return resultToObjects(results?.[0]);
  }

  private async poll(): Promise<void> {
    if (this.inFlight || this.stopped) return;
    this.inFlight = true;
    try {
      const fetched = await Promise.all(TABLES.map((t) => this.selectAll(t)));
      if (this.stopped) return;
      const tables: Partial<Record<TableName, Array<Record<string, Json>>>> = {};
      TABLES.forEach((t, i) => {
        tables[t] = fetched[i];
      });
      this.everLive = true;
      this.listener?.({ type: 'snapshot', snapshot: assembleSnapshot(tables) });
      this.emitStatus('live', `${this.endpoint} · SQL poll ${this.cfg.pollMs} ms`);
    } catch (err) {
      if (!this.stopped) {
        this.emitStatus(
          this.everLive ? 'error' : 'offline',
          `${this.endpoint} — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } finally {
      this.inFlight = false;
    }
  }

  private emitStatus(status: 'connecting' | 'live' | 'error' | 'offline', detail: string): void {
    this.listener?.({ type: 'status', status, detail });
  }
}
