"""Per-(kart, tag) debounce state machine — "one physical pass fires exactly once".

State is keyed ``{kart_id: {tag_id: _TagState}}`` exactly as R§4g demands: never a
global "tag seen" flag, because both karts can be looking at the same gate post at
the same instant and both are legitimate, independent passes.

The machine, per (kart, tag):

    hit  -> streak += 1, within CONFIRM_WINDOW_S of the streak's first hit
    miss -> tolerated up to MISS_TOLERANCE_FRAMES, then the streak resets

    fire when  streak >= CONFIRM_FRAMES  and  not latched  and  now >= cooldown_until
    on fire    latched = True, cooldown_until = now + COOLDOWN_S
    unlatch    when the streak resets (the tag left the frame = the pass ended)

The latch is what guarantees "exactly once per pass": staring at the gate for a
hundred frames still fires once. The cooldown is the second belt — it stops a tag
that flickers out and straight back in (blur, a passing wheel) from firing twice
for the same physical pass.

Pure logic, no OpenCV, no I/O, no wall clock of its own: every entrypoint takes
``now``. That is what makes it testable to the frame.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable

from . import config


@dataclass(frozen=True)
class GatePass:
    """A confirmed gate pass, ready to hand to ``report_gate``."""

    kart_id: int
    tag_id: int
    at: float


@dataclass
class _TagState:
    streak: int = 0
    misses: int = 0
    streak_started_at: float = 0.0
    last_hit_at: float = 0.0
    latched: bool = False
    cooldown_until: float = 0.0

    def reset_streak(self) -> None:
        self.streak = 0
        self.misses = 0
        self.streak_started_at = 0.0
        self.latched = False


class GateDebouncer:
    """N-frame confirm + per-(kart, tag) latch + cooldown.

    Usage, once per decoded frame::

        for gate_pass in debouncer.observe(kart_id, tag_ids_seen_in_this_frame, now):
            reducer.report_gate(gate_pass.kart_id, gate_pass.tag_id)

    ``observe`` must be called for EVERY frame, including frames where nothing was
    seen (pass an empty set) — that is how a streak learns the tag went away.
    """

    def __init__(
        self,
        *,
        confirm_frames: int = config.CONFIRM_FRAMES,
        confirm_window_s: float = config.CONFIRM_WINDOW_S,
        miss_tolerance_frames: int = config.MISS_TOLERANCE_FRAMES,
        cooldown_s: float = config.COOLDOWN_S,
        whitelist: Iterable[int] | None = config.TAG_WHITELIST,
    ) -> None:
        if confirm_frames < 1:
            raise ValueError("confirm_frames must be >= 1")
        self.confirm_frames = confirm_frames
        self.confirm_window_s = confirm_window_s
        self.miss_tolerance_frames = miss_tolerance_frames
        self.cooldown_s = cooldown_s
        self.whitelist = frozenset(whitelist) if whitelist is not None else None
        self._state: dict[int, dict[int, _TagState]] = {}

    # -- introspection (director screen / debug overlay) --------------------

    def streak(self, kart_id: int, tag_id: int) -> int:
        return self._state.get(kart_id, {}).get(tag_id, _TagState()).streak

    def is_latched(self, kart_id: int, tag_id: int) -> bool:
        return self._state.get(kart_id, {}).get(tag_id, _TagState()).latched

    def cooldown_remaining(self, kart_id: int, tag_id: int, now: float) -> float:
        st = self._state.get(kart_id, {}).get(tag_id)
        return max(0.0, st.cooldown_until - now) if st else 0.0

    # -- the machine --------------------------------------------------------

    def observe(self, kart_id: int, tag_ids: Iterable[int], now: float) -> list[GatePass]:
        """Feed one frame's decoded IDs. Returns the passes confirmed by this frame."""
        seen = {int(t) for t in tag_ids}
        if self.whitelist is not None:
            seen &= self.whitelist

        per_kart = self._state.setdefault(kart_id, {})
        for tag_id in seen:
            per_kart.setdefault(tag_id, _TagState())

        fired: list[GatePass] = []
        for tag_id, st in per_kart.items():
            if tag_id in seen:
                pass_ = self._on_hit(kart_id, tag_id, st, now)
                if pass_ is not None:
                    fired.append(pass_)
            else:
                self._on_miss(st)

        fired.sort(key=lambda p: p.tag_id)
        return fired

    def _on_hit(self, kart_id: int, tag_id: int, st: _TagState, now: float) -> GatePass | None:
        # A streak that started too long ago is stale: this is a new approach, not a
        # continuation. Restart it from this frame.
        if st.streak > 0 and (now - st.streak_started_at) > self.confirm_window_s:
            if st.latched:
                # Still inside the same unbroken sighting (tag never went away), so
                # keep the latch — sliding the window must not re-arm a fired pass.
                st.streak = self.confirm_frames
                st.misses = 0
                st.streak_started_at = now
                st.last_hit_at = now
                return None
            st.streak = 0
            st.misses = 0

        if st.streak == 0:
            st.streak_started_at = now

        st.streak += 1
        st.misses = 0
        st.last_hit_at = now

        if st.streak < self.confirm_frames:
            return None
        if st.latched:
            return None
        if now < st.cooldown_until:
            return None

        st.latched = True
        st.cooldown_until = now + self.cooldown_s
        return GatePass(kart_id=kart_id, tag_id=tag_id, at=now)

    def _on_miss(self, st: _TagState) -> None:
        if st.streak == 0 and not st.latched:
            return
        st.misses += 1
        if st.misses > self.miss_tolerance_frames:
            # The tag is gone: the pass is over. Drop the latch so the NEXT approach
            # can fire — the cooldown is what stops that happening too soon.
            st.reset_streak()
