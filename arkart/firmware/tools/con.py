#!/usr/bin/env python3
"""Drive the AR Kart bench console on /dev/cu.usbserial-10 and print the transcript.

Project gotchas honoured:
  - the usbserial-* bridge port is the only one whose INPUT reaches the firmware;
  - the port is opened with rts=False / dtr=False so the board is NOT reset;
  - macOS has no `timeout`, so all waiting is done here.

usage:  con.py [--port P] [--settle S] [--read R] ITEM [ITEM ...]
        ITEM = a console line to send, or '@<seconds>' to wait that long.
        Consecutive non-@ items are written in ONE write, so the firmware
        processes them back to back (useful when the 300 ms control watchdog
        must not expire between a packet and a `btnstat`).
"""
import argparse
import sys
import time

import serial

ap = argparse.ArgumentParser()
ap.add_argument("--port", default="/dev/cu.usbserial-10")
ap.add_argument("--settle", type=float, default=2.0, help="wait after open before sending")
ap.add_argument("--read", type=float, default=1.5, help="read this long after the last item")
ap.add_argument("--no-drain", action="store_true", help="keep the pre-command backlog")
ap.add_argument("items", nargs="+")
a = ap.parse_args()

s = serial.Serial()
s.port = a.port
s.baudrate = 115200
s.rtscts = False
s.dsrdtr = False
s.timeout = 0.05
s.open()
s.rts = False
s.dtr = False

out = bytearray()


def pump(seconds):
    end = time.time() + seconds
    while time.time() < end:
        n = s.in_waiting
        if n:
            out.extend(s.read(n))
        else:
            time.sleep(0.01)


pump(a.settle)
if not a.no_drain:
    out.clear()

batch = []


def flush_batch():
    if batch:
        s.write(("".join(line + "\r" for line in batch)).encode())
        s.flush()
        batch.clear()


for item in a.items:
    if item.startswith("@"):
        flush_batch()
        pump(float(item[1:]))
    else:
        batch.append(item)
flush_batch()
pump(a.read)
s.close()

sys.stdout.write(out.decode("utf-8", "replace"))
