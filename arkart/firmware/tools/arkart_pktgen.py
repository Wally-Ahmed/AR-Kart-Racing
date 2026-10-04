#!/usr/bin/env python3
"""arkart_pktgen.py — laptop-side generator for the AR Kart 8-byte control packet.

Stands in for the car bridge: same wire format, same 50 Hz cadence, same kill switch.
Byte layout is car-bridge/src/packet.ts's, which is authoritative:

    [0]'A' [1]'K' [2]kart_id u8 [3]throttle u8 0..255 [4]steer i8 [5]flags u8
    [6..7] seq u16 LITTLE-ENDIAN

flags bit0 = shield (cyan WS2812). flags bit1 = reverse, which the firmware's button-tap net
layer reads as "hold BACK instead of FWD" — the real bridge never sets it, so --thr is accepted
SIGNED here and a negative value is sent as magnitude + bit1, exactly like the on-board
`netpkt -120` test command.

examples
    # hold full forward for 2 s at 50 Hz
    arkart_pktgen.py --host 192.168.1.50 --thr 255 --duration 2
    # half throttle, so the firmware's chop shaping is visible in `btnstat`
    arkart_pktgen.py --host 192.168.1.50 --thr 128 --duration 2
    # reverse
    arkart_pktgen.py --host 192.168.1.50 --thr -120 --duration 2
    # steer right, no throttle
    arkart_pktgen.py --host 192.168.1.50 --steer 100 --duration 2
    # kill switch: the bridge zeroes throttle when the race is not running
    arkart_pktgen.py --host 192.168.1.50 --thr 0 --duration 1
    # shield on (flags bit0)
    arkart_pktgen.py --host 192.168.1.50 --thr 0 --shield --duration 2
    # ONE packet with a fixed, already-used sequence number -> must be dropped as stale
    arkart_pktgen.py --host 192.168.1.50 --thr 255 --count 1 --seq 3 --freeze-seq
    # bind a fixed source port so the firmware's per-source seq filter sees one source
    arkart_pktgen.py --host 192.168.1.50 --thr 255 --duration 2 --src-port 7778
"""
import argparse
import socket
import struct
import sys
import time

MAGIC = b"AK"
FLAG_SHIELD = 0x01
FLAG_REVERSE = 0x02


def encode(kart_id, throttle, steer, flags, seq):
    return MAGIC + struct.pack("<BBbBH", kart_id & 0xFF, throttle & 0xFF,
                               steer, flags & 0xFF, seq & 0xFFFF)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", required=True, help="the kart's IP on the LAN")
    ap.add_argument("--port", type=int, default=7777)
    ap.add_argument("--kart", type=int, default=1, help="kart_id, byte 2 (default 1)")
    ap.add_argument("--thr", type=int, default=0,
                    help="SIGNED -255..255; negative = reverse (flags bit1)")
    ap.add_argument("--steer", type=int, default=0, help="-127..127, + = right")
    ap.add_argument("--flags", type=lambda v: int(v, 0), default=0, help="raw flags byte")
    ap.add_argument("--shield", action="store_true", help="OR in flags bit0")
    ap.add_argument("--reverse", action="store_true", help="OR in flags bit1")
    ap.add_argument("--hz", type=float, default=50.0)
    ap.add_argument("--duration", type=float, default=None, help="seconds to hold (default 1)")
    ap.add_argument("--count", type=int, default=None, help="send exactly N packets instead")
    ap.add_argument("--seq", type=int, default=0, help="first sequence number")
    ap.add_argument("--freeze-seq", action="store_true",
                    help="do not advance seq — every packet carries --seq (stale/dup test)")
    ap.add_argument("--src-port", type=int, default=None,
                    help="bind this local UDP port, so the kart sees one stable source")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args()

    if not -255 <= a.thr <= 255:
        sys.exit("--thr must be -255..255")
    if not -127 <= a.steer <= 127:
        sys.exit("--steer must be -127..127")

    throttle = abs(a.thr)
    flags = a.flags
    if a.shield:
        flags |= FLAG_SHIELD
    if a.reverse or a.thr < 0:
        flags |= FLAG_REVERSE

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    if a.src_port is not None:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("", a.src_port))

    total = a.count if a.count is not None else None
    dur = a.duration if a.duration is not None else (None if total else 1.0)
    period = 1.0 / a.hz if a.hz > 0 else 0.0
    dst = (a.host, a.port)

    if not a.quiet:
        tags = []
        if flags & FLAG_SHIELD:
            tags.append("SHIELD")
        if flags & FLAG_REVERSE:
            tags.append("REVERSE")
        print(f"-> {a.host}:{a.port} kart {a.kart}  thr {throttle} steer {a.steer:+d} "
              f"flags 0x{flags:02x}{' ' + '+'.join(tags) if tags else ''}  "
              f"seq from {a.seq}{' FROZEN' if a.freeze_seq else ''}  "
              f"{a.hz:g} Hz  {('%g s' % dur) if dur else ('%d packets' % total)}")

    seq = a.seq
    sent = 0
    t0 = time.time()
    next_at = t0
    while True:
        if total is not None and sent >= total:
            break
        if dur is not None and (time.time() - t0) >= dur:
            break
        sock.sendto(encode(a.kart, throttle, a.steer, flags, seq), dst)
        sent += 1
        if not a.freeze_seq:
            seq = (seq + 1) & 0xFFFF
        next_at += period
        sleep = next_at - time.time()
        if sleep > 0:
            time.sleep(sleep)
        else:
            next_at = time.time()

    if not a.quiet:
        print(f"sent {sent} packets in {time.time() - t0:.2f} s; next seq would be {seq}")


if __name__ == "__main__":
    main()
