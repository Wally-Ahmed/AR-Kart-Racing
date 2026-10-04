"""AR Kart vision bridge — ALL tunables live here.

Recipe source: docs/research/arkart-research-2026-09-19.md §4(g) "The single concrete
recipe", as bound by docs/design/arkart-game-software-v1.md §7.

Everything a human might want to twist mid-demo is a module-level constant in this
block. Nothing else in the package hard-codes a number.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

# ---------------------------------------------------------------------------
# TUNABLE CONSTANTS  (R§4g)
# ---------------------------------------------------------------------------

# --- Marker dictionary -----------------------------------------------------
# 36h11: min Hamming distance 11, lowest false-positive rate, ships inside cv2.aruco.
ARUCO_DICT_NAME = "DICT_APRILTAG_36h11"

# Printed tag size, millimetres. Informational (we latch on "seen at all", never on
# pose) but kept here so the print shop and the code agree.
TAG_SIZE_MM = 150.0

# --- ID whitelist ----------------------------------------------------------
# Only these IDs are ever reported. Anything else is a misread or someone's laptop
# sticker. R§4g: "8-16 tags, IDs 0-15, whitelisted in code".
TAG_WHITELIST: frozenset[int] = frozenset(range(16))

# --- Debounce / confirmation ----------------------------------------------
# N consecutive detection frames of the same (kart, tag) before it counts as a pass.
CONFIRM_FRAMES = 2

# The N confirming frames must all land inside this sliding window (seconds).
# R§4g: "M = 2 decodes of the same ID within a ~300-500 ms sliding window".
CONFIRM_WINDOW_S = 0.5

# How many frames the tag may go missing without breaking the streak. 0 = strictly
# consecutive frames. 1 forgives a single blurred/corrupted misread mid-pass (R§4c).
MISS_TOLERANCE_FRAMES = 1

# Per-(kart, tag) cooldown after a reported pass (seconds). R§4g: "~1-2 s".
COOLDOWN_S = 1.5

# --- Detector parameters (R§4g / R§4c) ------------------------------------
# CORNER_REFINE_NONE: we want a trigger event, not sub-mm pose. Costs no CPU.
CORNER_REFINEMENT = "CORNER_REFINE_NONE"
ADAPTIVE_THRESH_WIN_SIZE_MIN = 3
ADAPTIVE_THRESH_WIN_SIZE_MAX = 23
MIN_MARKER_PERIMETER_RATE = 0.03
POLYGONAL_APPROX_ACCURACY_RATE = 0.03
PERSPECTIVE_REMOVE_PIXEL_PER_CELL = 4
# 0.6 is the OpenCV default and is implicated in 16h5's false-positive notoriety.
# 36h11 tolerates it, but lower this first if phantom gates appear.
ERROR_CORRECTION_RATE = 0.6

# --- Stream handling -------------------------------------------------------
STREAM_RECONNECT_DELAY_S = 1.0      # wait before re-opening a dead MJPEG stream
STREAM_READ_FAIL_LIMIT = 30         # consecutive failed reads before reconnecting
STREAM_OPEN_TIMEOUT_MS = 5000       # ffmpeg open/read timeout

# --- SpacetimeDB reducer call (spec §7) ------------------------------------
STDB_BASE_URL = os.environ.get("STDB_BASE_URL", "http://localhost:3000")
STDB_DATABASE = os.environ.get("STDB_DATABASE", "arkart")
STDB_REDUCER = "report_gate"
# Optional Spacetime token. Absent -> anonymous call, which is what the LAN demo
# wants (spec §4 "Auth: demo-grade").
STDB_TOKEN = os.environ.get("STDB_TOKEN") or None
STDB_TIMEOUT_S = 1.0                # never let a slow POST stall a detector loop
STDB_MAX_INFLIGHT = 4               # per-kart POST worker queue depth

# --- Misc ------------------------------------------------------------------
DEFAULT_KARTS_FILE = Path(__file__).resolve().parent.parent / "karts.json"


# ---------------------------------------------------------------------------
# karts.json loading
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class KartStream:
    """One kart's FPV feed."""

    kart_id: int
    stream_url: str
    name: str = ""


@dataclass(frozen=True)
class BridgeConfig:
    karts: tuple[KartStream, ...]
    stdb_base_url: str = STDB_BASE_URL
    stdb_database: str = STDB_DATABASE
    tag_whitelist: frozenset[int] = field(default=TAG_WHITELIST)


def load_config(path: str | os.PathLike[str] | None = None) -> BridgeConfig:
    """Load karts.json.

    Shape::

        {
          "stdb": {"base_url": "http://localhost:3000", "database": "arkart"},
          "tag_whitelist": [0, 1, ..., 15],
          "karts": [{"kart_id": 1, "stream_url": "http://192.168.8.101/stream"}]
        }

    Every field except ``karts`` is optional and falls back to the constants above.
    """
    path = Path(path) if path is not None else DEFAULT_KARTS_FILE
    raw = json.loads(Path(path).read_text(encoding="utf-8"))

    karts_raw = raw.get("karts")
    if not karts_raw:
        raise ValueError(f"{path}: no 'karts' entries")

    karts: list[KartStream] = []
    seen_ids: set[int] = set()
    for entry in karts_raw:
        kart_id = int(entry["kart_id"])
        if kart_id in seen_ids:
            raise ValueError(f"{path}: duplicate kart_id {kart_id}")
        seen_ids.add(kart_id)
        url = str(entry["stream_url"]).strip()
        if not url:
            raise ValueError(f"{path}: kart {kart_id} has an empty stream_url")
        karts.append(KartStream(kart_id=kart_id, stream_url=url, name=str(entry.get("name", ""))))

    stdb = raw.get("stdb") or {}
    whitelist = raw.get("tag_whitelist")

    return BridgeConfig(
        karts=tuple(karts),
        stdb_base_url=str(stdb.get("base_url", STDB_BASE_URL)).rstrip("/"),
        stdb_database=str(stdb.get("database", STDB_DATABASE)),
        tag_whitelist=frozenset(int(t) for t in whitelist) if whitelist else TAG_WHITELIST,
    )
