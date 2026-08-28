"""Secure transport helpers: HTTPS enforcement and trusted-proxy validation."""

from __future__ import annotations

import os
from typing import Any

# Local ops probes: upgrade.ps1 / soak-test hit these over loopback HTTP while
# AUTOFLOW_REQUIRE_HTTPS=1. They must not require TLS; authenticated API routes
# still do.
HTTPS_PROBE_PATHS = frozenset({"/ready", "/health"})


def trusted_proxy() -> str | None:
    value = os.environ.get("AUTOFLOW_TRUSTED_PROXY", "").strip()
    return value or None


def require_https() -> bool:
    return os.environ.get("AUTOFLOW_REQUIRE_HTTPS") == "1"


def is_https_probe_path(path: str) -> bool:
    return path in HTTPS_PROBE_PATHS


def _peer_is_trusted(peer: str | None, proxy: str | None) -> bool:
    if not peer:
        return False
    if peer in ("127.0.0.1", "::1", "localhost"):
        return proxy is not None
    return proxy is not None and peer == proxy


def forwarded_client_ip(
    peer: str | None,
    headers: Any,
    proxy: str | None,
) -> str:
    """Rate-limit key: socket peer, or X-Forwarded-For when the peer is trusted.

    Only the first (leftmost) X-Forwarded-For hop is used, and only when
    AUTOFLOW_TRUSTED_PROXY is set and the TCP peer is that proxy or loopback.
    Untrusted peers cannot spoof the header.
    """
    host = peer or "unknown"
    if not _peer_is_trusted(peer, proxy):
        return host
    forwarded = ""
    if hasattr(headers, "get"):
        forwarded = str(headers.get("x-forwarded-for") or "")
    first = forwarded.split(",")[0].strip()
    return first or host


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
