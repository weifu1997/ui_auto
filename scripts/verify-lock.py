#!/usr/bin/env python3
"""Verify installed Python packages match requirements.lock (REL-01)."""

from __future__ import annotations

import sys
from importlib import metadata
from pathlib import Path


def _normalize(name: str) -> str:
    return name.lower().replace("_", "-").replace(".", "-")


def read_lock(path: Path) -> dict[str, str]:
    pinned: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "==" not in line:
            continue
        name, version = line.split("==", 1)
        pinned[_normalize(name)] = version.strip()
    return pinned


def main() -> int:
    lock_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("server-py/requirements.lock")
    if not lock_path.is_file():
        print(f"missing {lock_path}", file=sys.stderr)
        return 2
    pinned = read_lock(lock_path)
    installed = {
        _normalize(dist.metadata.get("Name") or ""): dist.version
        for dist in metadata.distributions()
    }
    mismatches = [
        f"{name}: locked {pinned[name]} != installed {installed.get(name)}"
        for name in sorted(pinned)
        if installed.get(name) is not None and installed.get(name) != pinned[name]
    ]
    if mismatches:
        print("\n".join(mismatches), file=sys.stderr)
        return 1
    print(f"ok ({len(pinned)} pinned packages)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
