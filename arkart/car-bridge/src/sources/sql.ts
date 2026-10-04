/**
 * Zero-bindings fallback source: poll SpacetimeDB's HTTP `/sql` endpoint.
 *
 * Why it exists: the WebSocket SDK path needs the module's GENERATED bindings,
 * which are produced by a parallel leg. This adapter needs nothing but a running
 * `spacetime start` and a published `arkart` module, so the bridge can be proven
 * against the real database on integration day even if `spacetime generate` is
 * still in flight. Poll rate is configurable and defaults to 20 Hz; the 50 Hz
 * UDP loop keeps running off the most recent poll in between.
 *
 * Response shape is handled both ways: `[{schema, rows:[[...]]}]` (columnar,
 * v1 REST) and `[{rows:[{col: val}]}]` (object rows).
 */

import { normalizeConfig, normalizeEffects, normalizeInput, normalizeKart } from '../normalize.ts';
import type { WorldSource } from '../source.ts';
import { emptySnapshot, type WorldSnapshot } from '../types.ts';

export interface SqlSourceOptions {
  /** e.g. http://localhost:3000 */
  httpOrigin: string;
  moduleName: string;
  pollHz?: number;
  /** bearer token, if the local server was started with auth */
  token?: string;
  onLog?: (msg: string) => void;
  fetchImpl?: typeof fetch;
}

type AnyRec = Record<string, unknown>;

/**
 * ONE STATEMENT PER REQUEST. SpacetimeDB 2.4.1 rejects a multi-statement body
 * with 400 "Multiple SQL statements are not supported", so these are issued as
 * four parallel POSTs. `Promise.all` preserves order, which is what lets
 * `#buildSnapshot` keep destructuring the results positionally.
 */
const QUERIES = [
  'SELECT * FROM config',
  'SELECT * FROM kart',
  'SELECT * FROM input',
  'SELECT * FROM effect',
] as const;

/** Dig a column name out of the several shapes STDB's schema JSON has used. */
function columnNames(schema: unknown): string[] {
  const s = schema as AnyRec | undefined;
  const elements = (s?.elements ?? s?.product_type_elements) as AnyRec[] | undefined;
  if (!Array.isArray(elements)) return [];
  return elements.map((el, i) => {
    const n = el?.name;
    if (typeof n === 'string') return n;
    if (n && typeof n === 'object') {
      const o = n as AnyRec;
      if (typeof o.some === 'string') return o.some;
      if (typeof o.value === 'string') return o.value;
    }
    return `col${i}`;
  });
}

/** One `{schema, rows}` result -> plain objects. */
export function resultToRows(result: unknown): AnyRec[] {
  const r = result as AnyRec | undefined;
  const rows = r?.rows;
  if (!Array.isArray(rows)) return [];
  if (rows.length === 0) return [];
  if (!Array.isArray(rows[0])) return rows as AnyRec[];
  const names = columnNames(r?.schema);
  return (rows as unknown[][]).map((tuple) => {
    const obj: AnyRec = {};
    tuple.forEach((v, i) => {
      obj[names[i] ?? `col${i}`] = v;
    });
    return obj;
  });
}

export class SqlSource implements WorldSource {
  readonly kind = 'sql';
  readonly #opts: Required<Pick<SqlSourceOptions, 'httpOrigin' | 'moduleName' | 'pollHz'>> &
    SqlSourceOptions;
  #snapshot: WorldSnapshot = emptySnapshot();
  #timer: NodeJS.Timeout | null = null;
  #connected = false;
  #log: (msg: string) => void;
  #fetch: typeof fetch;
  #lastError = '';

  constructor(opts: SqlSourceOptions) {
    this.#opts = { pollHz: 20, ...opts };
    this.#log = opts.onLog ?? ((m) => console.log(`[sql] ${m}`));
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  get url(): string {
    return `${this.#opts.httpOrigin}/v1/database/${this.#opts.moduleName}/sql`;
  }

  /** One single-statement POST. Returns that statement's single result object. */
  async #query(sql: string): Promise<unknown> {
    const headers: Record<string, string> = { 'Content-Type': 'text/plain' };
    if (this.#opts.token) headers.Authorization = `Bearer ${this.#opts.token}`;
    const res = await this.#fetch(this.url, { method: 'POST', headers, body: sql });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `${res.status} ${res.statusText} from ${this.url} on "${sql}"${detail ? `: ${detail.trim()}` : ''}`,
      );
    }
    const body = (await res.json()) as unknown[];
    return body[0]; // a single statement yields a single {schema, rows} result
  }

  async poll(): Promise<void> {
    const results = await Promise.all(QUERIES.map((q) => this.#query(q)));
    this.#snapshot = this.#buildSnapshot(results);
    this.#connected = true;
  }

  #buildSnapshot(results: unknown[]): WorldSnapshot {
    const snap = emptySnapshot();
    const [configRes, kartRes, inputRes, effectRes] = results;

    const configRows = resultToRows(configRes);
    if (configRows[0]) snap.config = normalizeConfig(configRows[0]);
    snap.karts = resultToRows(kartRes).map(normalizeKart);
    for (const raw of resultToRows(inputRes)) {
      const row = normalizeInput(raw);
      snap.inputs.set(row.kartId, row);
    }
    snap.effects = normalizeEffects(resultToRows(effectRes));
    return snap;
  }

  async start(): Promise<void> {
    await this.poll(); // fail loudly if the DB is not reachable at all
    this.#log(`polling ${this.url} at ${this.#opts.pollHz} Hz`);
    this.#timer = setInterval(() => {
      this.poll().catch((err: Error) => {
        this.#connected = false;
        if (err.message !== this.#lastError) {
          this.#lastError = err.message;
          this.#log(`poll failed: ${err.message}`);
        }
      });
    }, 1000 / this.#opts.pollHz);
    this.#timer.unref();
  }

  snapshot(): WorldSnapshot {
    return this.#snapshot;
  }

  isConnected(): boolean {
    return this.#connected;
  }

  stop(): Promise<void> {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#connected = false;
    return Promise.resolve();
  }
}
