import asyncio

from autoflow.main import SecureTransportMiddleware
from autoflow.transport import (
    effective_https,
    forwarded_client_ip,
    is_https_probe_path,
    require_https,
    trusted_proxy,
)


def test_effective_https_direct_tls():
    assert effective_https({"scheme": "https"}, None) is True


def test_effective_https_plain_http_rejected_without_proxy():
    scope = {
        "scheme": "http",
        "headers": [(b"x-forwarded-proto", b"https")],
        "client": ("10.0.0.5", 1234),
    }
    assert effective_https(scope, None) is False


def test_effective_https_forwarded_from_loopback_proxy():
    scope = {
        "scheme": "http",
        "headers": [(b"x-forwarded-proto", b"https")],
        "client": ("127.0.0.1", 1234),
    }
    assert effective_https(scope, "proxy.internal") is True


def test_effective_https_forwarded_from_configured_proxy():
    scope = {
        "scheme": "http",
        "headers": [(b"x-forwarded-proto", b"https")],
        "client": ("proxy.internal", 1234),
    }
    assert effective_https(scope, "proxy.internal") is True


def test_effective_https_rejects_untrusted_forwarded_proto():
    scope = {
        "scheme": "http",
        "headers": [(b"x-forwarded-proto", b"https")],
        "client": ("10.0.0.5", 1234),
    }
    assert effective_https(scope, "proxy.internal") is False


def test_effective_https_plain_http_with_trusted_proxy_configured():
    scope = {"scheme": "http", "headers": [], "client": ("127.0.0.1", 1234)}
    assert effective_https(scope, "proxy.internal") is False


def test_require_https_flag(monkeypatch):
    monkeypatch.delenv("AUTOFLOW_REQUIRE_HTTPS", raising=False)
    assert require_https() is False
    monkeypatch.setenv("AUTOFLOW_REQUIRE_HTTPS", "1")
    assert require_https() is True


def test_trusted_proxy_resolution(monkeypatch):
    monkeypatch.delenv("AUTOFLOW_TRUSTED_PROXY", raising=False)
    assert trusted_proxy() is None
    monkeypatch.setenv("AUTOFLOW_TRUSTED_PROXY", "  proxy.internal  ")
    assert trusted_proxy() == "proxy.internal"


def test_https_probe_paths():
    assert is_https_probe_path("/ready") is True
    assert is_https_probe_path("/health") is True
    assert is_https_probe_path("/api/auth/login") is False


def test_https_middleware_allows_probe_paths_over_http():
    async def app(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    middleware = SecureTransportMiddleware(app, trusted_proxy=None, require_https=True)

    async def status_for(path: str) -> int:
        seen: dict[str, int] = {}

        async def send(message):
            if message["type"] == "http.response.start":
                seen["code"] = int(message["status"])

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        scope = {
            "type": "http",
            "path": path,
            "scheme": "http",
            "headers": [],
            "client": ("127.0.0.1", 1),
        }
        await middleware(scope, receive, send)
        return seen["code"]

    assert asyncio.run(status_for("/ready")) == 200
    assert asyncio.run(status_for("/health")) == 200
    assert asyncio.run(status_for("/api/auth/login")) == 426


def test_forwarded_client_ip_ignores_header_without_trusted_proxy():
    assert (
        forwarded_client_ip(
            "10.0.0.5",
            {"x-forwarded-for": "203.0.113.9"},
            None,
        )
        == "10.0.0.5"
    )


def test_forwarded_client_ip_uses_xff_from_trusted_proxy():
    assert (
        forwarded_client_ip(
            "proxy.internal",
            {"x-forwarded-for": "203.0.113.9, 10.0.0.1"},
            "proxy.internal",
        )
        == "203.0.113.9"
    )


def test_forwarded_client_ip_uses_xff_from_loopback_when_proxy_configured():
    assert (
        forwarded_client_ip(
            "127.0.0.1",
            {"x-forwarded-for": "198.51.100.7"},
            "proxy.internal",
        )
        == "198.51.100.7"
    )
