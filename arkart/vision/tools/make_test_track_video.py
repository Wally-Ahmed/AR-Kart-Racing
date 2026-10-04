#!/usr/bin/env python3
"""Generate a synthetic FPV lap video — end-to-end bench test with no hardware.

Simulates a kart driving a 3-gate course for N laps: each gate's 36h11 tag grows
in the frame as the kart approaches, then disappears for the straight.

    python tools/make_test_track_video.py /tmp/track.avi --laps 2
    python -m arkart_vision.bridge --kart 1 --source /tmp/track.avi \
        --dry-run --fps 20 --seconds 20

Expected: exactly one GATE line per gate per lap, in order 0, 1, 2, 0, 1, 2, ...
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from arkart_vision.detector import render_tag  # noqa: E402

W, H = 640, 480


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("out", help="output .avi path")
    ap.add_argument("--laps", type=int, default=2)
    ap.add_argument("--gates", type=int, default=3, help="gate tag ids 0..gates-1")
    ap.add_argument("--fps", type=int, default=20)
    ap.add_argument("--dwell", type=int, default=8, help="frames the tag is in view")
    ap.add_argument("--straight", type=int, default=40, help="frames between gates")
    ap.add_argument(
        "--truth",
        default=None,
        help="also write the GROUND-TRUTH gate order to this JSON path. The generator "
        "is the only thing that knows the right answer, so an end-to-end check should "
        "assert against this file rather than a hand-copied list.",
    )
    args = ap.parse_args()

    writer = cv2.VideoWriter(args.out, cv2.VideoWriter_fourcc(*"MJPG"), args.fps, (W, H))
    if not writer.isOpened():
        raise SystemExit(f"cannot open VideoWriter for {args.out}")

    def blank() -> np.ndarray:
        return np.full((H, W, 3), 200, np.uint8)

    def with_tag(tag_id: int, scale: float) -> np.ndarray:
        frame = blank()
        tag = cv2.cvtColor(render_tag(tag_id, side_px=180, border_px=40), cv2.COLOR_GRAY2BGR)
        side = max(24, int(tag.shape[0] * scale))
        tag = cv2.resize(tag, (side, side))
        y, x = (H - side) // 2, (W - side) // 2
        frame[y:y + side, x:x + side] = tag
        return frame

    total = 0
    truth: list[int] = []
    for _lap in range(args.laps):
        for gate in range(args.gates):
            truth.append(gate)                   # <- the ground truth, recorded as written
            for i in range(args.dwell):          # approaching: tag grows
                writer.write(with_tag(gate, 0.6 + 0.05 * i))
                total += 1
            for _ in range(args.straight):       # the straight: nothing in view
                writer.write(blank())
                total += 1
    writer.release()

    duration_s = total / args.fps
    if args.truth:
        Path(args.truth).write_text(
            json.dumps(
                {
                    "video": str(args.out),
                    "laps": args.laps,
                    "gates": args.gates,
                    "fps": args.fps,
                    "dwell": args.dwell,
                    "straight": args.straight,
                    "frames": total,
                    "duration_s": round(duration_s, 3),
                    "gate_order": truth,
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        print(f"{args.truth}: ground truth = {truth}")

    print(
        f"{args.out}: {total} frames @ {args.fps} fps "
        f"({duration_s:.1f}s), {args.laps} laps x {args.gates} gates "
        f"-> expect {args.laps * args.gates} gate passes"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
