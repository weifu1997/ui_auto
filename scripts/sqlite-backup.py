#!/usr/bin/env python3
"""SQLite backup helper matching scripts/sqlite-backup.mjs."""

from __future__ import annotations

import shutil
import sqlite3
import sys
import time
from pathlib import Path


def _integrity_ok(database: sqlite3.Connection) -> bool:
    return database.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def _source_stats(database: sqlite3.Connection) -> dict[str, tuple[int, str | None]]:
    stats: dict[str, tuple[int, str | None]] = {}
    for table in ("platform_users", "platform_runs"):
        exists = database.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
            (table,),
        ).fetchone()
        if not exists:
            continue
        row = database.execute(
            f"SELECT COUNT(*), MAX(created_at) FROM {table}"
        ).fetchone()
        stats[table] = (int(row[0]), row[1])
    return stats


def backup(source: str, destination: str) -> None:
    source_path = Path(source)
    if not source_path.exists():
        return
    database = sqlite3.connect(source_path)
    try:
        if not _integrity_ok(database):
            raise RuntimeError(
                f"Integrity check failed: {database.execute('PRAGMA integrity_check').fetchone()[0]}"
            )
        checkpoint = database.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
        attempt = 1
        while checkpoint[0] == 1 and attempt <= 3:
            time.sleep(1)
            checkpoint = database.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
            attempt += 1
        if checkpoint[0] != 0:
            raise RuntimeError(
                f"WAL checkpoint did not complete (busy={checkpoint[0]}); backup aborted"
            )
        stats = _source_stats(database)
    finally:
        database.close()
    shutil.copyfile(source_path, destination)
    copy = sqlite3.connect(f"file:{destination}?mode=ro", uri=True)
    try:
        if not _integrity_ok(copy):
            raise RuntimeError("Backup verification failed")
        for table, expected in stats.items():
            actual = copy.execute(
                f"SELECT COUNT(*), MAX(created_at) FROM {table}"
            ).fetchone()
            actual_value = (int(actual[0]), actual[1])
            if actual_value != expected:
                raise RuntimeError(
                    f"Backup row-count mismatch on {table}: source {expected} vs copy {actual_value}"
                )
    finally:
        copy.close()


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: sqlite-backup.py <source.sqlite> <destination.sqlite>")
    backup(sys.argv[1], sys.argv[2])
