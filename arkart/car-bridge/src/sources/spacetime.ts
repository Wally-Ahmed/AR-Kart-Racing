/**
 * Live SpacetimeDB source — the production path (§3, §5).
 *
 * ISOLATION NOTE (why this file is `any`-heavy and dynamically imported):
 * a SpacetimeDB client only talks to a module through that module's GENERATED
 * bindings (`spacetime generate --lang typescript`), and the `arkart` module is
 * being built by a parallel leg, so those bindings do not exist in this tree
 * yet. Importing them statically would break `tsc --noEmit` for everyone.
 *
 * So: the bindings are loaded through a *variable* import specifier (TypeScript
 * therefore types the result as `any` and never tries to resolve the path), and
 * every row that comes back is funnelled through src/normalize.ts into OUR row
 * types before any game logic sees it. Hooking this up at integration is one
 * env var:
 *
 *     BRIDGE_BINDINGS=../../module/src/module_bindings/index.ts npm start
 *
 * The generated-bindings surface this expects is the standard one, identical in
 * SDK 1.x and 2.x:
 *     DbConnection.builder().withUri(...).withModuleName(...).onConnect(cb).build()
 *     conn.subscriptionBuilder().onApplied(cb).subscribe([...sql])
 *     conn.db.<table>.iter()
 */

import { normalizeConfig, normalizeEffects, normalizeInput, normalizeKart } from '../normalize.ts';
import type { WorldSource } from '../source.ts';
import { emptySnapshot, type WorldSnapshot } from '../types.ts';

export interface SpacetimeSourceOptions {
  uri: string;
  moduleName: string;
  /** import specifier for the module's generated bindings */
  bindingsPath: string;
  /** resolved against this base (defaults to this file's URL) */
  baseUrl?: string;
  onLog?: (msg: string) => void;
}

const SUBSCRIPTIONS = [
  'SELECT * FROM config',
  'SELECT * FROM kart',
  'SELECT * FROM input',
  'SELECT * FROM effect',
];

type AnyRec = Record<string, unknown>;

/** Own + prototype method names, so an API-drift error can name what IS there. */
export function describeMethods(obj: unknown): string {
  if (obj === null || obj === undefined) return '<none>';
  const names = new Set<string>();
  for (let o: object | null = obj as object; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const k of Object.getOwnPropertyNames(o)) {
      if (k === 'constructor') continue;
      try {
        if (typeof (obj as AnyRec)[k] === 'function') names.add(k);
      } catch {
        /* getters that throw are not interesting here */
      }
    }
  }
  return names.size === 0 ? '<none>' : [...names].sort().join(', ');
}

/** Pull every row out of a generated table handle, whatever shape it exposes. */
function tableRows(db: unknown, ...names: string[]): AnyRec[] {
  const d = db as AnyRec | null | undefined;
  if (!d) return [];
  for (const n of names) {
    const handle = d[n] as AnyRec | undefined;
    if (!handle) continue;
    const iter = handle.iter;
    if (typeof iter === 'function') {
      return Array.from((iter as () => Iterable<AnyRec>).call(handle));
    }
    if (typeof (handle as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function') {
      return Array.from(handle as unknown as Iterable<AnyRec>);
    }
  }
  return [];
}

export class SpacetimeSource implements WorldSource {
  readonly kind = 'stdb';
  readonly #opts: SpacetimeSourceOptions;
  #conn: AnyRec | null = null;
  #connected = false;
  #log: (msg: string) => void;

  constructor(opts: SpacetimeSourceOptions) {
    this.#opts = opts;
    this.#log = opts.onLog ?? ((m) => console.log(`[stdb] ${m}`));
  }

  async start(): Promise<void> {
    const base = this.#opts.baseUrl ?? import.meta.url;
    // Variable specifier on purpose — see the ISOLATION NOTE above.
    const specifier: string = this.#opts.bindingsPath.startsWith('.')
      ? new URL(this.#opts.bindingsPath, base).href
      : this.#opts.bindingsPath;

    let bindings: AnyRec;
    try {
      bindings = (await import(specifier)) as AnyRec;
    } catch (err) {
      throw new Error(
        `could not load SpacetimeDB bindings from "${specifier}". ` +
          `Run \`spacetime generate --lang typescript --out-dir <dir>\` for the arkart module ` +
          `and point BRIDGE_BINDINGS at its index, or run with BRIDGE_SOURCE=sql|sim. ` +
          `Cause: ${(err as Error).message}`,
      );
    }

    const DbConnection = (bindings.DbConnection ?? (bindings.default as AnyRec)?.DbConnection) as
      | { builder: () => AnyRec }
      | undefined;
    if (!DbConnection || typeof DbConnection.builder !== 'function') {
      throw new Error(`bindings at "${specifier}" do not export a DbConnection with .builder()`);
    }

    await new Promise<void>((resolveConnected, rejectConnected) => {
      let settled = false;
      const builder = DbConnection.builder() as AnyRec;

      /** Optional builder step: genuinely fine if this SDK has no such hook. */
      const call = (obj: AnyRec, name: string, ...args: unknown[]): AnyRec => {
        const fn = obj[name];
        if (typeof fn !== 'function') return obj;
        return (fn as (...a: unknown[]) => AnyRec).apply(obj, args) ?? obj;
      };

      /**
       * REQUIRED builder step, tried under several names across SDK versions.
       * Throws when none of them exist — silently skipping a renamed method
       * turns an SDK rename into a ghost failure that only surfaces much later
       * as an unrelated error ("Database name or address is required").
       */
      const callRequired = (obj: AnyRec, names: string[], ...args: unknown[]): AnyRec => {
        for (const name of names) {
          const fn = obj[name];
          if (typeof fn === 'function') {
            return (fn as (...a: unknown[]) => AnyRec).apply(obj, args) ?? obj;
          }
        }
        throw new Error(
          `SpacetimeDB connection builder exposes none of [${names.join(', ')}] — SDK API drift. ` +
            `Methods it does have: ${describeMethods(obj)}`,
        );
      };

      let b = callRequired(builder, ['withUri'], this.#opts.uri);
      // SDK 2.4.1 renamed withModuleName -> withDatabaseName; probe new first.
      b = callRequired(b, ['withDatabaseName', 'withModuleName'], this.#opts.moduleName);
      b = callRequired(b, ['onConnect'], (conn: AnyRec) => {
        this.#conn = conn;
        this.#connected = true;
        this.#log(`connected to ${this.#opts.uri} / ${this.#opts.moduleName}`);
        try {
          const sub = callRequired(conn, ['subscriptionBuilder']);
          const applied = callRequired(sub, ['onApplied'], () => {
            this.#log('subscriptions applied');
            if (!settled) {
              settled = true;
              resolveConnected();
            }
          });
          callRequired(applied, ['subscribe'], SUBSCRIPTIONS);
        } catch (err) {
          this.#log(`subscription failed: ${(err as Error).message}`);
          if (!settled) {
            settled = true;
            resolveConnected(); // stay up; snapshot() just returns empty until rows arrive
          }
        }
      });
      b = call(b, 'onConnectError', (_ctx: unknown, err: unknown) => {
        this.#connected = false;
        if (!settled) {
          settled = true;
          rejectConnected(new Error(`SpacetimeDB connect error: ${String(err)}`));
        }
      });
      b = call(b, 'onDisconnect', () => {
        this.#connected = false;
        this.#log('disconnected');
      });
      callRequired(b, ['build']);
    });
  }

  snapshot(): WorldSnapshot {
    const snap = emptySnapshot();
    const db = this.#conn?.db;
    if (!db) return snap;

    const configRows = tableRows(db, 'config');
    if (configRows.length > 0 && configRows[0]) snap.config = normalizeConfig(configRows[0]);

    snap.karts = tableRows(db, 'kart').map(normalizeKart);

    for (const raw of tableRows(db, 'input')) {
      const row = normalizeInput(raw);
      snap.inputs.set(row.kartId, row);
    }

    snap.effects = normalizeEffects(tableRows(db, 'effect'));
    return snap;
  }

  isConnected(): boolean {
    return this.#connected;
  }

  async stop(): Promise<void> {
    const conn = this.#conn;
    this.#conn = null;
    this.#connected = false;
    if (conn && typeof conn.disconnect === 'function') {
      try {
        await (conn.disconnect as () => unknown)();
      } catch {
        /* shutting down anyway */
      }
    }
  }
}
