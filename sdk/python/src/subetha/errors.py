"""Errors raised by the SubEtha client (spec §9)."""

from __future__ import annotations

from typing import Any

import httpx

# Fallback codes when a server (or a proxy in front of it) returns a non-JSON error body.
_STATUS_CODES = {
    400: "bad_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    409: "conflict",
    413: "message_too_large",
    429: "rate_limited",
    500: "internal",
    503: "provider_unavailable",
}


class SubEthaError(Exception):
    """An error response from the relay.

    ``code`` is the stable error code (see spec/errors.json), ``http`` the HTTP status, and
    ``body`` the full decoded JSON error body (extra fields such as ``shortfall_usd_micros``).
    """

    def __init__(
        self,
        code: str,
        http: int,
        message: str = "",
        body: dict[str, Any] | None = None,
        retry_after: float | None = None,
    ) -> None:
        super().__init__(f"{code} (HTTP {http}): {message}" if message else f"{code} (HTTP {http})")
        self.code = code
        self.http = http
        self.message = message
        self.body = body if body is not None else {}
        self.retry_after = retry_after

    @property
    def retryable(self) -> bool:
        return self.http == 429 or self.http >= 500

    @classmethod
    def from_response(cls, r: httpx.Response) -> SubEthaError:
        retry_after = None
        ra = r.headers.get("retry-after")
        if ra:
            try:
                retry_after = float(ra)
            except ValueError:
                retry_after = None
        try:
            body = r.json()
        except ValueError:
            body = None
        if isinstance(body, dict) and isinstance(body.get("error"), str):
            http = body.get("http")
            return cls(
                body["error"],
                http if isinstance(http, int) and not isinstance(http, bool) else r.status_code,
                str(body.get("message") or ""),
                body,
                retry_after,
            )
        code = _STATUS_CODES.get(r.status_code, f"http_{r.status_code}")
        text = r.text.strip()[:500] or r.reason_phrase
        return cls(code, r.status_code, text, None, retry_after)
