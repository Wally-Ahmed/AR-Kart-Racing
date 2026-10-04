/**
 * Golden byte-vectors for the 8-byte control packet.
 *
 * These ARE the wire contract. If the ESP32 firmware and this file ever
 * disagree, one of them is broken — nothing else in the system pins the format.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  decodePacket,
  encodePacket,
  FLAG_SHIELD,
  MAGIC_0,
  MAGIC_1,
  PACKET_SIZE,
  SEQ_MODULUS,
  SeqCounter,
  STEER_FULL_SCALE,
} from '../src/packet.ts';

const hex = (b: Buffer): string => b.toString('hex');

describe('packet layout', () => {
  it("magic is 'A' 'K' = 0x41 0x4b", () => {
    assert.equal(MAGIC_0, 0x41);
    assert.equal(MAGIC_1, 0x4b);
    assert.equal(MAGIC_0, 'A'.charCodeAt(0));
    assert.equal(MAGIC_1, 'K'.charCodeAt(0));
  });

  it('is exactly 8 bytes', () => {
    assert.equal(PACKET_SIZE, 8);
    const buf = encodePacket({ kartId: 1, throttle: 0, steer: 0, flags: 0, seq: 0 });
    assert.equal(buf.length, 8);
  });
});

describe('golden byte-vectors', () => {
  // Each case: exact expected bytes, written out by hand from the contract.
  const cases: Array<{ name: string; fields: Parameters<typeof encodePacket>[0]; bytes: number[] }> = [
    {
      name: 'all-zero kart 0',
      fields: { kartId: 0, throttle: 0, steer: 0, flags: 0, seq: 0 },
      bytes: [0x41, 0x4b, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
    },
    {
      name: 'kart 1, full throttle, hard right, no flags, seq 1',
      fields: { kartId: 1, throttle: 255, steer: 127, flags: 0, seq: 1 },
      bytes: [0x41, 0x4b, 0x01, 0xff, 0x7f, 0x00, 0x01, 0x00],
    },
    {
      name: 'kart 2, half throttle, hard LEFT (-127 two’s complement = 0x81)',
      fields: { kartId: 2, throttle: 128, steer: -127, flags: 0, seq: 2 },
      bytes: [0x41, 0x4b, 0x02, 0x80, 0x81, 0x00, 0x02, 0x00],
    },
    {
      name: 'steer -1 is 0xff (two’s complement)',
      fields: { kartId: 1, throttle: 0, steer: -1, flags: 0, seq: 0 },
      bytes: [0x41, 0x4b, 0x01, 0x00, 0xff, 0x00, 0x00, 0x00],
    },
    {
      name: 'steer -64 is 0xc0',
      fields: { kartId: 1, throttle: 10, steer: -64, flags: 0, seq: 0 },
      bytes: [0x41, 0x4b, 0x01, 0x0a, 0xc0, 0x00, 0x00, 0x00],
    },
    {
      name: 'shield flag sets bit0',
      fields: { kartId: 2, throttle: 0, steer: 0, flags: FLAG_SHIELD, seq: 0 },
      bytes: [0x41, 0x4b, 0x02, 0x00, 0x00, 0x01, 0x00, 0x00],
    },
    {
      name: 'seq 258 little-endian = 02 01',
      fields: { kartId: 1, throttle: 0, steer: 0, flags: 0, seq: 258 },
      bytes: [0x41, 0x4b, 0x01, 0x00, 0x00, 0x00, 0x02, 0x01],
    },
    {
      name: 'seq 65535 little-endian = ff ff',
      fields: { kartId: 1, throttle: 0, steer: 0, flags: 0, seq: 65535 },
      bytes: [0x41, 0x4b, 0x01, 0x00, 0x00, 0x00, 0xff, 0xff],
    },
    {
      name: 'seq 65536 wraps to 00 00',
      fields: { kartId: 1, throttle: 0, steer: 0, flags: 0, seq: 65536 },
      bytes: [0x41, 0x4b, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00],
    },
    {
      name: 'seq 65537 wraps to 01 00',
      fields: { kartId: 1, throttle: 0, steer: 0, flags: 0, seq: 65537 },
      bytes: [0x41, 0x4b, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00],
    },
    {
      name: 'kart 255, everything maxed, shield up, seq 0x1234',
      fields: { kartId: 255, throttle: 255, steer: 127, flags: 0x01, seq: 0x1234 },
      bytes: [0x41, 0x4b, 0xff, 0xff, 0x7f, 0x01, 0x34, 0x12],
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const got = encodePacket(c.fields);
      const want = Buffer.from(c.bytes);
      assert.equal(hex(got), hex(want), `got ${hex(got)} want ${hex(want)}`);
    });
  }

  it('seq is LITTLE-endian, not big-endian', () => {
    const buf = encodePacket({ kartId: 1, throttle: 0, steer: 0, flags: 0, seq: 0x0102 });
    assert.equal(buf[6], 0x02, 'low byte first');
    assert.equal(buf[7], 0x01, 'high byte second');
    assert.notEqual(hex(buf.subarray(6, 8)), '0102', 'must not be big-endian');
  });
});

describe('round-trip', () => {
  it('decodes what it encodes, across the full steer range', () => {
    for (let steer = -STEER_FULL_SCALE; steer <= STEER_FULL_SCALE; steer++) {
      const f = { kartId: 1, throttle: 42, steer, flags: 0, seq: 7 };
      assert.deepEqual(decodePacket(encodePacket(f)), f);
    }
  });

  it('decodes throttle across the full u8 range', () => {
    for (let throttle = 0; throttle <= 255; throttle++) {
      const f = { kartId: 2, throttle, steer: -5, flags: 1, seq: 9 };
      assert.deepEqual(decodePacket(encodePacket(f)), f);
    }
  });

  it('rejects a short buffer and bad magic', () => {
    assert.throws(() => decodePacket(Buffer.alloc(7)), RangeError);
    assert.throws(() => decodePacket(Buffer.alloc(8)), RangeError); // magic 00 00
  });
});

describe('field validation', () => {
  const base = { kartId: 1, throttle: 0, steer: 0, flags: 0, seq: 0 };
  it('rejects out-of-range fields rather than truncating them', () => {
    assert.throws(() => encodePacket({ ...base, throttle: 256 }), RangeError);
    assert.throws(() => encodePacket({ ...base, throttle: -1 }), RangeError);
    assert.throws(() => encodePacket({ ...base, steer: 128 }), RangeError);
    assert.throws(() => encodePacket({ ...base, steer: -128 }), RangeError);
    assert.throws(() => encodePacket({ ...base, kartId: 256 }), RangeError);
    assert.throws(() => encodePacket({ ...base, flags: 256 }), RangeError);
    assert.throws(() => encodePacket({ ...base, throttle: 1.5 }), RangeError);
    assert.throws(() => encodePacket({ ...base, throttle: NaN }), RangeError);
  });
});

describe('SeqCounter', () => {
  it('starts at 0 and increases monotonically', () => {
    const c = new SeqCounter();
    assert.equal(c.peek(), 0);
    assert.equal(c.next(), 0);
    assert.equal(c.next(), 1);
    assert.equal(c.next(), 2);
    assert.equal(c.peek(), 3);
  });

  it('wraps 65535 -> 0 exactly once per 2^16', () => {
    const c = new SeqCounter(SEQ_MODULUS - 2);
    assert.equal(c.next(), 65534);
    assert.equal(c.next(), 65535);
    assert.equal(c.next(), 0, 'u16 wraparound');
    assert.equal(c.next(), 1);
  });

  it('wrapped sequence still encodes little-endian correctly', () => {
    const c = new SeqCounter(65535);
    const a = encodePacket({ kartId: 1, throttle: 0, steer: 0, flags: 0, seq: c.next() });
    const b = encodePacket({ kartId: 1, throttle: 0, steer: 0, flags: 0, seq: c.next() });
    assert.equal(hex(a.subarray(6, 8)), 'ffff');
    assert.equal(hex(b.subarray(6, 8)), '0000');
  });
});
