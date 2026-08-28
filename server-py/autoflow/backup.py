"""Backup manifest and verification helpers (BKP-02)."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from .crypto import decrypt_bytes, encrypt_bytes


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_manifest(directory: Path) -> dict[str, Any]:
    files: dict[str, dict[str, Any]] = {}
    for path in sorted(directory.rglob("*")):
        if not path.is_file() or path.name == "manifest.json":
            continue
        rel = path.relative_to(directory).as_posix()
        files[rel] = {"sha256": sha256_file(path), "size": path.stat().st_size}
    return {"version": 1, "files": files}


def write_manifest(directory: Path) -> dict[str, Any]:
    manifest = build_manifest(directory)
    (directory / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return manifest


REQUIRED_BACKUP_FILES = ("platform.sqlite",)


def _contained_file(directory: Path, rel: str) -> Path | None:
    if not isinstance(rel, str) or not rel or rel.startswith("/") or ".." in Path(rel).parts:
        return None
    path = (directory / rel).resolve()
    try:
        path.relative_to(directory.resolve())
    except ValueError:
        return None
    return path


def verify_manifest(directory: Path) -> bool:
    manifest_path = directory / "manifest.json"
    if not manifest_path.is_file():
        return False
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("version") != 1:
            return False
        files = manifest.get("files")
        if not isinstance(files, dict):
            return False
        for required in REQUIRED_BACKUP_FILES:
            if required not in files:
                return False
        for rel, meta in files.items():
            path = _contained_file(directory, rel)
            if path is None or not path.is_file():
                return False
            if path.stat().st_size != meta.get("size"):
                return False
            if sha256_file(path) != meta.get("sha256"):
                return False
        return True
    except Exception:
        return False


def encrypt_directory(
    source: Path, destination: Path, secret: str | None = None
) -> dict[str, Any]:
    """Encrypt every file and store ciphertext + nonce/tag in a manifest."""
    destination.mkdir(parents=True, exist_ok=True)
    files: dict[str, dict[str, Any]] = {}
    for path in sorted(source.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(source).as_posix()
        value = encrypt_bytes(path.read_bytes(), secret)
        files[rel] = {
            "iv": value.iv,
            "tag": value.tag,
            "ciphertext": value.ciphertext,
            "size": path.stat().st_size,
        }
    manifest = {"version": 1, "encrypted": True, "files": files}
    (destination / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return manifest


def decrypt_directory(
    source: Path, destination: Path, secret: str | None = None
) -> None:
    """Decrypt a manifest-based encrypted backup back to plain files."""
    manifest_path = source / "manifest.json"
    if not manifest_path.is_file():
        raise RuntimeError("Backup manifest missing")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not manifest.get("encrypted"):
        raise RuntimeError("Backup manifest is not encrypted")
    destination.mkdir(parents=True, exist_ok=True)
    for rel, meta in manifest.get("files", {}).items():
        plaintext = decrypt_bytes(
            {
                "iv": meta["iv"],
                "tag": meta["tag"],
                "ciphertext": meta["ciphertext"],
            },
            secret,
        )
        if len(plaintext) != meta.get("size"):
            raise RuntimeError(f"Size mismatch for {rel}")
        target = destination / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(plaintext)


if __name__ == "__main__":
    import sys

    if len(sys.argv) != 3:
        raise SystemExit(
            "usage: backup.py <write-manifest|verify-manifest> <directory>"
        )
    command, directory = sys.argv[1], Path(sys.argv[2])
    if command == "write-manifest":
        write_manifest(directory)
        print(f"wrote manifest for {directory}")
    elif command == "verify-manifest":
        print("ok" if verify_manifest(directory) else "mismatch")
    else:
        raise SystemExit(f"unknown command: {command}")
