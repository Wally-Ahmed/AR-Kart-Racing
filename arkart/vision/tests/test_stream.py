"""Stream lifecycle: an endless stream reconnects, a finite file ENDS.

Why this file exists: ``MJPEGStream`` treats a dead stream as a normal state and
re-opens it, which is exactly right for an ESP32-S3-CAM that browns out mid-race.
Applied to a video FILE, that same reflex replays the footage from the top — and a
replayed lap is indistinguishable from a real one, so the bench test silently
invents gate passes as soon as the run outlives the video. These tests pin the
distinction down.
"""

from __future__ import annotations

import itertools

import cv2
import numpy as np
import pytest

from arkart_vision.stream import MJPEGStream, is_finite_source

FRAMES = 10
W, H = 64, 48


@pytest.fixture
def tiny_video(tmp_path):
    """A 10-frame MJPG .avi — just enough to have a beginning and an end."""
    path = tmp_path / "tiny.avi"
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), 20, (W, H))
    assert writer.isOpened(), "cannot open VideoWriter — MJPG encoder missing?"
    for i in range(FRAMES):
        writer.write(np.full((H, W, 3), 10 * i, np.uint8))
    writer.release()
    assert path.is_file()
    return path


# -- source classification --------------------------------------------------


def test_video_file_is_finite(tiny_video):
    assert is_finite_source(str(tiny_video)) is True


def test_webcam_index_is_not_finite():
    """A webcam never runs out; a failed read there means re-open."""
    assert is_finite_source(0) is False


@pytest.mark.parametrize(
    "url",
    [
        "http://192.168.8.101/stream",
        "http://192.168.8.102:81/stream",
        "rtsp://10.0.0.5/live",
    ],
)
def test_stream_url_is_not_finite(url):
    assert is_finite_source(url) is False


def test_missing_path_is_not_treated_as_a_finite_file(tmp_path):
    """Keeps the pre-existing 'cannot open — retrying' behaviour for a typo'd path."""
    assert is_finite_source(str(tmp_path / "nope.avi")) is False


# -- the defaults that follow from it ---------------------------------------


def test_file_source_defaults_to_not_looping(tiny_video):
    assert MJPEGStream(str(tiny_video)).loop_on_eof is False


@pytest.mark.parametrize("source", [0, "http://192.168.8.101/stream"])
def test_live_sources_default_to_looping(source):
    """Never regress this: the real demo depends on reconnecting forever."""
    assert MJPEGStream(source).loop_on_eof is True


def test_explicit_loop_on_eof_overrides_the_guess(tiny_video):
    assert MJPEGStream(str(tiny_video), loop_on_eof=True).loop_on_eof is True
    assert MJPEGStream(0, loop_on_eof=False).loop_on_eof is False


# -- behaviour --------------------------------------------------------------


def test_file_yields_every_frame_exactly_once_then_stops(tiny_video):
    """ACCEPTANCE: a finite file produces its frames and then the iterator ENDS.

    Without this, ``frames()`` never returns and the footage loops.
    """
    stream = MJPEGStream(str(tiny_video), read_fail_limit=2, reconnect_delay_s=0.0)
    got = list(stream.frames())  # terminates on its own, or this test hangs
    assert len(got) == FRAMES
    assert stream.exhausted is True
    assert stream.reconnects == 0


def test_file_does_not_replay_and_so_cannot_invent_frames(tiny_video):
    """The regression this guards: 11th frame = lap 1 again = a phantom gate pass."""
    stream = MJPEGStream(str(tiny_video), read_fail_limit=2, reconnect_delay_s=0.0)
    assert len(list(itertools.islice(stream.frames(), FRAMES * 3))) == FRAMES


def test_loop_on_eof_still_replays_a_file_when_asked(tiny_video):
    """--loop-source is an opt-in kiosk loop; prove the old behaviour survives."""
    stream = MJPEGStream(
        str(tiny_video), read_fail_limit=2, reconnect_delay_s=0.0, loop_on_eof=True
    )
    got = list(itertools.islice(stream.frames(), FRAMES + 5))
    stream.stop()
    assert len(got) == FRAMES + 5, "looping source should have replayed from the top"
    assert stream.reconnects >= 1
    assert stream.exhausted is False


def test_stop_ends_iteration_early(tiny_video):
    stream = MJPEGStream(str(tiny_video), read_fail_limit=2, reconnect_delay_s=0.0)
    seen = 0
    for _frame in stream.frames():
        seen += 1
        if seen == 3:
            stream.stop()
    assert seen == 3


def test_context_manager_releases_the_capture(tiny_video):
    with MJPEGStream(str(tiny_video), read_fail_limit=2, reconnect_delay_s=0.0) as stream:
        next(stream.frames())
    assert stream._cap is None
