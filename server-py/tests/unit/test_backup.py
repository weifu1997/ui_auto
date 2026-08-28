import json

from autoflow.backup import (
    decrypt_directory,
    encrypt_directory,
    verify_manifest,
    write_manifest,
)
from autoflow.crypto import decrypt_bytes, encrypt_bytes


def test_manifest_verify_roundtrip(tmp_path):
    data = tmp_path / "backup"
    data.mkdir()
    (data / "platform.sqlite").write_bytes(b"sqlite-bytes")
    (data / "artifacts").mkdir()
    (data / "artifacts" / "shot.png").write_bytes(b"\x00\x01\x02")

    write_manifest(data)
    assert verify_manifest(data) is True

    # Tamper with a file — verification must fail.
    (data / "platform.sqlite").write_bytes(b"tampered")
    assert verify_manifest(data) is False


def test_manifest_verify_requires_platform_sqlite(tmp_path):
    data = tmp_path / "backup"
    data.mkdir()
    (data / "notes.txt").write_text("no db", encoding="utf-8")
    write_manifest(data)
    manifest = data / "manifest.json"
    payload = json.loads(manifest.read_text(encoding="utf-8"))
    payload["files"].pop("platform.sqlite", None)
    manifest.write_text(json.dumps(payload), encoding="utf-8")
    assert verify_manifest(data) is False


def test_manifest_verify_rejects_empty_files(tmp_path):
    data = tmp_path / "backup"
    data.mkdir()
    (data / "platform.sqlite").write_bytes(b"sqlite-bytes")
    (data / "manifest.json").write_text(
        json.dumps({"version": 1, "files": {}}), encoding="utf-8"
    )
    assert verify_manifest(data) is False


def test_encrypt_bytes_roundtrip():
    plaintext = b"\x00\x01\x02\x03binary-backup"
    encrypted = encrypt_bytes(plaintext, "backup-secret")
    assert decrypt_bytes(encrypted, "backup-secret") == plaintext


def test_ops_backup_manifest_cli_requires_platform_sqlite(tmp_path):
    import importlib.util
    from pathlib import Path

    script = (
        Path(__file__).resolve().parents[3]
        / "scripts"
        / "ops"
        / "backup-manifest.py"
    )
    spec = importlib.util.spec_from_file_location("backup_manifest_cli", script)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)

    data = tmp_path / "cli-backup"
    data.mkdir()
    (data / "notes.txt").write_text("no db", encoding="utf-8")
    module.write_manifest(data)
    payload = json.loads((data / "manifest.json").read_text(encoding="utf-8"))
    payload["files"].pop("platform.sqlite", None)
    (data / "manifest.json").write_text(json.dumps(payload), encoding="utf-8")
    assert module.verify_manifest(data) is False


def test_encrypted_directory_roundtrip(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    (source / "platform.sqlite").write_bytes(b"platform-db")
    (source / "artifacts").mkdir()
    (source / "artifacts" / "shot.png").write_bytes(b"png-bytes")

    encrypted = tmp_path / "encrypted"
    encrypt_directory(source, encrypted, "backup-secret")
    assert not (encrypted / "platform.sqlite").exists()
    assert (encrypted / "manifest.json").exists()

    restored = tmp_path / "restored"
    decrypt_directory(encrypted, restored, "backup-secret")
    assert (restored / "platform.sqlite").read_bytes() == b"platform-db"
    assert (restored / "artifacts" / "shot.png").read_bytes() == b"png-bytes"
