/**
 * The SpacetimeDB seam: row normalisation, karts.json parsing, and the SQL
 * fallback's response decoding. Nothing here touches the network.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_KART_PORT,
  isRoutableTarget,
  type KartAddress,
  loadKartsFile,
  parseKartsFile,
  PACKAGE_ROOT,
  wsUriToHttpOrigin,
} from '../src/config.ts';
import { UdpSink } from '../src/udp.ts';
import {
  normalizeConfig,
  normalizeEffect,
  normalizeEffects,
  normalizeInput,
  normalizeKart,
  normalizeRaceState,
} from '../src/normalize.ts';
import { toEpochMillis } from '../src/source.ts';
import { resultToRows } from '../src/sources/sql.ts';
import { describeMethods } from '../src/sources/spacetime.ts';
import { computeCommand, isEffectActive } from '../src/logic.ts';
import { FLAG_SHIELD } from '../src/packet.ts';
import { resolve } from 'node:path';

describe('timestamp coercion', () => {
  it('accepts micros (bigint), micros (number), millis, and ISO', () => {
    assert.equal(toEpochMillis(1_700_000_000_000_000n), 1_700_000_000_000);
    assert.equal(toEpochMillis(1_700_000_000_000_000), 1_700_000_000_000);
    assert.equal(toEpochMillis(1_700_000_000_000), 1_700_000_000_000);
    assert.equal(toEpochMillis('2023-11-14T22:13:20.000Z'), 1_700_000_000_000);
    assert.equal(toEpochMillis(null), 0);
    assert.equal(toEpochMillis(undefined), 0);
  });

  it('unwraps the SDK Timestamp object', () => {
    assert.equal(toEpochMillis({ microsSinceUnixEpoch: 1_700_000_000_000_000n }), 1_700_000_000_000);
    assert.equal(toEpochMillis({ __timestamp_micros_since_unix_epoch__: 1_700_000_000_000_000 }), 1_700_000_000_000);
  });
});

describe('row normalisation', () => {
  it('reads snake_case (HTTP /sql) and camelCase (generated bindings) identically', () => {
    const snake = normalizeInput({ kart_id: 2, throttle: 0.5, steer: -0.25, updated_at: 1_700_000_000_000 });
    const camel = normalizeInput({ kartId: 2, throttle: 0.5, steer: -0.25, updatedAt: 1_700_000_000_000 });
    assert.deepEqual(snake, camel);
    assert.deepEqual(snake, { kartId: 2, throttle: 0.5, steer: -0.25, updatedAt: 1_700_000_000_000 });
  });

  it('config: tagged-enum state and Option countdown', () => {
    assert.deepEqual(
      normalizeConfig({ lap_count: 3, item_roll_pct: 100, state: { tag: 'Running' }, countdown_ends_at: { tag: 'none' } }),
      { lapCount: 3, itemRollPct: 100, state: 'running', countdownEndsAt: null },
    );
    assert.equal(normalizeRaceState('COUNTDOWN'), 'countdown');
    assert.equal(normalizeRaceState({ tag: 'Finished' }), 'finished');
  });

  it('an unknown race state falls back to lobby (karts parked), never to running', () => {
    assert.equal(normalizeRaceState('who-knows'), 'lobby');
    assert.equal(normalizeRaceState(undefined), 'lobby');
  });

  it('kart: Option pilot identity', () => {
    assert.deepEqual(normalizeKart({ kart_id: 1, name: 'k1', ip: '10.0.0.5', pilot_identity: { tag: 'none' } }), {
      kartId: 1,
      name: 'k1',
      ip: '10.0.0.5',
      pilotIdentity: null,
    });
    assert.equal(normalizeKart({ kartId: 1, name: 'k', ip: '', pilotIdentity: 'abc' }).pilotIdentity, 'abc');
  });

  it('effect: tagged kind, Option expiry, shield has none', () => {
    assert.deepEqual(normalizeEffect({ id: 7, kart_id: 1, kind: { tag: 'Shield' }, multiplier: 1, expires_at: null }), {
      id: 7,
      kartId: 1,
      kind: 'shield',
      multiplier: 1,
      expiresAt: null,
    });
    assert.deepEqual(normalizeEffect({ id: 8, kart_id: 2, kind: 'SLOW', multiplier: 0.5, expires_at: 1_700_000_005_000_000n }), {
      id: 8,
      kartId: 2,
      kind: 'slow',
      multiplier: 0.5,
      expiresAt: 1_700_000_005_000,
    });
  });

  it('an unrecognised effect kind is dropped, not guessed at', () => {
    assert.equal(normalizeEffect({ id: 9, kart_id: 1, kind: 'banana', multiplier: 0.1 }), null);
    const kept = normalizeEffects([
      { id: 1, kart_id: 1, kind: 'boost', multiplier: 1.5 },
      { id: 2, kart_id: 1, kind: 'banana', multiplier: 0.1 },
    ]);
    assert.equal(kept.length, 1);
    assert.equal(kept[0]?.kind, 'boost');
  });

  it('normalised rows drive the rule engine end to end', () => {
    const now = 1_700_000_000_000;
    const snap = {
      config: normalizeConfig({ lap_count: 3, item_roll_pct: 100, state: 'running', countdown_ends_at: null }),
      karts: [normalizeKart({ kart_id: 1, name: 'k1', ip: '10.0.0.5' })],
      inputs: new Map([[1, normalizeInput({ kart_id: 1, throttle: 1, steer: 0, updated_at: now * 1000 })]]),
      effects: normalizeEffects([
        { id: 1, kart_id: 1, kind: 'slow', multiplier: 0.5, expires_at: (now + 5000) * 1000 },
        { id: 2, kart_id: 1, kind: 'shield', multiplier: 1, expires_at: null },
      ]),
    };
    const r = computeCommand(1, snap, now);
    assert.equal(r.trace.cap, 0.5);
    assert.equal(r.command.throttle, 128); // round(0.5 * 255)
    assert.equal(r.command.flags, FLAG_SHIELD);
  });
});

/**
 * These payloads are copied VERBATIM from the live SpacetimeDB 2.4.1 HTTP /sql
 * endpoint (module `arkart`, 2026-09-20). They are the regression guard for the
 * positional SATS encoding that the tagged-object tests above do not exercise.
 */
describe('live /sql positional encoding (SpacetimeDB 2.4.1)', () => {
  const inputResult = {
    schema: {
      elements: [
        { name: { some: 'kart_id' } },
        { name: { some: 'throttle' } },
        { name: { some: 'steer' } },
        { name: { some: 'updated_at' } },
      ],
    },
    rows: [
      [1, 1.0, 1.0, [1789894296001911]],
      [2, 1.0, 1.0, [1789894296003426]],
    ],
  };

  it('decodes a Timestamp serialised positionally as [micros]', () => {
    const rows = resultToRows(inputResult).map(normalizeInput);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], {
      kartId: 1,
      throttle: 1,
      steer: 1,
      updatedAt: 1_789_894_296_001,
    });
    assert.notEqual(rows[0]?.updatedAt, 0, 'a 0 here makes every input read stale');
  });

  it('a live input row is NOT stale against its own timestamp', () => {
    const row = resultToRows(inputResult).map(normalizeInput)[0]!;
    const snap = {
      config: normalizeConfig({ lap_count: 3, item_roll_pct: 100, state: 'running', countdown_ends_at: [1, []] }),
      karts: [],
      inputs: new Map([[1, row]]),
      effects: [],
    };
    const r = computeCommand(1, snap, row.updatedAt + 100);
    assert.equal(r.trace.stale, false);
    assert.equal(r.command.throttle, 255, 'full stick must reach the wire');
  });

  it('decodes Option none serialised positionally as [1, []]', () => {
    const kartResult = {
      schema: {
        elements: [
          { name: { some: 'kart_id' } },
          { name: { some: 'name' } },
          { name: { some: 'ip' } },
          { name: { some: 'pilot_identity' } },
        ],
      },
      rows: [
        [1, 'Kart 1', '192.168.8.101', [1, []]],
        [2, 'Kart 2', '192.168.8.102', [1, []]],
      ],
    };
    const karts = resultToRows(kartResult).map(normalizeKart);
    assert.deepEqual(karts[0], { kartId: 1, name: 'Kart 1', ip: '192.168.8.101', pilotIdentity: null });
    assert.equal(karts[1]?.ip, '192.168.8.102');
  });

  it('config: state as a plain string, countdown as positional none', () => {
    const configResult = {
      schema: {
        elements: [
          { name: { some: 'id' } },
          { name: { some: 'lap_count' } },
          { name: { some: 'item_roll_pct' } },
          { name: { some: 'state' } },
          { name: { some: 'countdown_ends_at' } },
        ],
      },
      rows: [[0, 3, 100, 'lobby', [1, []]]],
    };
    const cfg = normalizeConfig(resultToRows(configResult)[0]!);
    assert.deepEqual(cfg, { lapCount: 3, itemRollPct: 100, state: 'lobby', countdownEndsAt: null });
  });

  it('decodes Option some serialised positionally as [0, [micros]] — effects DO expire', () => {
    const effectResult = {
      schema: {
        elements: [
          { name: { some: 'id' } },
          { name: { some: 'kart_id' } },
          { name: { some: 'kind' } },
          { name: { some: 'multiplier' } },
          { name: { some: 'expires_at' } },
          { name: { some: 'source_kart' } },
        ],
      },
      rows: [
        [1, 1, 'boost', 1.5, [0, [1789894296001911]], 2],
        [2, 1, 'shield', 1.0, [1, []], 1],
      ],
    };
    const effects = normalizeEffects(resultToRows(effectResult));
    assert.equal(effects.length, 2);
    assert.deepEqual(effects[0], {
      id: 1,
      kartId: 1,
      kind: 'boost',
      multiplier: 1.5,
      expiresAt: 1_789_894_296_001,
    });
    assert.equal(effects[1]?.expiresAt, null, 'shield has no expiry');

    // The whole point: a timed effect must actually expire.
    const at = effects[0]!.expiresAt!;
    assert.equal(isEffectActive(effects[0]!, at - 1), true, 'live before its expiry');
    assert.equal(isEffectActive(effects[0]!, at + 1), false, 'dead after it');
    assert.equal(isEffectActive(effects[1]!, at + 1e9), true, 'shield never times out');
  });

  it('an extra column the bridge does not know about (source_kart) is harmless', () => {
    const rows = resultToRows({
      schema: { elements: [{ name: { some: 'id' } }, { name: { some: 'kart_id' } }, { name: { some: 'kind' } }, { name: { some: 'multiplier' } }, { name: { some: 'expires_at' } }, { name: { some: 'source_kart' } }] },
      rows: [[7, 2, 'stun', 1.0, [1, []], 1]],
    });
    assert.deepEqual(normalizeEffect(rows[0]!), {
      id: 7,
      kartId: 2,
      kind: 'stun',
      multiplier: 1,
      expiresAt: null,
    });
  });
});

describe('karts.json', () => {
  it('parses the shipped file with ids 1 and 2 on port 7777', () => {
    const addrs = loadKartsFile(resolve(PACKAGE_ROOT, 'karts.json'));
    assert.deepEqual([...addrs.keys()].sort(), [1, 2]);
    for (const a of addrs.values()) {
      assert.equal(a.port, DEFAULT_KART_PORT);
      // Either a real dotted quad or the documented fill-this-in placeholder —
      // never silently empty, and never a half-edited string.
      const placeholder = a.ip === 'REAL_CAR_IP';
      if (!placeholder) assert.match(a.ip, /^\d+\.\d+\.\d+\.\d+$/);
      assert.equal(a.configured, !placeholder, `kart ${a.kartId}: ip "${a.ip}"`);
    }
  });

  it('the real car entry loads even though its address is a placeholder', () => {
    // The whole point: a board nobody has read a DHCP lease off yet must not
    // stop the bridge from starting for the kart that IS addressable.
    const addrs = loadKartsFile(resolve(PACKAGE_ROOT, 'karts.json'));
    const real = addrs.get(1);
    assert.ok(real, 'kart 1 is the real car and must be present');
    assert.equal(real.port, 7777, 'firmware contract §6 — udp:7777');
  });

  it('classifies routable targets vs fill-this-in placeholders', () => {
    for (const ip of ['192.168.8.101', '127.0.0.1', '10.0.0.7', '::1', 'arkart-1.local', 'kart.lan']) {
      assert.equal(isRoutableTarget(ip), true, ip);
    }
    for (const ip of ['REAL_CAR_IP', 'TODO', 'FILL_ME_IN', 'kart1']) {
      assert.equal(isRoutableTarget(ip), false, ip);
    }
  });

  it('UdpSink skips a placeholder kart instead of resolving it 50x a second', () => {
    const sink = new UdpSink();
    const buf = Buffer.alloc(8);
    const placeholder: KartAddress = {
      kartId: 1, name: 'kart-1-real', ip: 'REAL_CAR_IP', port: 7777, configured: false,
    };
    for (let i = 0; i < 25; i++) sink.send(buf, placeholder);
    assert.equal(sink.stats.skipped, 25);
    assert.equal(sink.stats.errors, 0, 'a placeholder is not an error, it is a no-op');
    assert.equal(sink.stats.sent, 0);
    void sink.close();
  });

  it('per-kart port overrides the file default', () => {
    const addrs = parseKartsFile({ port: 7777, karts: [{ kart_id: 1, ip: '1.2.3.4' }, { kart_id: 2, ip: '1.2.3.5', port: 9999 }] });
    assert.equal(addrs.get(1)?.port, 7777);
    assert.equal(addrs.get(2)?.port, 9999);
  });

  it('rejects malformed entries loudly', () => {
    assert.throws(() => parseKartsFile({ karts: [] }), /no karts/);
    assert.throws(() => parseKartsFile({ karts: [{ kart_id: 1 }] } as never), /no ip/);
    assert.throws(() => parseKartsFile({ karts: [{ kart_id: 300, ip: 'x' }] }), /u8/);
    assert.throws(() => parseKartsFile({ karts: [{ kart_id: 1, ip: 'a' }, { kart_id: 1, ip: 'b' }] }), /duplicate/);
    assert.throws(() => parseKartsFile({} as never), /karts/);
  });
});

describe('ws -> http origin', () => {
  it('maps the SPACETIME_URI default onto the HTTP API origin', () => {
    assert.equal(wsUriToHttpOrigin('ws://localhost:3000'), 'http://localhost:3000');
    assert.equal(wsUriToHttpOrigin('wss://stdb.example.com'), 'https://stdb.example.com');
    assert.equal(wsUriToHttpOrigin('ws://192.168.8.2:3000/'), 'http://192.168.8.2:3000');
  });
});

describe('SQL fallback response decoding', () => {
  it('zips columnar rows against the schema element names', () => {
    const result = {
      schema: { elements: [{ name: { some: 'kart_id' } }, { name: { some: 'throttle' } }, { name: { some: 'steer' } }] },
      rows: [[1, 0.5, -1], [2, 1, 0]],
    };
    assert.deepEqual(resultToRows(result), [
      { kart_id: 1, throttle: 0.5, steer: -1 },
      { kart_id: 2, throttle: 1, steer: 0 },
    ]);
  });

  it('passes object rows straight through', () => {
    const result = { rows: [{ kart_id: 1, throttle: 0.25 }] };
    assert.deepEqual(resultToRows(result), [{ kart_id: 1, throttle: 0.25 }]);
  });

  it('empty and missing results decode to no rows', () => {
    assert.deepEqual(resultToRows({ rows: [] }), []);
    assert.deepEqual(resultToRows({}), []);
    assert.deepEqual(resultToRows(undefined), []);
  });
});
