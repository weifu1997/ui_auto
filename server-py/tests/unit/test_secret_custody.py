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
