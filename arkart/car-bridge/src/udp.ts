/** UDP plumbing: one socket, N karts, fire-and-forget at 50 Hz. */

import { createSocket, type Socket } from 'node:dgram';
import type { KartAddress } from './config.ts';

export interface PacketSink {
  send(buf: Buffer, addr: KartAddress): void;
  close(): Promise<void>;
}

/** Real UDP sender. Errors are counted, never thrown — a dropped datagram is
 *  expected and the firmware watchdog covers a sustained outage. A kart whose
 *  address is still a placeholder (`configured: false`) is skipped outright. */
export class UdpSink implements PacketSink {
  #socket: Socket | null = null;
  #errors = 0;
  #sent = 0;
  #skipped = 0;
  readonly #warned = new Set<number>();

  constructor() {
    const sock = createSocket('udp4');
    sock.on('error', () => {
      this.#errors += 1;
    });
    sock.unref(); // never keep the process alive on the socket alone
    this.#socket = sock;
  }

  send(buf: Buffer, addr: KartAddress): void {
    const sock = this.#socket;
    if (sock === null) return;
    // A placeholder address is not a transient failure, so do not retry it at
    // 50 Hz: say so once, then drop this kart's datagrams on the floor. The
    // bridge keeps computing and sequencing for it, so filling the real IP into
    // karts.json and restarting is the only step left.
    if (!addr.configured) {
      this.#skipped += 1;
      if (!this.#warned.has(addr.kartId)) {
        this.#warned.add(addr.kartId);
        console.warn(
          `[udp] kart ${addr.kartId} (${addr.name}) has no address yet — ` +
            `"${addr.ip}" is a placeholder, so nothing is transmitted to it. ` +
            `Put the board's LAN IP in karts.json and restart.`,
        );
      }
      return;
    }
    sock.send(buf, addr.port, addr.ip, (err) => {
      if (err) this.#errors += 1;
      else this.#sent += 1;
    });
  }

  get stats(): { sent: number; errors: number; skipped: number } {
    return { sent: this.#sent, errors: this.#errors, skipped: this.#skipped };
  }

  close(): Promise<void> {
    const sock = this.#socket;
    this.#socket = null;
    if (sock === null) return Promise.resolve();
    return new Promise((res) => sock.close(() => res()));
  }
}

/** Drops everything. Used by `BRIDGE_DRY_RUN=1` and by the tests. */
export class NullSink implements PacketSink {
  readonly packets: Array<{ buf: Buffer; addr: KartAddress }> = [];

  send(buf: Buffer, addr: KartAddress): void {
    this.packets.push({ buf: Buffer.from(buf), addr });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
