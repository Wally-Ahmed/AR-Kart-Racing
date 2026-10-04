"""AR Kart vision bridge — one cv2.aruco detector loop per kart MJPEG stream.

The bridge only reports sightings. The SpacetimeDB module decides what a sighting
means (setup-phase ordering vs in-race checkpoint). See spec §7.
"""

from .config import BridgeConfig, KartStream, load_config
from .debounce import GateDebouncer, GatePass
from .detector import TagDetector
from .reducer import ReducerClient, build_report_gate_request

__all__ = [
    "BridgeConfig",
    "KartStream",
    "load_config",
    "GateDebouncer",
    "GatePass",
    "TagDetector",
    "ReducerClient",
    "build_report_gate_request",
]
