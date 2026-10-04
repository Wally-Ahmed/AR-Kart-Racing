"""AR Kart vision bridge — main entrypoint.

One thread per kart. Each thread: MJPEG frames -> cv2.aruco 36h11 decode ->
per-(kart, tag) debounce -> POST report_gate to the local SpacetimeDB server.

The bridge only reports sightings; the module decides what a sighting means
(spec §7). That is why there is no game logic whatsoever in this file.

Run:
    python -m arkart_vision.bridge                 # uses ./karts.json
    python -m arkart_vision.bridge --display       # with detection overlay windows
    python -m arkart_vision.bridge --kart 1 --source 0 --dry-run   # webcam bench test
"""

from __future__ import annotations

import argparse
import logging
import signal
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Sequence

from . import config
from .debounce import GateDebouncer
from .detector import TagDetector
from .reducer import ReducerClient
from .stream import MJPEGStream

log = logging.getLogger("arkart.vision")

_STOP = threading.Event()


class KartWatcher:
    """One kart's detector loop."""

    def __init__(
        self,
        kart_id: int,
        source: str | int,
        *,
        client: ReducerClient | None,
        whitelist=config.TAG_WHITELIST,
        display: bool = False,
        label: str = "",
        fps_cap: float | None = None,
        loop_source: bool | None = None,
    ) -> None:
        self.kart_id = kart_id
        self.label = label or f"kart{kart_id}"
        self.client = client
        self.display = display
        self.min_frame_interval = (1.0 / fps_cap) if fps_cap else 0.0
        self.detector = TagDetector(whitelist=whitelist)
        self.debouncer = GateDebouncer(whitelist=whitelist)
        self.stream = MJPEGStream(source, label=self.label, loop_on_eof=loop_source)
        self.frames = 0
        self.passes = 0
        self._pool = ThreadPoolExecutor(
            max_workers=config.STDB_MAX_INFLIGHT, thread_name_prefix=f"post-{self.label}"
        )

    def _emit(self, kart_id: int, tag_id: int) -> None:
        self.passes += 1
        if self.client is None:
            log.info("[%s] DRY-RUN gate kart=%s tag=%s", self.label, kart_id, tag_id)
            return
        # Off the detector loop: a 1 s POST timeout must never cost us 15 frames.
        self._pool.submit(self.client.report_gate, kart_id, tag_id)

    def run(self) -> None:
        log.info("[%s] watching %s", self.label, self.stream.source)
        last_log = time.monotonic()
        last_frame_at = 0.0
        try:
            for frame in self.stream.frames():
                if _STOP.is_set():
                    break
                if self.min_frame_interval:
                    slack = self.min_frame_interval - (time.monotonic() - last_frame_at)
                    if slack > 0:
                        time.sleep(slack)
                now = time.monotonic()
                last_frame_at = now
                self.frames += 1

                if self.display:
                    corners, ids = self.detector.detect_with_corners(frame)
                    seen = set()
                    if ids is not None and len(ids):
                        seen = {int(i) for i in ids.flatten()}
                        if self.detector.whitelist is not None:
                            seen &= self.detector.whitelist
                    self._show(frame, corners, ids)
                else:
                    seen = self.detector.detect(frame)

                for gate_pass in self.debouncer.observe(self.kart_id, seen, now):
                    log.info(
                        "[%s] GATE tag=%s (frame %d)",
                        self.label,
                        gate_pass.tag_id,
                        self.frames,
                    )
                    self._emit(gate_pass.kart_id, gate_pass.tag_id)

                if now - last_log >= 10.0:
                    log.info(
                        "[%s] %d frames, %d passes, %d reconnects",
                        self.label,
                        self.frames,
                        self.passes,
                        self.stream.reconnects,
                    )
                    last_log = now
        except Exception:  # keep one kart's crash from taking the other down
            log.exception("[%s] detector loop died", self.label)
        finally:
            self.stream.stop()
            self._pool.shutdown(wait=False)
            log.info("[%s] stopped after %d frames / %d passes", self.label, self.frames, self.passes)

    def _show(self, frame, corners, ids) -> None:  # pragma: no cover - UI only
        import cv2

        vis = frame.copy()
        if ids is not None and len(ids):
            cv2.aruco.drawDetectedMarkers(vis, corners, ids)
        cv2.imshow(self.label, vis)
        if cv2.waitKey(1) & 0xFF == ord("q"):
            _STOP.set()

    def stop(self) -> None:
        self.stream.stop()


def build_watchers(args: argparse.Namespace) -> list[KartWatcher]:
    if args.source is not None:
        if args.kart is None:
            raise SystemExit("--source requires --kart")
        source: str | int = int(args.source) if str(args.source).isdigit() else args.source
        base_url, database = config.STDB_BASE_URL, config.STDB_DATABASE
        client = None if args.dry_run else ReducerClient(base_url=base_url, database=database)
        return [
            KartWatcher(
                int(args.kart),
                source,
                client=client,
                display=args.display,
                label=f"kart{args.kart}",
                fps_cap=args.fps,
                loop_source=True if args.loop_source else None,
            )
        ]

    cfg = config.load_config(args.config)
    client = (
        None
        if args.dry_run
        else ReducerClient(base_url=cfg.stdb_base_url, database=cfg.stdb_database)
    )
    karts = cfg.karts
    if args.kart is not None:
        karts = tuple(k for k in karts if k.kart_id == int(args.kart))
        if not karts:
            raise SystemExit(f"kart_id {args.kart} not in {args.config or config.DEFAULT_KARTS_FILE}")

    log.info(
        "STDB %s/v1/database/%s/call/report_gate%s",
        cfg.stdb_base_url,
        cfg.stdb_database,
        "  (DRY RUN — nothing posted)" if args.dry_run else "",
    )
    return [
        KartWatcher(
            k.kart_id,
            k.stream_url,
            client=client,
            whitelist=cfg.tag_whitelist,
            display=args.display,
            label=k.name or f"kart{k.kart_id}",
            fps_cap=args.fps,
            loop_source=True if args.loop_source else None,
        )
        for k in karts
    ]


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="arkart-vision", description=__doc__)
    p.add_argument("--config", default=None, help="path to karts.json (default: ./karts.json)")
    p.add_argument("--kart", default=None, help="only watch this kart_id")
    p.add_argument("--source", default=None, help="override stream URL, or a webcam index like 0")
    p.add_argument("--dry-run", action="store_true", help="log gates instead of POSTing them")
    p.add_argument(
        "--seconds",
        type=float,
        default=None,
        help="stop after N seconds (bench/CI; otherwise runs until Ctrl-C)",
    )
    p.add_argument(
        "--fps",
        type=float,
        default=None,
        help="cap the detector loop rate. Only needed when --source is a VIDEO FILE: "
        "a file replays as fast as the CPU decodes, which compresses the wall-clock "
        "cooldown. A live MJPEG stream paces itself.",
    )
    p.add_argument(
        "--loop-source",
        action="store_true",
        help="replay a video-file source from the top when it ends (kiosk loop). "
        "Off by default: a file that replays invents gate passes. Live streams and "
        "webcams always reconnect regardless of this flag.",
    )
    p.add_argument("--display", action="store_true", help="show an OpenCV overlay window per kart")
    p.add_argument("-v", "--verbose", action="store_true")
    return p.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )

    watchers = build_watchers(args)

    def _sigint(_sig, _frm):
        log.info("shutting down")
        _STOP.set()
        for w in watchers:
            w.stop()

    signal.signal(signal.SIGINT, _sigint)
    signal.signal(signal.SIGTERM, _sigint)

    threads = [threading.Thread(target=w.run, name=w.label, daemon=True) for w in watchers]
    for t in threads:
        t.start()
    deadline = (time.monotonic() + args.seconds) if args.seconds else None
    try:
        while any(t.is_alive() for t in threads) and not _STOP.is_set():
            if deadline is not None and time.monotonic() >= deadline:
                log.info("--seconds elapsed")
                break
            time.sleep(0.05)
    except KeyboardInterrupt:  # pragma: no cover
        _sigint(None, None)
    _STOP.set()
    for w in watchers:
        w.stop()
    for t in threads:
        t.join(timeout=3.0)
    total = sum(w.passes for w in watchers)
    log.info("total gate passes: %d", total)
    return 0


if __name__ == "__main__":
    sys.exit(main())
