from autoflow.transport import effective_https, require_https, trusted_proxy


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
