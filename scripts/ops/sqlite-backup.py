#!/usr/bin/env python3
"""SQLite backup helper matching scripts/sqlite-backup.mjs."""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path


def _integrity_ok(database: sqlite3.Connection) -> bool:
    return database.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def _drop_sidecars(base: Path) -> None:
    """Best-effort remove SQLite WAL/SHM sidecars for ``base``.

    ``Connection.backup`` produces a file that keeps its ``journal_mode``; a
    read-only verification open can briefly recreate ``-shm``. Leave no stale
    companion files behind the moved backup.
    """
    for suffix in ("-wal", "-shm"):
        try:
            Path(f"{base}{suffix}").unlink()
        except FileNotFoundError:
            pass


def backup(source: str, destination: str, required: bool = False) -> None:
    source_path = Path(source)
    if not source_path.exists():
        if required:
            raise SystemExit(f"Required database missing: {source_path}")
        return
    # Connection.backup() takes a consistent snapshot of a live WAL database
    # without needing a TRUNCATE checkpoint first. The previous raw copyfile
    # after wal_checkpoint raced with live writers: a transaction committed
    # between the checkpoint and the copy lived only in a fresh -wal and was
    # silently omitted, and any older reader kept wal_checkpoint busy, aborting
    # the whole backup.
    temp_path = Path(f"{destination}.tmp")
    source_conn = sqlite3.connect(source_path)
    try:
        if not _integrity_ok(source_conn):
            raise RuntimeError(
                f"Integrity check failed: {source_conn.execute('PRAGMA integrity_check').fetchone()[0]}"
            )
        temp_conn = sqlite3.connect(temp_path)
        try:
            source_conn.backup(temp_conn)
            # Fold all frames into the main file so the moved backup is
            # self-contained and never depends on a sidecar -wal at rest.
            temp_conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            temp_conn.commit()
        finally:
            temp_conn.close()
        _drop_sidecars(temp_path)
        copy = sqlite3.connect(f"file:{temp_path}?mode=ro", uri=True)
        try:
            if not _integrity_ok(copy):
                raise RuntimeError("Backup verification failed")
        finally:
            copy.close()
        _drop_sidecars(temp_path)
        temp_path.replace(destination)
    finally:
        source_conn.close()
        if temp_path.exists():
            temp_path.unlink()
        _drop_sidecars(temp_path)


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4):
        raise SystemExit(
            "usage: sqlite-backup.py <source.sqlite> <destination.sqlite> [required]"
        )
    backup(sys.argv[1], sys.argv[2], required=len(sys.argv) == 4)
