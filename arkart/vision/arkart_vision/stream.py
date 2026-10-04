"""MJPEG stream reader with auto-reconnect.

The ESP32-S3-CAM's stock HTTP stream drops constantly at a hackathon: WiFi
contention, the kart browning out on a stall, someone unplugging it. The detector
loop must survive every one of those without a restart, so this reader treats a
dead stream as a normal state and just re-opens it.
"""

from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Iterator

import cv2
import numpy as np

from . import config

log = logging.getLogger(__name__)


def is_finite_source(source: str | int) -> bool:
    """True when ``source`` is a local video FILE, i.e. something with an end.

    A webcam index and an MJPEG URL are endless: a failed read there means the
    kart browned out or WiFi hiccuped, and re-opening is the right answer. A file
    runs out, and re-opening it silently REPLAYS it — which on the bench shows up
    as phantom extra gate passes once the run outlives the footage. So the two
    cases must be told apart; see ``frames()``.
    """
    if isinstance(source, int):
        return False
    try:
        return Path(str(source)).is_file()
    except OSError:  # pragma: no cover - exotic paths only
        return False


class MJPEGStream:
    """Iterate frames from an MJPEG URL (or a local webcam index / video file)."""

    def __init__(
        self,
        source: str | int,
        *,
        label: str = "",
        reconnect_delay_s: float = config.STREAM_RECONNECT_DELAY_S,
        read_fail_limit: int = config.STREAM_READ_FAIL_LIMIT,
        loop_on_eof: bool | None = None,
    ) -> None:
        self.source = source
        self.label = label or str(source)
        self.reconnect_delay_s = reconnect_delay_s
        self.read_fail_limit = read_fail_limit
        # None = decide by source kind: endless stream -> reconnect, file -> stop.
        self.loop_on_eof = (
            bool(loop_on_eof) if loop_on_eof is not None else not is_finite_source(source)
        )
        self._cap: "cv2.VideoCapture | None" = None
        self._stop = False
        self.reconnects = 0
        self.exhausted = False

    # -- lifecycle ----------------------------------------------------------

    def _open(self) -> bool:
        self._close()
        cap = cv2.VideoCapture(self.source)
        if not cap.isOpened():
            cap.release()
            return False
        # Keep the buffer shallow so we decode the NEWEST frame, not a backlog.
        # Ignored by some backends; harmless when it is.
        try:
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        except Exception:  # pragma: no cover
            pass
        self._cap = cap
        return True

    def _close(self) -> None:
        if self._cap is not None:
            try:
                self._cap.release()
            except Exception:  # pragma: no cover
                pass
            self._cap = None

    def stop(self) -> None:
        self._stop = True

    # -- the loop -----------------------------------------------------------

    def frames(self) -> Iterator[np.ndarray]:
        """Yield BGR frames, reconnecting as needed.

        Endless for a live stream or webcam (``loop_on_eof``); ends on ``stop()``, or
        when a finite video-file source runs out.
        """
        fails = 0
        while not self._stop:
            if self._cap is None:
                if not self._open():
                    log.warning("[%s] cannot open %s — retrying", self.label, self.source)
                    time.sleep(self.reconnect_delay_s)
                    continue
                log.info("[%s] stream open: %s", self.label, self.source)
                fails = 0

            ok, frame = self._cap.read()
            if not ok or frame is None:
                fails += 1
                if fails >= self.read_fail_limit:
                    if not self.loop_on_eof:
                        # Finite file, fully read: stop. Re-opening would replay it
                        # and invent gate passes that never happened.
                        log.info("[%s] source exhausted (end of file)", self.label)
                        self.exhausted = True
                        break
                    log.warning("[%s] stream stalled — reconnecting", self.label)
                    self._close()
                    self.reconnects += 1
                    time.sleep(self.reconnect_delay_s)
                    fails = 0
                continue

            fails = 0
            yield frame

        self._close()

    def __enter__(self) -> "MJPEGStream":
        return self

    def __exit__(self, *exc) -> None:
        self.stop()
        self._close()
