#!/usr/bin/env python3
"""End-to-end acceptance check: synthetic track video -> real HTTP report_gate calls.

Proves the whole bridge path with no hardware and no SpacetimeDB:

  1. generates the synthetic lap video AND its ground-truth gate order
     (``make_test_track_video.py --truth`` — the generator is the only thing that
     knows the right answer, so nothing here hand-copies a list),
  2. stands up a recording stub on the one HTTP route the bridge uses
     (``POST /v1/database/<db>/call/<reducer>``) on an ephemeral port,
  3. runs the real bridge against the video with the reducer pointed at the stub,
  4. asserts the RECORDED call sequence equals the ground truth exactly — order,
     kart ids, reducer name, positional-array body, and count (an exact-length
     match is what rules out double-fires).

Two phases, because the two ways to aim the bridge resolve the STDB base URL
differently and both have to work:

  Phase A  --source + STDB_BASE_URL env     (bench path, one kart)
  Phase B  karts.json "stdb".base_url       (REAL demo path, two karts at once,
                                             which also proves per-kart isolation)

Usage::

    ./.venv/bin/python tools/e2e_gate_check.py            # exit 0 = acceptance met
    ./.venv/bin/python tools/e2e_gate_check.py --keep -v  # keep artifacts, show bridge log

Exit status is 0 only if every assertion passes.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VISION_DIR = Path(__file__).resolve().parent.parent
GENERATOR = VISION_DIR / "tools" / "make_test_track_video.py"
DATABASE = "arkart_e2e"


# ---------------------------------------------------------------------------
# recording stub for the SpacetimeDB reducer endpoint
# ---------------------------------------------------------------------------


class _Recorder:
    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.bad_routes: list[str] = []
        self.lock = threading.Lock()


def _make_handler(rec: _Recorder):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):  # keep the harness output readable
            pass

        def do_POST(self):  # noqa: N802
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n) if n else b""
            parts = [p for p in self.path.split("/") if p]
            # /v1/database/<db>/call/<reducer>
            ok_route = (
                len(parts) == 5
                and parts[0] == "v1"
                and parts[1] == "database"
                and parts[3] == "call"
            )
            if not ok_route:
                with rec.lock:
                    rec.bad_routes.append(self.path)
                self.send_response(404)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            try:
                args = json.loads(raw.decode() or "null")
            except Exception:
                args = {"_unparseable": raw.decode(errors="replace")}
            with rec.lock:
                rec.calls.append(
                    {
                        "database": parts[2],
                        "reducer": parts[4],
                        "args": args,
                        "content_type": self.headers.get("Content-Type"),
                        "authorization": self.headers.get("Authorization"),
                    }
                )
            # SpacetimeDB answers a successful reducer call 200 with an empty body.
            self.send_response(200)
            self.send_header("Content-Length", "0")
            self.end_headers()

    return Handler


class StubServer:
    """Recording stub on an ephemeral port (never a fixed one — no port squatting)."""

    def __init__(self) -> None:
        self.rec = _Recorder()
        self._srv = ThreadingHTTPServer(("127.0.0.1", 0), _make_handler(self.rec))
        self.port = self._srv.server_address[1]
        self._t = threading.Thread(target=self._srv.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def __enter__(self) -> "StubServer":
        self._t.start()
        return self

    def __exit__(self, *exc) -> None:
        self._srv.shutdown()
        self._srv.server_close()
        self._t.join(timeout=3.0)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def run_generator(out: Path, truth: Path, *, laps: int, gates: int) -> dict:
    subprocess.run(
        [sys.executable, str(GENERATOR), str(out), "--laps", str(laps),
         "--gates", str(gates), "--truth", str(truth)],
        check=True,
        cwd=VISION_DIR,
        capture_output=True,
    )
    return json.loads(truth.read_text())


def run_bridge(argv: list[str], *, env_extra: dict[str, str], timeout: float, verbose: bool) -> str:
    env = {**os.environ, **env_extra}
    proc = subprocess.run(
        [sys.executable, "-m", "arkart_vision.bridge", *argv],
        cwd=VISION_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    log = proc.stdout + proc.stderr
    if verbose:
        print(log)
    if proc.returncode != 0:
        raise SystemExit(f"bridge exited {proc.returncode}\n{log}")
    return log


def check(label: str, cond: bool, detail: str = "") -> bool:
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f" — {detail}" if detail else ""))
    return cond


# ---------------------------------------------------------------------------
# phases
# ---------------------------------------------------------------------------


def phase_a(work: Path, truth: dict, video: Path, *, kart: int, verbose: bool) -> bool:
    print("\nPHASE A — --source + STDB_BASE_URL env (bench path, 1 kart)")
    expected = [[kart, t] for t in truth["gate_order"]]
    watchdog = truth["duration_s"] * 2 + 30

    with StubServer() as stub:
        run_bridge(
            ["--kart", str(kart), "--source", str(video), "--fps", str(truth["fps"]),
             "--seconds", str(round(truth["duration_s"] * 2 + 10, 1))],
            env_extra={"STDB_BASE_URL": stub.base_url, "STDB_DATABASE": DATABASE},
            timeout=watchdog,
            verbose=verbose,
        )
        calls = list(stub.rec.calls)
        bad = list(stub.rec.bad_routes)

    got = [c["args"] for c in calls]
    print(f"  expected gate order : {[t for _k, t in expected]}")
    print(f"  recorded gate order : {[a[1] for a in got if isinstance(a, list) and len(a) == 2]}")
    ok = True
    ok &= check("recorded sequence == ground truth (order + kart ids + count)",
                got == expected, f"got {got}" if got != expected else f"{len(got)} calls")
    ok &= check("no double-fires", len(got) == len(expected),
                f"{len(got)} calls vs {len(expected)} gates")
    ok &= check("every call is report_gate", all(c["reducer"] == "report_gate" for c in calls))
    ok &= check(f"every call targets database {DATABASE!r} (env override honoured)",
                all(c["database"] == DATABASE for c in calls))
    ok &= check("body is a 2-element positional JSON array",
                all(isinstance(c["args"], list) and len(c["args"]) == 2 for c in calls))
    ok &= check("Content-Type: application/json",
                all((c["content_type"] or "").startswith("application/json") for c in calls))
    ok &= check("anonymous (no Authorization header, per spec §4 demo-grade)",
                all(c["authorization"] is None for c in calls))
    ok &= check("no unexpected HTTP routes hit", not bad, f"stray: {bad}" if bad else "")
    return ok


def phase_b(work: Path, truth: dict, video: Path, *, verbose: bool) -> bool:
    print("\nPHASE B — karts.json stdb.base_url (REAL demo path, 2 karts, isolation)")
    kart_ids = [1, 2]
    watchdog = truth["duration_s"] * 2 + 40

    with StubServer() as stub:
        cfg = {
            "stdb": {"base_url": stub.base_url, "database": DATABASE},
            "tag_whitelist": list(range(16)),
            "karts": [
                {"kart_id": k, "name": f"kart-{k}", "stream_url": str(video)} for k in kart_ids
            ],
        }
        cfg_path = work / "karts.e2e.json"
        cfg_path.write_text(json.dumps(cfg, indent=2))
        log = run_bridge(
            ["--config", str(cfg_path), "--fps", str(truth["fps"]),
             "--seconds", str(round(truth["duration_s"] * 2 + 15, 1))],
            env_extra={},  # deliberately NO env override: karts.json must win
            timeout=watchdog,
            verbose=verbose,
        )
        calls = list(stub.rec.calls)

    ok = True
    ok &= check("bridge announced the karts.json base_url (not the env default)",
                stub.base_url in log, f"looked for {stub.base_url}")
    for k in kart_ids:
        got = [c["args"][1] for c in calls
               if isinstance(c["args"], list) and len(c["args"]) == 2 and c["args"][0] == k]
        print(f"  kart {k}: expected {truth['gate_order']}  recorded {got}")
        ok &= check(f"kart {k} sequence == ground truth", got == truth["gate_order"])
    stray = sorted({c["args"][0] for c in calls
                    if isinstance(c["args"], list) and len(c["args"]) == 2} - set(kart_ids))
    ok &= check("no calls from unknown kart ids", not stray, f"stray: {stray}" if stray else "")
    ok &= check("total == 2 karts x ground truth",
                len(calls) == 2 * len(truth["gate_order"]),
                f"{len(calls)} vs {2 * len(truth['gate_order'])}")
    return ok


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--laps", type=int, default=2)
    ap.add_argument("--gates", type=int, default=3)
    ap.add_argument("--kart", type=int, default=1, help="kart id for phase A")
    ap.add_argument("--workdir", default=None, help="where to put video/truth (default: temp)")
    ap.add_argument("--keep", action="store_true", help="keep the temp workdir")
    ap.add_argument("--phase", choices=["a", "b", "both"], default="both")
    ap.add_argument("-v", "--verbose", action="store_true", help="echo the bridge's own log")
    args = ap.parse_args()

    work = Path(args.workdir) if args.workdir else Path(tempfile.mkdtemp(prefix="arkart-e2e-"))
    work.mkdir(parents=True, exist_ok=True)
    video, truth_path = work / "track.avi", work / "track.truth.json"

    t0 = time.monotonic()
    try:
        truth = run_generator(video, truth_path, laps=args.laps, gates=args.gates)
        print(f"generated {video.name}: {truth['frames']} frames / {truth['duration_s']}s, "
              f"ground truth {truth['gate_order']}")

        ok = True
        if args.phase in ("a", "both"):
            ok &= phase_a(work, truth, video, kart=args.kart, verbose=args.verbose)
        if args.phase in ("b", "both"):
            ok &= phase_b(work, truth, video, verbose=args.verbose)
    finally:
        if args.keep or args.workdir:
            print(f"\nartifacts kept in {work}")
        else:
            shutil.rmtree(work, ignore_errors=True)

    print(f"\n{'ACCEPTANCE MET' if ok else 'ACCEPTANCE FAILED'} "
          f"({time.monotonic() - t0:.1f}s)")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
