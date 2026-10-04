/**
 * The 50 Hz loop: snapshot -> rule engine -> 8-byte packet -> UDP.
 *
 * `tick(nowMs)` is deterministic and side-effect-free apart from the injected
 * sink, so the whole daemon can be exercised in unit tests with a `NullSink`
 * and a fake {@link WorldSource}.
 */

import type { KartAddress } from './config.ts';
import { computeCommand, type LogicOptions } from './logic.ts';
import { encodePacket, SeqCounter } from './packet.ts';
import type { WorldSource } from './source.ts';
import type { CommandResult } from './types.ts';
import type { PacketSink } from './udp.ts';

export interface BridgeOptions extends LogicOptions {
  addresses: Map<number, KartAddress>;
  source: WorldSource;
  sink: PacketSink;
  tickHz?: number;
}

export interface TickRecord {
  kartId: number;
  addr: KartAddress;
  result: CommandResult;
  seq: number;
  packet: Buffer;
}

export class Bridge {
  readonly addresses: Map<number, KartAddress>;
  readonly source: WorldSource;
  readonly sink: PacketSink;
  readonly tickHz: number;
  readonly #seq = new Map<number, SeqCounter>();
  readonly #logicOpts: LogicOptions;
  #timer: NodeJS.Timeout | null = null;
  #ticks = 0;

  constructor(opts: BridgeOptions) {
    this.addresses = opts.addresses;
    this.source = opts.source;
    this.sink = opts.sink;
    this.tickHz = opts.tickHz ?? 50;
    this.#logicOpts = opts.staleMs === undefined ? {} : { staleMs: opts.staleMs };
    for (const kartId of this.addresses.keys()) this.#seq.set(kartId, new SeqCounter());
  }

  get ticks(): number {
    return this.#ticks;
  }

  /** Sequence number the next packet for this kart will carry. */
  peekSeq(kartId: number): number {
    return this.#seq.get(kartId)?.peek() ?? 0;
  }

  /** One pass over every configured kart. Returns what it sent, for logging/tests. */
  tick(nowMs: number = Date.now()): TickRecord[] {
    const snap = this.source.snapshot();
    const out: TickRecord[] = [];
    for (const [kartId, addr] of this.addresses) {
      const result = computeCommand(kartId, snap, nowMs, this.#logicOpts);
      let counter = this.#seq.get(kartId);
      if (counter === undefined) {
        counter = new SeqCounter();
        this.#seq.set(kartId, counter);
      }
      const seq = counter.next();
      const packet = encodePacket({ ...result.command, seq });
      this.sink.send(packet, addr);
      out.push({ kartId, addr, result, seq, packet });
    }
    this.#ticks += 1;
    return out;
  }

  /** Stop the timer but keep the sink and the sequence counters alive, so the
   *  shutdown path can still emit park packets that continue the sequence. */
  pause(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  start(): void {
    if (this.#timer !== null) return;
    const periodMs = 1000 / this.tickHz;
    this.#timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        // A bad row must never kill the loop; the karts would coast on the
        // firmware watchdog instead of being actively parked.
        console.error('[bridge] tick failed:', err);
      }
    }, periodMs);
  }

  async stop(): Promise<void> {
    this.pause();
    await this.sink.close();
  }
}
