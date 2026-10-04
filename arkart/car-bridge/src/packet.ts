/**
 * The 8-byte AR Kart control packet.
 *
 * CONDUCTOR-DICTATED WIRE CONTRACT (the ESP32 firmware implements the same):
 *
 *   offset  size  field     encoding
 *   ------  ----  --------  ----------------------------------------------
 *     0      1    magic0    'A' = 0x41
 *     1      1    magic1    'K' = 0x4B
 *     2      1    kart_id   u8
 *     3      1    throttle  u8, 0..255
 *     4      1    steer     i8, -127..127 (two's complement)
 *     5      1    flags     u8 bitfield; bit0 = shield LED
 *    6-7     2    seq       u16 LITTLE-ENDIAN, monotonically increasing
 *
 * Total: exactly 8 bytes. No padding, no trailer.
 */

export const PACKET_SIZE = 8;

export const MAGIC_0 = 0x41; // 'A'
export const MAGIC_1 = 0x4b; // 'K'

/** flags bit0 — drives the WS2812 shield LED on GPIO 48 (cyan while shielded). */
export const FLAG_SHIELD = 0x01;

/** Full-scale steer magnitude on the wire (i8). */
export const STEER_FULL_SCALE = 127;

export const MAX_THROTTLE = 255;
export const SEQ_MODULUS = 0x10000; // u16 wraps at 65536

export interface PacketFields {
  kartId: number;
  /** u8 0..255 */
  throttle: number;
  /** i8 -127..127 */
  steer: number;
  /** u8 bitfield */
  flags: number;
  /** u16, wraps */
  seq: number;
}

function requireInt(name: string, value: number): number {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be a finite number, got ${value}`);
  if (!Number.isInteger(value)) throw new RangeError(`${name} must be an integer, got ${value}`);
  return value;
}

function requireRange(name: string, value: number, lo: number, hi: number): number {
  requireInt(name, value);
  if (value < lo || value > hi) {
    throw new RangeError(`${name} out of range [${lo}, ${hi}]: ${value}`);
  }
  return value;
}

/**
 * Encode one control packet. Strict: every field must already be an integer in
 * range — the logic layer is responsible for clamping/quantising, so anything
 * out of range here is a bug we want loud, not silently truncated.
 *
 * `seq` is taken modulo 2^16 (wraparound is legal and expected).
 */
export function encodePacket(f: PacketFields): Buffer {
  requireRange('kartId', f.kartId, 0, 255);
  requireRange('throttle', f.throttle, 0, MAX_THROTTLE);
  requireRange('steer', f.steer, -STEER_FULL_SCALE, STEER_FULL_SCALE);
  requireRange('flags', f.flags, 0, 255);
  requireInt('seq', f.seq);
  if (f.seq < 0) throw new RangeError(`seq must be non-negative, got ${f.seq}`);

  const buf = Buffer.allocUnsafe(PACKET_SIZE);
  buf[0] = MAGIC_0;
  buf[1] = MAGIC_1;
  buf.writeUInt8(f.kartId, 2);
  buf.writeUInt8(f.throttle, 3);
  buf.writeInt8(f.steer, 4); // two's complement for negatives
  buf.writeUInt8(f.flags, 5);
  buf.writeUInt16LE(f.seq % SEQ_MODULUS, 6);
  return buf;
}

/** Inverse of {@link encodePacket} — used by the tests and the `listen` tool. */
export function decodePacket(buf: Buffer): PacketFields {
  if (buf.length !== PACKET_SIZE) {
    throw new RangeError(`expected ${PACKET_SIZE} bytes, got ${buf.length}`);
  }
  if (buf[0] !== MAGIC_0 || buf[1] !== MAGIC_1) {
    throw new RangeError(`bad magic: ${buf[0]?.toString(16)} ${buf[1]?.toString(16)}`);
  }
  return {
    kartId: buf.readUInt8(2),
    throttle: buf.readUInt8(3),
    steer: buf.readInt8(4),
    flags: buf.readUInt8(5),
    seq: buf.readUInt16LE(6),
  };
}

/**
 * Per-kart monotonically increasing u16 sequence counter.
 * Monotone within a wrap window; wraps 65535 -> 0 as the u16 contract allows.
 */
export class SeqCounter {
  #next: number;

  constructor(start = 0) {
    this.#next = ((start % SEQ_MODULUS) + SEQ_MODULUS) % SEQ_MODULUS;
  }

  /** Current value that `next()` will return. */
  peek(): number {
    return this.#next;
  }

  next(): number {
    const v = this.#next;
    this.#next = (v + 1) % SEQ_MODULUS;
    return v;
  }
}
