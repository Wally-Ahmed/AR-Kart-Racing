/** The 50 Hz loop end-to-end: snapshot -> rules -> packet -> sink. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Bridge } from '../src/bridge.ts';
import type { KartAddress } from '../src/config.ts';
import { decodePacket, FLAG_SHIELD, SEQ_MODULUS } from '../src/packet.ts';
import { ParkableSource } from '../src/sources/park.ts';
import { MutableSource } from '../src/sources/sim.ts';
import { NullSink } from '../src/udp.ts';
import type { EffectRow, RaceState, WorldSnapshot } from '../src/types.ts';

const NOW = 1_700_000_000_000;

const ADDRESSES = new Map<number, KartAddress>([
  [1, { kartId: 1, name: 'kart-1', ip: '192.168.8.101', port: 7777, configured: true }],
  [2, { kartId: 2, name: 'kart-2', ip: '192.168.8.102', port: 7777, configured: true }],
]);

function world(state: RaceState, inputs: Array<[number, number, number]>, effects: EffectRow[] = []): WorldSnapshot {
  const snap: WorldSnapshot = {
    config: { lapCount: 3, itemRollPct: 100, state, countdownEndsAt: null },
    karts: [],
    inputs: new Map(),
    effects,
  };
  for (const [kartId, throttle, steer] of inputs) {
    snap.inputs.set(kartId, { kartId, throttle, steer, updatedAt: NOW });
  }
  return snap;
}

function makeBridge(snapshot: WorldSnapshot): { bridge: Bridge; sink: NullSink; source: MutableSource } {
  const source = new MutableSource(snapshot);
  const sink = new NullSink();
  return { bridge: new Bridge({ addresses: ADDRESSES, source, sink }), sink, source };
}

describe('Bridge', () => {
  it('sends one 8-byte packet per kart per tick, to the right address', () => {
    const { bridge, sink } = makeBridge(world('running', [[1, 1, 0], [2, 0.5, -1]]));
    bridge.tick(NOW);

    assert.equal(sink.packets.length, 2);
    for (const p of sink.packets) assert.equal(p.buf.length, 8);

    const p1 = sink.packets[0]!;
    const p2 = sink.packets[1]!;
    assert.equal(p1.addr.ip, '192.168.8.101');
    assert.equal(p1.addr.port, 7777);
    assert.equal(p2.addr.ip, '192.168.8.102');

    assert.deepEqual(decodePacket(p1.buf), { kartId: 1, throttle: 255, steer: 0, flags: 0, seq: 0 });
    assert.deepEqual(decodePacket(p2.buf), { kartId: 2, throttle: 128, steer: -127, flags: 0, seq: 0 });
  });

  it('each kart carries its own monotonically increasing sequence', () => {
    const { bridge, sink } = makeBridge(world('running', [[1, 0, 0], [2, 0, 0]]));
    for (let i = 0; i < 5; i++) bridge.tick(NOW + i * 20);

    const seqs = new Map<number, number[]>();
    for (const p of sink.packets) {
      const d = decodePacket(p.buf);
      const list = seqs.get(d.kartId) ?? [];
      list.push(d.seq);
      seqs.set(d.kartId, list);
    }
    assert.deepEqual(seqs.get(1), [0, 1, 2, 3, 4]);
    assert.deepEqual(seqs.get(2), [0, 1, 2, 3, 4]);
    assert.equal(bridge.ticks, 5);
    assert.equal(bridge.peekSeq(1), 5);
  });

  it('sequence wraps 65535 -> 0 on the wire without a gap', () => {
    const { bridge, sink } = makeBridge(world('running', [[1, 0, 0], [2, 0, 0]]));
    // Burn through to just short of the wrap using only public behaviour.
    for (let i = 0; i < SEQ_MODULUS - 1; i++) {
      bridge.tick(NOW);
      sink.packets.length = 0; // keep the recorder from growing to 131k buffers
    }
    assert.equal(bridge.peekSeq(1), SEQ_MODULUS - 1);
    bridge.tick(NOW);
    bridge.tick(NOW);
    const forKart1 = sink.packets.filter((p) => decodePacket(p.buf).kartId === 1);
    assert.equal(decodePacket(forKart1[0]!.buf).seq, 65535);
    assert.equal(decodePacket(forKart1[1]!.buf).seq, 0);
    assert.equal(forKart1[0]!.buf.subarray(6, 8).toString('hex'), 'ffff');
    assert.equal(forKart1[1]!.buf.subarray(6, 8).toString('hex'), '0000');
  });

  it('kill switch: flipping the race out of running parks both karts on the next tick', () => {
    const { bridge, sink, source } = makeBridge(world('running', [[1, 1, 1], [2, 1, 1]]));
    bridge.tick(NOW);
    assert.equal(decodePacket(sink.packets[0]!.buf).throttle, 255);

    source.set(world('lobby', [[1, 1, 1], [2, 1, 1]]));
    sink.packets.length = 0;
    bridge.tick(NOW);
    for (const p of sink.packets) {
      const d = decodePacket(p.buf);
      assert.equal(d.throttle, 0, `kart ${d.kartId} must be parked`);
      assert.equal(d.steer, 0);
    }
  });

  it('effects reach the wire: shield LED bit and stun', () => {
    const effects: EffectRow[] = [
      { id: 1, kartId: 1, kind: 'shield', multiplier: 1, expiresAt: null },
      { id: 2, kartId: 2, kind: 'stun', multiplier: 1, expiresAt: NOW + 1000 },
    ];
    const { bridge, sink } = makeBridge(world('running', [[1, 1, 0], [2, 1, 0]], effects));
    bridge.tick(NOW);

    const d1 = decodePacket(sink.packets[0]!.buf);
    const d2 = decodePacket(sink.packets[1]!.buf);
    assert.equal(d1.flags, FLAG_SHIELD);
    assert.equal(d1.throttle, 255);
    assert.equal(d2.flags, 0);
    assert.equal(d2.throttle, 0, 'stunned');
  });

  it('shutdown park: zeroes every kart WITHOUT restarting the sequence', () => {
    const inner = new MutableSource(world('running', [[1, 1, 1], [2, 1, 1]]));
    const source = new ParkableSource(inner);
    const sink = new NullSink();
    const bridge = new Bridge({ addresses: ADDRESSES, source, sink });

    for (let i = 0; i < 4; i++) bridge.tick(NOW);
    assert.equal(decodePacket(sink.packets.at(-1)!.buf).throttle, 255);
    sink.packets.length = 0;

    source.park();
    for (let i = 0; i < 3; i++) bridge.tick(NOW);

    assert.equal(sink.packets.length, 6, '3 park packets per kart');
    const kart1 = sink.packets.map((p) => decodePacket(p.buf)).filter((d) => d.kartId === 1);
    assert.deepEqual(
      kart1.map((d) => d.seq),
      [4, 5, 6],
      'sequence continues past the live packets, so strict-ordering firmware accepts the stop',
    );
    for (const d of kart1) {
      assert.equal(d.throttle, 0);
      assert.equal(d.steer, 0);
      assert.equal(d.flags, 0);
    }
  });

  it('a kart in karts.json with no rows anywhere still gets a parked packet', () => {
    const empty: WorldSnapshot = { config: null, karts: [], inputs: new Map(), effects: [] };
    const { bridge, sink } = makeBridge(empty);
    bridge.tick(NOW);
    assert.equal(sink.packets.length, 2);
    for (const p of sink.packets) {
      assert.deepEqual(decodePacket(p.buf).throttle, 0);
      assert.deepEqual(decodePacket(p.buf).flags, 0);
    }
  });
});
