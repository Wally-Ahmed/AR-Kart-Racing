/**
 * Regression tests for the two integration-pass defects.
 *
 * D2 — the SQL fallback sent four statements in one POST; SpacetimeDB 2.4.1
 *      answers 400 "Multiple SQL statements are not supported".
 * D1 — the builder helper silently skipped unknown methods, so SDK 2.4.1's
 *      withModuleName -> withDatabaseName rename became a no-op that only
 *      surfaced later as "Database name or address is required".
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SqlSource } from '../src/sources/sql.ts';
import { SpacetimeSource, describeMethods } from '../src/sources/spacetime.ts';

// --------------------------------------------------------------------------
// D2
// --------------------------------------------------------------------------

function recordingFetch(bodies: string[], respond: (sql: string) => unknown) {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const sql = String(init?.body ?? '');
    bodies.push(sql);
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => [respond(sql)],
      text: async () => '',
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('SqlSource — one statement per request (D2)', () => {
  it('issues four separate single-statement POSTs, never a combined body', async () => {
    const bodies: string[] = [];
    const src = new SqlSource({
      httpOrigin: 'http://127.0.0.1:3000',
      moduleName: 'arkart',
      fetchImpl: recordingFetch(bodies, () => ({ rows: [] })),
    });
    await src.poll();

    assert.equal(bodies.length, 4, 'one request per table');
    for (const b of bodies) {
      assert.equal(
        b.split(';').filter((s) => s.trim().length > 0).length,
        1,
        `multi-statement body would 400: ${JSON.stringify(b)}`,
      );
    }
    assert.deepEqual(bodies.sort(), [
      'SELECT * FROM config',
      'SELECT * FROM effect',
      'SELECT * FROM input',
      'SELECT * FROM kart',
    ]);
  });

  it('keeps results positional regardless of which response returns first', async () => {
    const bodies: string[] = [];
    const src = new SqlSource({
      httpOrigin: 'http://127.0.0.1:3000',
      moduleName: 'arkart',
      fetchImpl: recordingFetch(bodies, (sql) => {
        if (sql.includes('config')) {
          return {
            schema: { elements: [{ name: { some: 'lap_count' } }, { name: { some: 'state' } }] },
            rows: [[3, 'running']],
          };
        }
        if (sql.includes('input')) {
          return {
            schema: {
              elements: [
                { name: { some: 'kart_id' } },
                { name: { some: 'throttle' } },
                { name: { some: 'steer' } },
                { name: { some: 'updated_at' } },
              ],
            },
            rows: [[2, 0.5, -1, [1789894296001911]]],
          };
        }
        return { rows: [] };
      }),
    });
    await src.poll();

    const snap = src.snapshot();
    assert.equal(snap.config?.state, 'running', 'config landed in the config slot');
    assert.equal(snap.inputs.get(2)?.throttle, 0.5, 'input landed in the input slot');
    assert.equal(snap.inputs.get(2)?.updatedAt, 1_789_894_296_001);
    assert.equal(src.isConnected(), true);
  });

  it('surfaces the server’s error text, including the multi-statement 400', async () => {
    const failing = (async () =>
      ({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: async () => [],
        text: async () => 'Multiple SQL statements are not supported',
      }) as unknown as Response) as unknown as typeof fetch;

    const src = new SqlSource({
      httpOrigin: 'http://127.0.0.1:3000',
      moduleName: 'arkart',
      fetchImpl: failing,
    });
    await assert.rejects(() => src.poll(), /400 Bad Request.*Multiple SQL statements are not supported/s);
    assert.equal(src.isConnected(), false);
  });

  it('builds the documented endpoint URL', () => {
    const src = new SqlSource({ httpOrigin: 'http://127.0.0.1:3000', moduleName: 'arkart' });
    assert.equal(src.url, 'http://127.0.0.1:3000/v1/database/arkart/sql');
  });
});

// --------------------------------------------------------------------------
// D1
// --------------------------------------------------------------------------

describe('SpacetimeSource — builder API drift (D1)', () => {
  it('uses SDK 2.4.1’s withDatabaseName and actually passes the module name', async () => {
    const fixture = await import('./fixtures/fake-bindings.ts');
    fixture.reset();

    const src = new SpacetimeSource({
      uri: 'ws://localhost:3000',
      moduleName: 'arkart',
      bindingsPath: './fixtures/fake-bindings.ts',
      baseUrl: import.meta.url,
      onLog: () => {},
    });
    await src.start();

    assert.equal(fixture.calls.databaseName, 'arkart', 'the rename must NOT be silently skipped');
    assert.equal(fixture.calls.uri, 'ws://localhost:3000');
    assert.equal(fixture.calls.built, true);
    assert.deepEqual(fixture.calls.subscriptions, [
      'SELECT * FROM config',
      'SELECT * FROM kart',
      'SELECT * FROM input',
      'SELECT * FROM effect',
    ]);
    assert.equal(src.isConnected(), true);

    // and the rows come through the normaliser into the rule engine's shape
    const snap = src.snapshot();
    assert.equal(snap.config?.state, 'running');
    assert.equal(snap.inputs.get(1)?.throttle, 1);
    assert.equal(snap.inputs.get(1)?.updatedAt, 1_789_894_296_001);
    assert.equal(snap.effects[0]?.kind, 'shield');
    assert.equal(snap.karts[0]?.ip, '192.168.8.101');
    await src.stop();
  });

  it('still falls back to SDK 1.x’s withModuleName', async () => {
    const fixture = await import('./fixtures/legacy-bindings.ts');
    const src = new SpacetimeSource({
      uri: 'ws://localhost:3000',
      moduleName: 'arkart',
      bindingsPath: './fixtures/legacy-bindings.ts',
      baseUrl: import.meta.url,
      onLog: () => {},
    });
    await src.start();
    assert.equal(fixture.calls.moduleName, 'arkart');
    await src.stop();
  });

  it('fails LOUDLY, naming both spellings, when the builder has neither', async () => {
    const src = new SpacetimeSource({
      uri: 'ws://localhost:3000',
      moduleName: 'arkart',
      bindingsPath: './fixtures/broken-bindings.ts',
      baseUrl: import.meta.url,
      onLog: () => {},
    });
    await assert.rejects(() => src.start(), (err: Error) => {
      assert.match(err.message, /withDatabaseName/);
      assert.match(err.message, /withModuleName/);
      assert.match(err.message, /SDK API drift/);
      assert.match(err.message, /Methods it does have: .*withUri/);
      return true;
    });
  });

  it('gives an actionable error when the bindings are missing entirely', async () => {
    const src = new SpacetimeSource({
      uri: 'ws://localhost:3000',
      moduleName: 'arkart',
      bindingsPath: './fixtures/does-not-exist.ts',
      baseUrl: import.meta.url,
      onLog: () => {},
    });
    await assert.rejects(() => src.start(), /spacetime generate|could not load/i);
  });
});

describe('describeMethods', () => {
  it('lists own and prototype methods, sorted', () => {
    class Builder {
      withUri(): void {}
      build(): void {}
    }
    assert.equal(describeMethods(new Builder()), 'build, withUri');
    assert.equal(describeMethods({ a: () => {}, b: 1 }), 'a');
    assert.equal(describeMethods(null), '<none>');
    assert.equal(describeMethods({}), '<none>');
  });
});
