"""Audit event writer matching server/platform-audit.ts."""

from __future__ import annotations

import json as _json
import sqlite3
import uuid
from collections.abc import Callable
from typing import Any

DatabaseSource = sqlite3.Connection | Callable[[], sqlite3.Connection]


def _resolve(database: DatabaseSource) -> sqlite3.Connection:
    # 连接按调用线程惰性获取：审计会从事件循环、维护线程和 ManagedRunner
    # 工作线程写入，不能在服务初始化时绑定单一连接。
    return database() if callable(database) else database


def create_audit_writer(database: DatabaseSource):
    def audit(
        workspace_id: str,
        actor: dict[str, str],
        action: str,
        target: dict[str, str],
        detail: dict[str, Any] | None = None,
        project_id: str | None = None,
    ) -> None:
        _resolve(database).execute(
            """
            INSERT INTO audit_events (
              id, workspace_id, project_id, actor_type, actor_id, action,
              target_type, target_id, detail, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                str(uuid.uuid4()),
                workspace_id,
                project_id,
                actor.get("type", "system"),
                actor.get("id", ""),
                action,
                target.get("type", ""),
                target.get("id", ""),
                _json.dumps(detail or {}, separators=(",", ":")),
                _iso_now(),
            ),
        )

    return audit


def create_deployment_audit_writer(database: DatabaseSource):
    """Write security events that exist before any workspace is created.

    Workspace-scoped audit events retain their workspace foreign key because
    project governance queries depend on it. Bootstrap actions happen before
    that boundary exists, so they use this separate internal deployment ledger
    rather than fabricating a workspace or weakening the existing contract.
    """

    def audit(
        actor: dict[str, str],
        action: str,
        target: dict[str, str],
        detail: dict[str, Any] | None = None,
    ) -> None:
        _resolve(database).execute(
            """
            INSERT INTO deployment_audit_events (
              id, actor_type, actor_id, action, target_type, target_id,
              detail, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                str(uuid.uuid4()),
                actor.get("type", "system"),
                actor.get("id", ""),
                action,
                target.get("type", ""),
                target.get("id", ""),
                _json.dumps(detail or {}, separators=(",", ":")),
                _iso_now(),
            ),
        )

    return audit


def _iso_now() -> str:
    from datetime import datetime, timezone

    value = datetime.now(timezone.utc)
    return value.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
