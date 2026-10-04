/**
 * SDK adapter — real SpacetimeDB WebSocket subscriptions (the sponsor-demo showpiece:
 * live-updating tables straight off the DB, no polling).
 *
 * ISOLATION NOTE — read before editing.
 * The module is built in parallel with this screen, so `module_bindings/` does not exist at the
 * time this file was written. It is therefore loaded with a **dynamic import at runtime**
 * (`/* @vite-ignore *\/`), typed `any` at exactly one place. That keeps `tsc --noEmit` green
 * today and makes live hookup a drop-in at integration: generate bindings into
 * `src/module_bindings/` and the adapter finds them.
 *
 *   spacetime generate --lang typescript --out-dir arkart/director/src/module_bindings \
 *                      --project-path arkart/module
 *
 * Both accessor conventions are probed (`conn.db.setup_seen` and `conn.db.setupSeen`;
 * `conn.reducers.begin_setup()` and `conn.reducers.beginSetup()`), because which one the
 * generator emits depends on the CLI version — and finding out costs a round trip we don't have.
 *
 * The CALLING convention differs across SDK majors too: 2.x reducers take one params object,
 * 1.x took positional arguments. See `callReducer` — this bit is not cosmetic, a positional call
 * against a 2.x binding produces a malformed frame rather than an error.
 */

import type { AdapterConfig, AdapterListener, DirectorAdapter } from './adapter.ts';
import { camel, type Json } from './coerce.ts';
import { assembleSnapshot, TABLES, type TableName } from './rows.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

/** Generated row objects are class instances — flatten to a plain bag for the mappers. */
function toPlain(row: Any): Record<string, Json> {
  if (!row || typeof row !== 'object') return {};
  const out: Record<string, Json> = {};
  for (const k of Object.keys(row)) out[k] = row[k];
  return out;
}

/** Find a table handle under either naming convention. */
function tableHandle(db: Any, table: TableName): Any {
  if (!db) return null;
  return db[table] ?? db[camel(table)] ?? null;
}

/** Read every row out of a table handle, tolerating `iter()` / `tableCache` shapes. */
function readTable(db: Any, table: TableName): Array<Record<string, Json>> {
  const handle = tableHandle(db, table);
  if (!handle) return [];
  try {
    if (typeof handle.iter === 'function') return Array.from(handle.iter(), toPlain);
    if (typeof handle.rows === 'function') return Array.from(handle.rows(), toPlain);
    if (Array.isArray(handle.rows)) return handle.rows.map(toPlain);
  } catch {
    /* table not populated yet */
  }
  return [];
}

export class SdkAdapter implements DirectorAdapter {
  readonly name = 'sdk';
  readonly endpoint: string;
  /** Subscriptions push; an idle race is silent, not stale. */
  readonly pushes = true;

  private listener: AdapterListener | null = null;
  private conn: Any = null;
  private stopped = false;
  private repaintTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly cfg: AdapterConfig) {
    this.endpoint = `${cfg.uri}/${cfg.module}`;
  }

  start(listener: AdapterListener): void {
    this.listener = listener;
    this.stopped = false;
    this.emitStatus('connecting', `${this.endpoint} — loading module bindings…`);
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.repaintTimer) clearTimeout(this.repaintTimer);
    try {
      this.conn?.disconnect?.();
    } catch {
      /* already gone */
    }
    this.conn = null;
    this.listener = null;
  }

  beginSetup = () => this.callReducer('begin_setup', {});
  confirmTrack = (ordered: number[]) =>
    this.callReducer('confirm_track', { orderedTagIds: ordered }, [ordered]);
  startRace = () => this.callReducer('start_race', {});
  resetRace = () => this.callReducer('reset_race', {});
  abortRace = () => this.callReducer('abort_race', {});
  /** Nothing to re-poll: the row callbacks push the `input` update back to us. */
  setInput = (kartId: number, throttle: number, steer: number) =>
    this.callReducer('set_input', { kartId, throttle, steer }, [kartId, throttle, steer]);

  /**
   * Call a reducer across both generator conventions.
   *
   * **SDK 2.x takes ONE params OBJECT**, keyed by the camelCase field names in
   * `module_bindings/<name>_reducer.ts` — verified in `spacetimedb@2.10.1`:
   * `db_connection_impl.#makeReducers` builds `(params) => serializeArgs(writer, params)` and
   * keys the accessor by `accessorName`, which `reducers.ts` sets to `toCamelCase(name)`. SDK 1.x
   * generators emitted positional arguments instead.
   *
   * So: object first, positional as the fallback if that throws. Getting this wrong is quiet and
   * nasty — a positional call against a 2.x binding hands the serializer a bare number where it
   * wants `{ kartId, throttle, steer }`, which is a malformed frame, not a clean error.
   */
  private async callReducer(
    name: string,
    params: Record<string, unknown>,
    positional: unknown[] = [],
  ): Promise<void> {
    const reducers: Any = this.conn?.reducers;
    if (!reducers) throw new Error('not connected to SpacetimeDB');
    const fn = reducers[camel(name)] ?? reducers[name];
    if (typeof fn !== 'function') throw new Error(`reducer ${name} not found in bindings`);
    try {
      await fn.call(reducers, params);
    } catch (err) {
      if (positional.length === 0) throw err;
      await fn.call(reducers, ...positional);
    }
  }

  private async connect(): Promise<void> {
    let bindings: Any;
    try {
      bindings = await import(/* @vite-ignore */ this.cfg.bindingsPath);
    } catch (err) {
      this.emitStatus(
        'offline',
        `module bindings not found at ${this.cfg.bindingsPath} — run \`spacetime generate --lang typescript --out-dir src/module_bindings\`, or use ?adapter=http (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
      return;
    }

    const DbConnection: Any = bindings.DbConnection ?? bindings.default?.DbConnection;
    if (!DbConnection?.builder) {
      this.emitStatus('offline', 'bindings loaded but export DbConnection is missing');
      return;
    }

    // SDK 2.x renamed the builder's `withModuleName` to `withDatabaseName`; bindings generated by
    // CLI 2.4.1 target 2.x, while 1.x is still on the old name. Probe rather than pick, so the
    // screen survives whichever SDK the module leg's generator lands on.
    let builder: Any;
    try {
      builder = DbConnection.builder().withUri(this.cfg.uri);
      if (typeof builder.withDatabaseName === 'function') {
        builder = builder.withDatabaseName(this.cfg.module);
      } else if (typeof builder.withModuleName === 'function') {
        builder = builder.withModuleName(this.cfg.module);
      } else {
        this.emitStatus(
          'offline',
          'SDK builder exposes neither withDatabaseName (2.x) nor withModuleName (1.x)',
        );
        return;
      }
    } catch (err) {
      this.emitStatus(
        'offline',
        `builder threw: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    try {
      this.conn = builder
        .onConnect((conn: Any) => {
          this.emitStatus('live', `${this.endpoint} · websocket subscriptions`);
          this.subscribe(conn);
        })
        .onConnectError((_ctx: Any, err: Any) => {
          this.emitStatus('offline', `connect failed: ${err?.message ?? String(err)}`);
        })
        .onDisconnect(() => {
          if (!this.stopped) this.emitStatus('error', 'disconnected from SpacetimeDB');
        })
        .build();
    } catch (err) {
      // 'offline', not 'error': every failure above means "this transport is unusable", which is
      // what lets AutoAdapter drop to HTTP polling instead of parking on a dead screen. 'error' is
      // reserved for a connection that WAS live and then broke (see onDisconnect).
      this.emitStatus(
        'offline',
        `build() threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private subscribe(conn: Any): void {
    // One subscription covering every table the screen renders.
    const queries = TABLES.map((t) => `SELECT * FROM ${t}`);
    try {
      const builder = conn.subscriptionBuilder?.();
      if (builder) {
        builder
          .onApplied(() => this.repaint())
          .onError((_ctx: Any, err: Any) =>
            this.emitStatus('error', `subscription error: ${err?.message ?? String(err)}`),
          )
          .subscribe(queries);
      } else if (typeof conn.subscribe === 'function') {
        conn.subscribe(queries);
      }
    } catch (err) {
      this.emitStatus('error', `subscribe threw: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Any row change on any table → rebuild the whole snapshot (a handful of rows; cheap).
    for (const table of TABLES) {
      const handle = tableHandle(conn.db, table);
      if (!handle) continue;
      const repaint = () => this.repaint();
      try {
        handle.onInsert?.(repaint);
        handle.onUpdate?.(repaint);
        handle.onDelete?.(repaint);
      } catch {
        /* handle without callbacks — the subscription applied-callback still repaints */
      }
    }
    this.repaint();
  }

  /** Coalesce bursts of row callbacks into one snapshot per frame. */
  private repaint(): void {
    if (this.stopped || this.repaintTimer) return;
    this.repaintTimer = setTimeout(() => {
      this.repaintTimer = null;
      if (this.stopped || !this.conn) return;
      const tables: Partial<Record<TableName, Array<Record<string, Json>>>> = {};
      for (const t of TABLES) tables[t] = readTable(this.conn.db, t);
      this.listener?.({ type: 'snapshot', snapshot: assembleSnapshot(tables) });
    }, 16);
  }

  private emitStatus(status: 'connecting' | 'live' | 'error' | 'offline', detail: string): void {
    this.listener?.({ type: 'status', status, detail });
  }
}
