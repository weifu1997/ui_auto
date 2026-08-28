import pytest

from autoflow.crypto import DEFAULT_PLATFORM_SECRET
from autoflow.services import PlatformServices


def test_platform_services_reads_secret_key_file(tmp_path, monkeypatch):
    key_file = tmp_path / "platform-secret.key"
    key_file.write_text("file-secret-value\n", encoding="utf-8")
    monkeypatch.delenv("PLATFORM_SECRET_KEY", raising=False)
    monkeypatch.setenv("PLATFORM_SECRET_KEY_FILE", str(key_file))

    services = PlatformServices(str(tmp_path / "data"))
    try:
        assert services._configured_secret == "file-secret-value"
    finally:
        services.close()


def test_platform_services_rejects_missing_secret_without_opt_in(tmp_path, monkeypatch):
    monkeypatch.delenv("PLATFORM_SECRET_KEY", raising=False)
    monkeypatch.delenv("PLATFORM_SECRET_KEY_FILE", raising=False)
    monkeypatch.delenv("AUTOFLOW_ALLOW_INSECURE_DEV_KEY", raising=False)
    monkeypatch.delenv("NODE_ENV", raising=False)
    with pytest.raises(RuntimeError, match="AUTOFLOW_ALLOW_INSECURE_DEV_KEY"):
        PlatformServices(str(tmp_path / "data"))


def test_platform_services_allows_insecure_dev_key(tmp_path, monkeypatch):
    monkeypatch.delenv("PLATFORM_SECRET_KEY", raising=False)
    monkeypatch.delenv("PLATFORM_SECRET_KEY_FILE", raising=False)
    monkeypatch.setenv("AUTOFLOW_ALLOW_INSECURE_DEV_KEY", "1")
    monkeypatch.delenv("NODE_ENV", raising=False)
    services = PlatformServices(str(tmp_path / "data"))
    try:
        assert services._configured_secret == DEFAULT_PLATFORM_SECRET
    finally:
        services.close()


def test_platform_services_production_ignores_insecure_dev_opt_in(tmp_path, monkeypatch):
    monkeypatch.delenv("PLATFORM_SECRET_KEY", raising=False)
    monkeypatch.delenv("PLATFORM_SECRET_KEY_FILE", raising=False)
    monkeypatch.setenv("AUTOFLOW_ALLOW_INSECURE_DEV_KEY", "1")
    monkeypatch.setenv("NODE_ENV", "production")
    with pytest.raises(RuntimeError, match="required in production"):
        PlatformServices(str(tmp_path / "data"))
