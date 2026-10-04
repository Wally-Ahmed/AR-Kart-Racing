"""The SpacetimeDB report_gate call — URL shape and payload, with HTTP mocked.

Format verified 2026-09-20 against the SpacetimeDB HTTP API reference
(docs/.../00300-database.md, clockworklabs/SpacetimeDB @ master):

    POST /v1/database/:name_or_identity/call/:reducer
    Data: "A JSON array of arguments to the reducer."
    Optional Authorization: Bearer <spacetime token>; absent = anonymous.
"""

from __future__ import annotations

import json
import logging

import pytest

from arkart_vision.reducer import (
    ReducerClient,
    build_report_gate_request,
    build_reducer_request,
)


class FakeResponse:
    def __init__(self, status_code=200, text=""):
        self.status_code = status_code
        self.text = text


class FakeSession:
    """Records every POST instead of making one."""

    def __init__(self, response=None, raise_exc=None):
        self.calls: list[dict] = []
        self.response = response or FakeResponse(200)
        self.raise_exc = raise_exc
        self.closed = False

    def post(self, url, json=None, headers=None, timeout=None, **kw):
        self.calls.append({"url": url, "json": json, "headers": headers, "timeout": timeout})
        if self.raise_exc:
            raise self.raise_exc
        return self.response

    def close(self):
        self.closed = True


# --- the documented endpoint format ---------------------------------------


def test_report_gate_url_matches_the_documented_endpoint():
    """ACCEPTANCE: POST /v1/database/<db>/call/report_gate."""
    req = build_report_gate_request(1, 7, base_url="http://localhost:3000", database="arkart")
    assert req.url == "http://localhost:3000/v1/database/arkart/call/report_gate"


def test_report_gate_body_is_a_positional_json_array():
    """ACCEPTANCE: body is a JSON array of arguments -> [kart_id, tag_id]."""
    req = build_report_gate_request(2, 13)
    assert req.json == [2, 13]
    assert isinstance(req.json, list)
    assert json.loads(json.dumps(req.json)) == [2, 13]   # serialises as a bare array
    assert req.headers["Content-Type"] == "application/json"


def test_args_are_coerced_to_plain_ints():
    """numpy int64 out of cv2 would not be JSON-serialisable."""
    import numpy as np

    req = build_report_gate_request(np.int64(1), np.int32(7))
    assert req.json == [1, 7]
    assert all(type(v) is int for v in req.json)
    json.dumps(req.json)  # must not raise


def test_no_token_means_no_authorization_header():
    """Anonymous is the documented default and what the LAN demo wants (spec §4)."""
    req = build_report_gate_request(1, 7, token=None)
    assert "Authorization" not in req.headers


def test_token_becomes_bearer_auth():
    req = build_report_gate_request(1, 7, token="abc123")
    assert req.headers["Authorization"] == "Bearer abc123"


def test_base_url_trailing_slash_does_not_double_up():
    req = build_report_gate_request(1, 7, base_url="http://localhost:3000/", database="arkart")
    assert req.url == "http://localhost:3000/v1/database/arkart/call/report_gate"


def test_adapter_generalises_to_any_reducer():
    """One function to fix if Clockwork changes the wire format."""
    req = build_reducer_request("set_input", [1, 0.5, -0.25], base_url="http://h:3000",
                                database="arkart")
    assert req.url == "http://h:3000/v1/database/arkart/call/set_input"
    assert req.json == [1, 0.5, -0.25]


# --- the client -----------------------------------------------------------


def test_client_posts_the_documented_request():
    """ACCEPTANCE: mocked report_gate call has the documented endpoint format."""
    session = FakeSession()
    client = ReducerClient(base_url="http://localhost:3000", database="arkart",
                           session=session, token=None)
    assert client.report_gate(1, 7) is True

    assert len(session.calls) == 1
    call = session.calls[0]
    assert call["url"] == "http://localhost:3000/v1/database/arkart/call/report_gate"
    assert call["json"] == [1, 7]
    assert call["headers"]["Content-Type"] == "application/json"
    assert "Authorization" not in call["headers"]
    assert call["timeout"] == pytest.approx(1.0)
    assert (client.sent, client.failed) == (1, 0)


def test_client_accepts_204_no_content():
    """A reducer returning nothing is a 2xx, not a failure."""
    client = ReducerClient(session=FakeSession(FakeResponse(204)))
    assert client.report_gate(1, 7) is True
    assert client.sent == 1


def test_http_error_is_counted_and_swallowed(caplog):
    """A rejected gate must never kill the detector loop."""
    client = ReducerClient(session=FakeSession(FakeResponse(400, "no such reducer")))
    with caplog.at_level(logging.WARNING):
        assert client.report_gate(1, 7) is False
    assert (client.sent, client.failed) == (0, 1)
    assert "400" in caplog.text


def test_network_exception_is_swallowed(caplog):
    """STDB not up yet / WiFi blip: log and carry on."""
    import requests

    client = ReducerClient(session=FakeSession(raise_exc=requests.ConnectionError("refused")))
    with caplog.at_level(logging.WARNING):
        assert client.report_gate(1, 7) is False
    assert (client.sent, client.failed) == (0, 1)


def test_client_close_closes_the_session():
    session = FakeSession()
    ReducerClient(session=session).close()
    assert session.closed


# --- config wiring --------------------------------------------------------


def test_karts_json_loads_with_the_conductor_contract(tmp_path):
    """karts.json ships kart ids 1 and 2 on http://<ip>/stream."""
    from arkart_vision.config import DEFAULT_KARTS_FILE, load_config

    cfg = load_config(DEFAULT_KARTS_FILE)
    assert [k.kart_id for k in cfg.karts] == [1, 2]
    assert all(k.stream_url.startswith("http://") and k.stream_url.endswith("/stream")
               for k in cfg.karts)
    assert cfg.stdb_base_url == "http://localhost:3000"
    assert cfg.stdb_database == "arkart"
    assert cfg.tag_whitelist == frozenset(range(16))


def test_load_config_rejects_duplicate_kart_ids(tmp_path):
    from arkart_vision.config import load_config

    p = tmp_path / "karts.json"
    p.write_text(json.dumps({"karts": [{"kart_id": 1, "stream_url": "http://a/stream"},
                                       {"kart_id": 1, "stream_url": "http://b/stream"}]}))
    with pytest.raises(ValueError, match="duplicate kart_id"):
        load_config(p)


def test_debounced_pass_flows_into_a_well_formed_post():
    """The seam that matters: detector IDs -> debouncer -> exactly one documented POST."""
    from arkart_vision.debounce import GateDebouncer

    session = FakeSession()
    client = ReducerClient(base_url="http://localhost:3000", database="arkart",
                           session=session, token=None)
    deb = GateDebouncer(confirm_frames=2, confirm_window_s=0.5, miss_tolerance_frames=1,
                        cooldown_s=1.5)

    t = 100.0
    for _ in range(12):                       # one 0.6 s pass of gate 7 by kart 2
        for gp in deb.observe(2, {7}, t):
            client.report_gate(gp.kart_id, gp.tag_id)
        t += 0.05

    assert len(session.calls) == 1
    assert session.calls[0]["url"] == "http://localhost:3000/v1/database/arkart/call/report_gate"
    assert session.calls[0]["json"] == [2, 7]
