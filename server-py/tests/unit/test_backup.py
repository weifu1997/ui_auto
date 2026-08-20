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


def test_encrypt_bytes_roundtrip():
    plaintext = b"\x00\x01\x02\x03binary-backup"
    encrypted = encrypt_bytes(plaintext, "backup-secret")
    assert decrypt_bytes(encrypted, "backup-secret") == plaintext


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
