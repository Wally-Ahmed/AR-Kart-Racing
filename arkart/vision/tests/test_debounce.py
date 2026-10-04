"""Debounce state machine: N-frame confirm, exactly one fire per pass, cooldown re-arm.

Frame timing throughout: 20 fps => 0.05 s per frame, which is the real ESP32-S3-CAM
ballpark (R§4e says 10-20 fps at VGA).
"""

from __future__ import annotations

import pytest

from arkart_vision.debounce import GateDebouncer, GatePass

DT = 0.05  # one frame at 20 fps


def feed(deb: GateDebouncer, kart_id: int, frames, *, t0: float = 100.0, dt: float = DT):
    """Feed a list of per-frame tag sets; return (all_passes, end_time)."""
    out: list[GatePass] = []
    t = t0
    for tags in frames:
        out.extend(deb.observe(kart_id, tags, t))
        t += dt
    return out, t


def test_n_frame_confirm_fires_on_frame_n_not_before():
    deb = GateDebouncer(confirm_frames=2, confirm_window_s=0.5, miss_tolerance_frames=0,
                        cooldown_s=1.5)
    assert deb.observe(1, {7}, 100.00) == []                      # frame 1: streak 1
    fired = deb.observe(1, {7}, 100.05)                           # frame 2: confirmed
    assert [(p.kart_id, p.tag_id) for p in fired] == [(1, 7)]
    assert fired[0].at == pytest.approx(100.05)


def test_confirm_frames_three_needs_three():
    deb = GateDebouncer(confirm_frames=3, confirm_window_s=0.5, miss_tolerance_frames=0,
                        cooldown_s=1.5)
    passes, _ = feed(deb, 1, [{7}, {7}])
    assert passes == []
    passes, _ = feed(deb, 1, [{7}], t0=100.10)
    assert len(passes) == 1


def test_single_frame_glimpse_never_fires():
    """One decoded frame is a misread until proven otherwise (R§4g M=2)."""
    deb = GateDebouncer(confirm_frames=2, miss_tolerance_frames=0, cooldown_s=1.5)
    passes, _ = feed(deb, 1, [{7}, set(), {7}, set(), {7}, set()])
    assert passes == []


def test_one_physical_pass_fires_exactly_once():
    """ACCEPTANCE: a 15-frame sighting of one gate produces ONE report_gate."""
    deb = GateDebouncer(confirm_frames=2, confirm_window_s=0.5, miss_tolerance_frames=1,
                        cooldown_s=1.5)
    passes, _ = feed(deb, 1, [{7}] * 15)
    assert len(passes) == 1
    assert passes[0].tag_id == 7


def test_long_stare_past_the_cooldown_still_fires_once():
    """Parked facing a gate for 5 s: the latch, not the cooldown, holds it at one."""
    deb = GateDebouncer(confirm_frames=2, confirm_window_s=0.5, miss_tolerance_frames=1,
                        cooldown_s=1.5)
    passes, _ = feed(deb, 1, [{7}] * 100)   # 100 frames @ 20fps = 5 s >> cooldown 1.5 s
    assert len(passes) == 1


def test_cooldown_blocks_a_reentry_that_is_too_soon():
    """Tag flickers out and back inside the cooldown -> still the same pass, no 2nd fire."""
    deb = GateDebouncer(confirm_frames=2, confirm_window_s=0.5, miss_tolerance_frames=0,
                        cooldown_s=1.5)
    passes, t = feed(deb, 1, [{7}, {7}])                       # fires at t=100.05
    assert len(passes) == 1
    # gone for 4 frames (0.2 s), then seen again for 6 -> only 0.3 s after the fire
    more, _ = feed(deb, 1, [set()] * 4 + [{7}] * 6, t0=t)
    assert more == []


def test_cooldown_rearms_after_it_expires():
    """ACCEPTANCE: second lap through the same gate fires again once re-armed."""
    deb = GateDebouncer(confirm_frames=2, confirm_window_s=0.5, miss_tolerance_frames=0,
                        cooldown_s=1.5)
    passes, _ = feed(deb, 1, [{7}, {7}], t0=100.0)
    assert len(passes) == 1

    # tag out of frame for the whole cooldown...
    gone, _ = feed(deb, 1, [set()] * 40, t0=100.10)            # 2.0 s of nothing
    assert gone == []
    assert deb.cooldown_remaining(1, 7, 102.10) == 0.0

    # ...then lap 2 comes past the same gate
    again, _ = feed(deb, 1, [{7}, {7}], t0=102.10)
    assert len(again) == 1
    assert again[0].tag_id == 7


def test_miss_tolerance_survives_one_blurred_frame_mid_confirm():
    """R§4c: one corrupted decode mid-pass must not restart the confirm."""
    strict = GateDebouncer(confirm_frames=3, confirm_window_s=0.5, miss_tolerance_frames=0,
                           cooldown_s=1.5)
    forgiving = GateDebouncer(confirm_frames=3, confirm_window_s=0.5, miss_tolerance_frames=1,
                              cooldown_s=1.5)
    frames = [{7}, set(), {7}, {7}]
    assert feed(strict, 1, frames)[0] == []          # streak reset by the blur
    assert len(feed(forgiving, 1, frames)[0]) == 1   # streak survived


def test_confirm_window_rejects_hits_spread_too_far_apart():
    """Two sightings 3 s apart are two approaches, not one confirm."""
    deb = GateDebouncer(confirm_frames=2, confirm_window_s=0.5, miss_tolerance_frames=5,
                        cooldown_s=1.5)
    assert deb.observe(1, {7}, 100.0) == []
    assert deb.observe(1, {7}, 103.0) == []     # window stale -> streak restarts at 1
    assert len(deb.observe(1, {7}, 103.05)) == 1


def test_state_is_keyed_per_kart_and_per_tag():
    """R§4g: both karts may pass the same gate at the same instant. Two events."""
    deb = GateDebouncer(confirm_frames=2, miss_tolerance_frames=0, cooldown_s=1.5)
    assert deb.observe(1, {7}, 100.0) == []
    assert deb.observe(2, {7}, 100.0) == []
    k1 = deb.observe(1, {7}, 100.05)
    k2 = deb.observe(2, {7}, 100.05)
    assert [(p.kart_id, p.tag_id) for p in k1] == [(1, 7)]
    assert [(p.kart_id, p.tag_id) for p in k2] == [(2, 7)]


def test_kart_one_cooldown_does_not_gag_kart_two():
    deb = GateDebouncer(confirm_frames=2, miss_tolerance_frames=0, cooldown_s=1.5)
    feed(deb, 1, [{7}, {7}], t0=100.0)                 # kart 1 fires, now in cooldown
    passes, _ = feed(deb, 2, [{7}, {7}], t0=100.1)     # kart 2 unaffected
    assert [(p.kart_id, p.tag_id) for p in passes] == [(2, 7)]


def test_two_gates_in_one_frame_both_fire():
    """Gate post 3 and item box 8 in the same frame -> two independent passes."""
    deb = GateDebouncer(confirm_frames=2, miss_tolerance_frames=0, cooldown_s=1.5)
    assert deb.observe(1, {3, 8}, 100.0) == []
    fired = deb.observe(1, {3, 8}, 100.05)
    assert [(p.kart_id, p.tag_id) for p in fired] == [(1, 3), (1, 8)]


def test_whitelist_filters_before_the_state_machine():
    deb = GateDebouncer(confirm_frames=2, miss_tolerance_frames=0, cooldown_s=1.5,
                        whitelist={0, 1, 2})
    passes, _ = feed(deb, 1, [{99}] * 10)
    assert passes == []
    assert deb.streak(1, 99) == 0


def test_full_three_lap_course_yields_one_pass_per_gate_per_lap():
    """End-to-end shape check: 3 gates x 3 laps = 9 report_gate calls, in order."""
    deb = GateDebouncer(confirm_frames=2, confirm_window_s=0.5, miss_tolerance_frames=1,
                        cooldown_s=1.5)
    frames: list[set[int]] = []
    for _lap in range(3):
        for gate in (0, 1, 2):
            frames += [{gate}] * 8      # 0.40 s dwell on the gate
            frames += [set()] * 40      # 2.00 s of track between gates
    passes, _ = feed(deb, 1, frames)
    assert [p.tag_id for p in passes] == [0, 1, 2, 0, 1, 2, 0, 1, 2]
