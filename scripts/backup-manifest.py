#!/usr/bin/env python3
"""Standalone SHA-256 manifest CLI used by backup.ps1 / restore.ps1 (BKP-02).

Kept stdlib-only so it runs with any system Python (no cryptography dependency).
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_manifest(directory: Path) -> dict:
    files: dict[str, dict] = {}
    for path in sorted(directory.rglob("*")):
        if not path.is_file() or path.name == "manifest.json":
            continue
        rel = path.relative_to(directory).as_posix()
        files[rel] = {"sha256": sha256_file(path), "size": path.stat().st_size}
    manifest = {"version": 1, "files": files}
    (directory / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return manifest


def verify_manifest(directory: Path) -> bool:
    manifest_path = directory / "manifest.json"
    if not manifest_path.is_file():
        return False
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        for rel, meta in manifest.get("files", {}).items():
            path = directory / rel
            if not path.is_file():
                return False
            if path.stat().st_size != meta.get("size"):
                return False
            if sha256_file(path) != meta.get("sha256"):
                return False
        return True
    except Exception:
        return False


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: backup-manifest.py <write|verify> <directory>", file=sys.stderr)
        return 2
    command, directory = sys.argv[1], Path(sys.argv[2])
    if command == "write":
        write_manifest(directory)
        print(f"wrote manifest for {directory}")
    elif command == "verify":
        if verify_manifest(directory):
            print("ok")
        else:
            print("mismatch", file=sys.stderr)
            return 1
    else:
        print(f"unknown command: {command}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
