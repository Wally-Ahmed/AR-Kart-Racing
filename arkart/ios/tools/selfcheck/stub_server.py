#!/usr/bin/env python3
"""Stub SpacetimeDB HTTP server used by tools/verify.sh.

Implements just enough of the real v1 HTTP API to exercise the app's two
adapter functions for real:

    POST /v1/database/arkart/call/<reducer>   -> 200, body logged
    POST /v1/database/arkart/sql              -> 200, canned SATS-JSON result set

Every request is appended as one JSON line to the log file given in argv[2],
so the Swift harness can assert on the exact paths, bodies and rates.
"""
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 38731
LOG_PATH = sys.argv[2] if len(sys.argv) > 2 else "/tmp/arkart-stub.log"

_log_lock = threading.Lock()


def now_ms():
    return int(time.time() * 1000)


def now_us():
    return int(time.time() * 1_000_000)


def some(value):
    """SATS positional Option::some — exactly what the live module emits."""
    return [0, value]


NONE = [1, []]


def ts(micros):
    """Timestamp = a one-field product: [micros_since_unix_epoch]."""
    return [micros]


def sql_response(query=""):
    """Statement result(s) for one query.

    The real server takes exactly ONE statement per request, so this stub picks
    the matching table out of the set below; an unrecognised query gets them all.

    Column names and value encodings copied from a real response of the
    published `arkart` module (SpacetimeDB 2.4.1) — positional Options,
    `[micros]` timestamps, item ids and effect kinds as plain strings.
    The third statement also carries `source_kart`, as the real table does.
    """

    def product(*names):
        return {"elements": [{"name": {"some": n}, "algebraic_type": {}} for n in names]}

    if ";" in query.strip().rstrip(";"):
        # Mirror the real server, which refuses multi-statement bodies.
        return None

    tables = [
        {
            "schema": product("kart_id", "lap", "next_idx", "last_pass_at",
                              "placement", "finished_at"),
            "rows": [[1, 1, 2, ts(now_us() - 4_000_000), 2, NONE]],
        },
        {
            "schema": product("kart_id", "slot_1", "slot_2"),
            "rows": [[1, some("boost"), some("shield")]],
        },
        {
            "schema": product("id", "kart_id", "kind", "multiplier", "expires_at",
                              "source_kart"),
            "rows": [
                [7, 1, "shield", 1.0, NONE, 1],
                [8, 1, "ink", 1.0, some(ts(now_us() + 3_500_000)), 2],
                [9, 1, "dizzy", 1.0, some(ts(now_us() + 2_500_000)), 2],
            ],
        },
        {
            "schema": product("id", "lap_count", "item_roll_pct", "state",
                              "countdown_ends_at"),
            "rows": [[0, 3, 100, "running", NONE]],
        },
    ]

    lowered = query.lower()
    for keyword, table in (("from progress", tables[0]), ("from inventory", tables[1]),
                           ("from effect", tables[2]), ("from config", tables[3])):
        if keyword in lowered:
            return [table]
    return tables


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass  # silence stderr spam

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length).decode("utf-8", "replace") if length else ""
        entry = {
            "t": time.time(),
            "path": self.path,
            "content_type": self.headers.get("Content-Type"),
            "body": body,
        }
        with _log_lock:
            with open(LOG_PATH, "a") as fh:
                fh.write(json.dumps(entry) + "\n")

        status = 200
        if self.path.endswith("/sql"):
            result = sql_response(body)
            if result is None:
                status = 400
                payload = b"Multiple SQL statements are not supported"
            else:
                payload = json.dumps(result).encode()
        else:
            payload = b"{}"
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


if __name__ == "__main__":
    open(LOG_PATH, "w").close()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"stub listening on 127.0.0.1:{PORT}", flush=True)
    server.serve_forever()
