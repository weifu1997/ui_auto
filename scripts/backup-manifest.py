#!/usr/bin/env python3
"""Standalone manifest CLI used by backup.ps1 / restore.ps1 (BKP-02)."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server-py"))

from autoflow.backup import verify_manifest, write_manifest  # noqa: E402


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
