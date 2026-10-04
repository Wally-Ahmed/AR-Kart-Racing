"""Detection: a synthetic 36h11 tag must come back with the right ID."""

from __future__ import annotations

import cv2
import numpy as np
import pytest

from arkart_vision.detector import TagDetector, render_tag


def test_synthetic_tag_7_detected_as_7():
    """ACCEPTANCE: generateImageMarker(36h11, id=7) -> detect() == {7}."""
    page = render_tag(7)
    detector = TagDetector()
    assert detector.detect(page) == {7}


def test_detects_bgr_frame_not_just_grayscale():
    """The real feed is 3-channel BGR out of cv2.VideoCapture."""
    page = render_tag(3)
    bgr = cv2.cvtColor(page, cv2.COLOR_GRAY2BGR)
    assert TagDetector().detect(bgr) == {3}


@pytest.mark.parametrize("tag_id", [0, 1, 5, 7, 12, 15])
def test_each_whitelisted_id_round_trips(tag_id):
    assert TagDetector().detect(render_tag(tag_id)) == {tag_id}


def test_two_tags_in_one_frame_both_decoded():
    """Two gate posts visible at once is normal; both IDs must come back."""
    a, b = render_tag(2), render_tag(9)
    frame = np.full((a.shape[0], a.shape[1] * 2, ), 255, dtype=np.uint8)
    frame[:, : a.shape[1]] = a
    frame[:, a.shape[1]:] = b
    assert TagDetector().detect(frame) == {2, 9}


def test_whitelist_rejects_out_of_range_id():
    """A real 36h11 tag outside the printed set must be ignored, not reported."""
    page = render_tag(42)
    assert TagDetector().detect(page) == set()           # default whitelist = 0..15
    assert TagDetector(whitelist={42}).detect(page) == {42}


def test_blank_frame_detects_nothing():
    blank = np.full((480, 640), 255, dtype=np.uint8)
    noise = np.zeros((480, 640), dtype=np.uint8)
    d = TagDetector()
    assert d.detect(blank) == set()
    assert d.detect(noise) == set()


def test_empty_frame_is_safe():
    d = TagDetector()
    assert d.detect(None) == set()
    assert d.detect(np.zeros((0, 0), dtype=np.uint8)) == set()


def test_detector_uses_apriltag_36h11_and_no_corner_refinement():
    """Guard the two R§4g settings that matter most."""
    d = TagDetector()
    assert d.parameters.cornerRefinementMethod == cv2.aruco.CORNER_REFINE_NONE
    # 36h11 is an 8x8 grid (6x6 data + 1-cell black border on each side).
    assert d.dictionary.markerSize == 6
    assert d.dictionary.maxCorrectionBits >= 5  # min Hamming 11 -> up to 5 bit fixes
