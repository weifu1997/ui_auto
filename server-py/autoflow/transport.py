"""Secure transport helpers: HTTPS enforcement and trusted-proxy validation."""

from __future__ import annotations

import os


def trusted_proxy() -> str | None:
    value = os.environ.get("AUTOFLOW_TRUSTED_PROXY", "").strip()
    return value or None


def require_https() -> bool:
    return os.environ.get("AUTOFLOW_REQUIRE_HTTPS") == "1"


def effective_https(scope: dict, proxy: str | None) -> bool:
    """Return True only when the transport is TLS, or is forwarded as HTTPS by a
    trusted reverse proxy.

    A loopback client is always trusted; otherwise the client address must match the
    configured AUTOFLOW_TRUSTED_PROXY host.
    """
    if scope.get("scheme") == "https":
        return True
    headers = dict(
        (key.decode("latin-1").lower(), value.decode("latin-1"))
        for key, value in scope.get("headers", [])
    )
    if headers.get("x-forwarded-proto") != "https":
        return False
    if proxy is None:
        return False
    client = scope.get("client")
    host = client[0] if client else None
    return host in ("127.0.0.1", "::1", "localhost") or host == proxy
