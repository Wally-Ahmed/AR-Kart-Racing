/**
 * The drive path as it actually leaves the machine.
 *
 * `drive.test.ts` pins the key/pad mapping with a fake sender; this pins the other half — that
 * `DriveLoop` → `HttpAdapter.setInput` produces the exact request the live `arkart` module
 * accepts. It is the same shape `ios/tools/selfcheck` asserts for the phone, so the two pilot
 * clients are provably sending the same thing:
 *
 *   POST /v1/database/arkart/call/set_input   Content-Type: application/json   body [kart, thr, steer]
 *
 * Asserted at the `fetch` seam, like `sql.test.ts` pins the read format: no server, no sockets,
 * and above all not the shared `spacetime start` on :3000, which belongs to the module and
 * car-bridge legs. (Confirmed separately against that live module: this body returns HTTP 200.)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from './adapter.ts';
import { HttpAdapter } from './http.ts';
import { DriveLoop } from '../drive.ts';

interface Seen {
  url: string;
  method: string;
  contentType: string | undefined;
  body: string;
}

let seen: Seen[];
let realFetch: typeof globalThis.fetch;

/** Answer like SpacetimeDB does: an envelope for `/sql`, an empty object for a reducer call. */
function stubFetch(status = 200, text = ''): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers ?? {});
    seen.push({
      url,
      method: init?.method ?? 'GET',
      contentType: headers.get('Content-Type') ?? undefined,
      body: typeof init?.body === 'string' ? init.body : '',
    });
    const ok = status >= 200 && status < 300;
    const payload = ok
      ? url.endsWith('/sql')
        ? '[{"schema":{"elements":[]},"rows":[]}]'
        : '{}'
      : text;
    return new Response(payload, { status });
  }) as unknown as typeof globalThis.fetch;
}

beforeEach(() => {
  seen = [];
  realFetch = globalThis.fetch;
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const adapter = () =>
  new HttpAdapter({ ...DEFAULT_CONFIG, uri: 'ws://127.0.0.1:3999', pollMs: 100_000 });

const calls = () => seen.filter((s) => s.url.includes('/call/'));
const sqls = () => seen.filter((s) => s.url.endsWith('/sql'));

describe('HttpAdapter.setInput', () => {
  it('POSTs set_input as [kart_id, throttle, steer] JSON', async () => {
    await adapter().setInput(2, 0.42, -0.3);
    expect(calls()).toHaveLength(1);
    expect(calls()[0]!.method).toBe('POST');
    expect(calls()[0]!.url).toBe('http://127.0.0.1:3999/v1/database/arkart/call/set_input');
    expect(calls()[0]!.contentType).toBe('application/json');
    expect(JSON.parse(calls()[0]!.body)).toEqual([2, 0.42, -0.3]);
  });

  it('does NOT re-read per frame — at 25 Hz that would be ~225 SQL requests a second', async () => {
    const a = adapter();
    await a.setInput(1, 1, 0);
    await a.setInput(1, 1, 0);
    await new Promise((r) => setTimeout(r, 20));
    expect(sqls()).toHaveLength(0);
  });

  it('still re-reads after a director action, where the screen must update at once', async () => {
    await adapter().startRace();
    expect(calls()[0]!.url).toBe('http://127.0.0.1:3999/v1/database/arkart/call/start_race');
    // `call()`'s re-read is fire-and-forget (`void this.poll()`), so let it land.
    await new Promise((r) => setTimeout(r, 20));
    // Nine tables, one statement each — the server rejects `a; b` with a 400.
    expect(sqls()).toHaveLength(9);
    expect(sqls().every((s) => !s.body.includes(';'))).toBe(true);
  });

  it("surfaces the server's own message on a rejected call", async () => {
    stubFetch(400, 'no such reducer: set_input');
    await expect(adapter().setInput(1, 0, 0)).rejects.toThrow(/400.*no such reducer/);
  });
});

describe('DriveLoop over HttpAdapter — the whole drive path', () => {
  it('turns a held arrow key into set_input frames on the wire, and parks on disarm', async () => {
    const a = adapter();
    const loop = new DriveLoop(
      (kartId, throttle, steer) => a.setInput(kartId, throttle, steer),
      () => {},
      50, // faster than 25 Hz so the test is short; the rate itself is pinned in drive.test.ts
      () => [],
    );
    loop.arm();
    loop.keyDown('ArrowUp');
    loop.keyDown('ArrowLeft');
    await new Promise((r) => setTimeout(r, 160));
    loop.disarm();
    await new Promise((r) => setTimeout(r, 30));

    const bodies = calls().map((c) => JSON.parse(c.body) as number[]);
    expect(calls().every((c) => c.url.endsWith('/call/set_input'))).toBe(true);
    expect(bodies.length).toBeGreaterThanOrEqual(3);
    // Full throttle, full left — the keys the browser would have handed us.
    expect(bodies).toContainEqual([1, 1, -1]);
    // Last frame out is the explicit park, so a released key cannot leave a car running.
    expect(bodies.at(-1)).toEqual([1, 0, 0]);
    // Never a read: the drive loop must not drag the poll loop along with it.
    expect(sqls()).toHaveLength(0);
  });
});
