"""Construction, per-thread database connections, and shutdown."""
from __future__ import annotations

import os
import sqlite3
import concurrent.futures
import threading
from pathlib import Path
from ..audit import create_audit_writer, create_deployment_audit_writer
from ..core import json, now
from ..crypto import key_material
from ..migrations import run_platform_migrations
from ..managed_runner import ManagedRunner
from ..recorder import RecordingCoordinator
from ..recording_state import RecordingSessionStateStore
from ._shared import (
    BOOTSTRAP_SCHEMA,
)


class CoreServices:
    """Construction, per-thread database connections, and shutdown."""

    def __init__(self, data_directory: str):
        self.data_directory = Path(data_directory)
        self.data_directory.mkdir(parents=True, exist_ok=True)
        self._thread_local = threading.local()
        self._thread_local.database = self._open_database_connection()
        run_platform_migrations(self.database, BOOTSTRAP_SCHEMA)
        self.audit = create_audit_writer(self._current_database)
        self.deployment_audit = create_deployment_audit_writer(self._current_database)
        self.managed_runner = ManagedRunner(
            self.data_directory / "artifacts",
            global_concurrency=int(
                os.environ.get("AUTOFLOW_RUNNER_GLOBAL_CONCURRENCY", "2")
            ),
            workspace_concurrency=int(
                os.environ.get("AUTOFLOW_RUNNER_WORKSPACE_CONCURRENCY", "1")
            ),
        )
        self._recording_executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="recording"
        )
        self.recording_session_state = RecordingSessionStateStore()
        self.recording_coordinator = RecordingCoordinator(
            submit=self._recording_executor.submit,
            on_failed=self._audit_recording_failed,
            on_storage_state=self.recording_session_state.remember,
        )
        self.webhook_requests: dict[str, list[float]] = {}
        configured_secret = os.environ.get("PLATFORM_SECRET_KEY")
        if not configured_secret:
            key_file = os.environ.get("PLATFORM_SECRET_KEY_FILE")
            if key_file:
                try:
                    configured_secret = Path(key_file).read_text(
                        encoding="utf-8"
                    ).strip()
                except Exception:
                    configured_secret = None
        if os.environ.get("NODE_ENV") == "production" and not configured_secret:
            raise RuntimeError("PLATFORM_SECRET_KEY is required in production")
        self.key_material = key_material(configured_secret)
        self._configured_secret = configured_secret
        interrupted = self.database.execute(
            """
            SELECT id FROM platform_runs
            WHERE executor_type = 'managed' AND status = 'running'
            """
        ).fetchall()
        for row in interrupted:
            self.finalize_run_as_interrupted(row[0], "SERVICE_RESTARTED")
        recoverable = self.database.execute(
            """
            SELECT id FROM platform_runs
            WHERE executor_type = 'managed' AND status = 'queued'
            ORDER BY created_at
            """
        ).fetchall()
        for row in recoverable:
            try:
                self.enqueue_managed_run(row[0])
            except Exception:
                self.database.execute(
                    """
                    UPDATE platform_runs
                    SET status = 'failed', result = ?, updated_at = ?
                    WHERE id = ? AND status = 'queued'
                    """,
                    (json({"error": "RUN_ENQUEUE_FAILED", "interrupted": True}), now(), row[0]),
                )
                self.append_run_event(
                    row[0], "run.interrupted", {"reason": "RUN_ENQUEUE_FAILED"}
                )

    @property
    def database(self) -> sqlite3.Connection:
        # 每线程一个连接：事件循环、维护线程（asyncio.to_thread）与 ManagedRunner
        # 工作线程此前共用一个连接，导致 BEGIN IMMEDIATE 互相冲突、自动提交写入
        # 混入他人事务。WAL 模式允许连接间并发，写竞争由 busy timeout（30s）兜底。
        connection = getattr(self._thread_local, "database", None)
        if connection is None:
            connection = self._open_database_connection()
            self._thread_local.database = connection
        return connection

    @database.setter
    def database(self, connection: sqlite3.Connection) -> None:
        self._thread_local.database = connection

    def _open_database_connection(self) -> sqlite3.Connection:
        connection = sqlite3.connect(
            self.data_directory / "platform.sqlite",
            check_same_thread=False,
            timeout=30.0,
        )
        connection.isolation_level = None
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def _current_database(self) -> sqlite3.Connection:
        return self.database

    def close(self) -> None:
        try:
            self.recording_coordinator.close_all()
        except Exception:
            pass
        self._recording_executor.shutdown(wait=False)
        self.managed_runner.stop()
        self.database.close()
