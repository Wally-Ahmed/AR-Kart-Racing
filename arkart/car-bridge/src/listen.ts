/**
 * Debug listener: stand in for a kart and print what the bridge is sending.
 *
 *   npm run listen            # binds 0.0.0.0:7777
 *   LISTEN_PORT=7778 npm run listen
 *
 * Useful for firmware bring-up (point a kart's karts.json entry at the laptop)
 * and for proving the wire format without an ESP32 on the bench.
 */

import { createSocket } from 'node:dgram';
import { decodePacket, FLAG_SHIELD } from './packet.ts';

const port = Number(process.env.LISTEN_PORT ?? 7777);
const sock = createSocket('udp4');
let count = 0;
const lastSeq = new Map<number, number>();

sock.on('message', (msg, rinfo) => {
  count += 1;
  try {
    const p = decodePacket(msg);
    const prev = lastSeq.get(p.kartId);
    const gap = prev === undefined ? '' : ` (+${(p.seq - prev + 0x10000) % 0x10000})`;
    lastSeq.set(p.kartId, p.seq);
    if (count % 25 === 1 || (prev !== undefined && (p.seq - prev + 0x10000) % 0x10000 !== 1)) {
      console.log(
        `#${count} from ${rinfo.address} kart=${p.kartId} thr=${p.throttle} steer=${p.steer} ` +
          `flags=0x${p.flags.toString(16).padStart(2, '0')}${p.flags & FLAG_SHIELD ? ' SHIELD' : ''} ` +
          `seq=${p.seq}${gap} raw=${msg.toString('hex')}`,
      );
    }
  } catch (err) {
    console.log(`#${count} BAD PACKET from ${rinfo.address}: ${msg.toString('hex')} — ${(err as Error).message}`);
  }
});

sock.on('listening', () => {
  const a = sock.address();
  console.log(`[listen] udp ${a.address}:${a.port} — waiting for AK packets (Ctrl-C to stop)`);
});

sock.bind(port);
