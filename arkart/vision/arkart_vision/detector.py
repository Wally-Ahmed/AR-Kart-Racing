"""cv2.aruco wrapper — DICT_APRILTAG_36h11, tuned per R§4g.

We latch on "decoded at all". No pose, no distance gate: with single-digit frame
counts per pass and rolling-shutter blur, a pose-stability gate throws away
partial-but-correct decodes exactly when you have the fewest frames (R§4e).
"""

from __future__ import annotations

from typing import Iterable

import cv2
import numpy as np

from . import config


def _aruco_dictionary(name: str = config.ARUCO_DICT_NAME):
    try:
        dict_id = getattr(cv2.aruco, name)
    except AttributeError as exc:  # pragma: no cover - misconfiguration only
        raise ValueError(f"unknown aruco dictionary {name!r}") from exc
    return cv2.aruco.getPredefinedDictionary(dict_id)


def _detector_parameters() -> "cv2.aruco.DetectorParameters":
    p = cv2.aruco.DetectorParameters()
    p.cornerRefinementMethod = getattr(cv2.aruco, config.CORNER_REFINEMENT)
    p.adaptiveThreshWinSizeMin = config.ADAPTIVE_THRESH_WIN_SIZE_MIN
    p.adaptiveThreshWinSizeMax = config.ADAPTIVE_THRESH_WIN_SIZE_MAX
    p.minMarkerPerimeterRate = config.MIN_MARKER_PERIMETER_RATE
    p.polygonalApproxAccuracyRate = config.POLYGONAL_APPROX_ACCURACY_RATE
    p.perspectiveRemovePixelPerCell = config.PERSPECTIVE_REMOVE_PIXEL_PER_CELL
    p.errorCorrectionRate = config.ERROR_CORRECTION_RATE
    return p


class TagDetector:
    """Decode 36h11 tags out of BGR or grayscale frames.

    One instance per kart stream (``ArucoDetector`` is not documented as
    thread-safe, and per-stream instances cost nothing).
    """

    def __init__(
        self,
        *,
        dictionary_name: str = config.ARUCO_DICT_NAME,
        whitelist: Iterable[int] | None = config.TAG_WHITELIST,
    ) -> None:
        self.dictionary = _aruco_dictionary(dictionary_name)
        self.parameters = _detector_parameters()
        self.detector = cv2.aruco.ArucoDetector(self.dictionary, self.parameters)
        self.whitelist = frozenset(whitelist) if whitelist is not None else None

    def detect(self, frame: np.ndarray) -> set[int]:
        """Return the set of whitelisted tag IDs decoded in this frame."""
        if frame is None or frame.size == 0:
            return set()
        gray = frame if frame.ndim == 2 else cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        _corners, ids, _rejected = self.detector.detectMarkers(gray)
        if ids is None or len(ids) == 0:
            return set()
        found = {int(i) for i in ids.flatten()}
        if self.whitelist is not None:
            found &= self.whitelist
        return found

    def detect_with_corners(self, frame: np.ndarray):
        """Same decode, but keeps corners for the optional --display overlay."""
        if frame is None or frame.size == 0:
            return [], None
        gray = frame if frame.ndim == 2 else cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        corners, ids, _rejected = self.detector.detectMarkers(gray)
        return corners, ids


def render_tag(tag_id: int, *, side_px: int = 240, border_px: int = 60,
               dictionary_name: str = config.ARUCO_DICT_NAME) -> np.ndarray:
    """Render one 36h11 tag on a white page — test fixture and print helper.

    ``border_px`` is the quiet zone. R§4f: at least as wide as the tag's own black
    border ring; one tag per US Letter sheet gives far more than the minimum.
    """
    dictionary = _aruco_dictionary(dictionary_name)
    marker = cv2.aruco.generateImageMarker(dictionary, int(tag_id), int(side_px))
    page = np.full(
        (side_px + 2 * border_px, side_px + 2 * border_px), 255, dtype=np.uint8
    )
    page[border_px:border_px + side_px, border_px:border_px + side_px] = marker
    return page
