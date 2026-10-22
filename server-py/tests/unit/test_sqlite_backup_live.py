"""Live-WAL backup regression tests (P2-5).

``scripts/ops/sqlite-backup.py`` checkpoints the WAL and then
``shutil.copyfile``s the raw main database file. Against a live database:

* if another connection holds an old read snapshot, ``wal_checkpoint(TRUNCATE)``
  returns busy forever and ``backup()`` raises instead of producing any backup;
* a writer committing between the checkpoint and the raw copy leaves its
  transaction in a fresh ``-wal`` that the copy silently omits.

``sqlite3.Connection.backup()`` copies a consistent snapshot of a live WAL
database without requiring a checkpoint, so both failure modes must disappear.
"""

import importlib.util
import sqlite3
from pathlib import Path


def _load_module():
    script = (
        Path(__file__).resolve().parents[3] / "scripts" / "ops" / "sqlite-backup.py"
    )
    spec = importlib.util.spec_from_file_location("sqlite_backup_cli", script)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _wal_source(path: Path) -> None:
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
    conn.execute("INSERT INTO t(v) VALUES ('A')")
    conn.commit()
    conn.close()


def _rows(path: Path) -> list[tuple]:
    conn = sqlite3.connect(path)
    try:
        return conn.execute("SELECT v FROM t ORDER BY id").fetchall()
    finally:
        conn.close()


def test_backup_succeeds_against_live_wal_with_old_reader(tmp_path):
    """An older reader must not force the backup to give up: the snapshot should
    still be producible and contain the writer's committed transaction."""
    module = _load_module()
    source = tmp_path / "live.sqlite"
    destination = tmp_path / "backup.sqlite"
    _wal_source(source)

    # 旧 reader 持有一个在 'B' 提交之前的快照 → TRUNCATE checkpoint 永远 busy。
    reader = sqlite3.connect(source)
    reader.execute("BEGIN")
    try:
        assert reader.execute("SELECT v FROM t ORDER BY id").fetchall() == [("A",)]
        writer = sqlite3.connect(source)
        writer.execute("INSERT INTO t(v) VALUES ('B')")
        writer.commit()
        writer.close()

        module.backup(str(source), str(destination))
    finally:
        reader.execute("ROLLBACK")
        reader.close()

    # 备份必须成功、自洽，且包含 'B'（即使它还只存在于 WAL）。
    assert destination.exists()
    assert _rows(destination) == [("A",), ("B",)]
    check = sqlite3.connect(destination)
    try:
        assert check.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    finally:
        check.close()


def test_backup_copy_is_self_contained_without_sidecar_wal(tmp_path):
    """The produced backup must not depend on any leftover -wal/-shm next to the
    destination; a reader on the file alone sees the committed rows."""
    module = _load_module()
    source = tmp_path / "live2.sqlite"
    destination = tmp_path / "backup2.sqlite"
    _wal_source(source)
    conn = sqlite3.connect(source)
    conn.execute("INSERT INTO t(v) VALUES ('B')")
    conn.commit()
    conn.close()

    module.backup(str(source), str(destination))

    # 移动后的备份不得依赖残留的 sidecar（-wal/-shm），否则拷贝即撕裂。
    for sidecar in ("backup2.sqlite-wal", "backup2.sqlite-shm"):
        assert not (tmp_path / sidecar).exists(), f"stale sidecar {sidecar}"
    assert _rows(destination) == [("A",), ("B",)]
