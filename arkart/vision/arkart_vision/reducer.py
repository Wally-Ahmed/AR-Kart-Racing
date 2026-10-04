"""The one place the SpacetimeDB HTTP call format lives.

VERIFIED against the SpacetimeDB HTTP API reference
(docs/docs/00300-resources/00200-reference/00200-http-api/00300-database.md,
clockworklabs/SpacetimeDB @ master, fetched 2026-09-20):

    POST /v1/database/:name_or_identity/call/:reducer

      Path parameters
        :reducer          The name of the reducer OR procedure.
      Optional headers
        Authorization     A Spacetime token as Bearer auth. If absent, the request
                          is treated as ANONYMOUS and the caller's identity is
                          passed to the reducer via its ReducerContext.
      Data
        "A JSON array of arguments to the reducer."   <- POSITIONAL, not named.

So ``report_gate(kart_id: u32, tag_id: u32)`` is:

    POST http://localhost:3000/v1/database/arkart/call/report_gate
    Content-Type: application/json

    [1, 7]

If Clockwork changes the wire format, ``build_report_gate_request`` is the single
function to edit — everything else calls through it.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import requests

from . import config

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class ReducerRequest:
    """A fully-formed reducer call, before it is sent. Assertable in tests."""

    url: str
    json: list[Any]
    headers: dict[str, str]
    timeout: float


def build_reducer_request(
    reducer: str,
    args: list[Any],
    *,
    base_url: str = config.STDB_BASE_URL,
    database: str = config.STDB_DATABASE,
    token: str | None = config.STDB_TOKEN,
    timeout: float = config.STDB_TIMEOUT_S,
) -> ReducerRequest:
    """THE adapter. Build a SpacetimeDB HTTP reducer call.

    Body is a JSON array of POSITIONAL arguments, per the HTTP API reference.
    """
    url = f"{base_url.rstrip('/')}/v1/database/{database}/call/{reducer}"
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return ReducerRequest(url=url, json=list(args), headers=headers, timeout=timeout)


def build_report_gate_request(
    kart_id: int,
    tag_id: int,
    *,
    base_url: str = config.STDB_BASE_URL,
    database: str = config.STDB_DATABASE,
    token: str | None = config.STDB_TOKEN,
    timeout: float = config.STDB_TIMEOUT_S,
) -> ReducerRequest:
    """``report_gate(kart_id, tag_id)`` -> POST .../call/report_gate  body ``[kart_id, tag_id]``."""
    return build_reducer_request(
        config.STDB_REDUCER,
        [int(kart_id), int(tag_id)],
        base_url=base_url,
        database=database,
        token=token,
        timeout=timeout,
    )


class ReducerClient:
    """Fire-and-log ``report_gate`` caller over a pooled requests.Session."""

    def __init__(
        self,
        *,
        base_url: str = config.STDB_BASE_URL,
        database: str = config.STDB_DATABASE,
        token: str | None = config.STDB_TOKEN,
        timeout: float = config.STDB_TIMEOUT_S,
        session: "requests.Session | None" = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.database = database
        self.token = token
        self.timeout = timeout
        self.session = session or requests.Session()
        self.sent = 0
        self.failed = 0

    def build(self, kart_id: int, tag_id: int) -> ReducerRequest:
        return build_report_gate_request(
            kart_id,
            tag_id,
            base_url=self.base_url,
            database=self.database,
            token=self.token,
            timeout=self.timeout,
        )

    def report_gate(self, kart_id: int, tag_id: int) -> bool:
        """POST the gate pass. Never raises — a dropped gate must not kill the loop."""
        req = self.build(kart_id, tag_id)
        try:
            resp = self.session.post(
                req.url, json=req.json, headers=req.headers, timeout=req.timeout
            )
        except Exception as exc:  # network down, STDB not up yet, DNS, ...
            self.failed += 1
            log.warning("report_gate(%s, %s) POST failed: %s", kart_id, tag_id, exc)
            return False

        if 200 <= resp.status_code < 300:
            self.sent += 1
            log.info("GATE kart=%s tag=%s -> %s", kart_id, tag_id, resp.status_code)
            return True

        self.failed += 1
        body = (resp.text or "")[:200]
        log.warning(
            "report_gate(%s, %s) -> HTTP %s %s", kart_id, tag_id, resp.status_code, body
        )
        return False

    def close(self) -> None:
        try:
            self.session.close()
        except Exception:  # pragma: no cover
            pass
