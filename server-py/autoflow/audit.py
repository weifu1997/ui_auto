"""Audit event writer matching server/platform-audit.ts."""

from __future__ import annotations

import json as _json
import sqlite3
import uuid
from typing import Any


def create_audit_writer(database: sqlite3.Connection):
    def audit(
        workspace_id: str,
        actor: dict[str, str],
        action: str,
        target: dict[str, str],
        detail: dict[str, Any] | None = None,
        project_id: str | None = None,
    ) -> None:
        database.execute(
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


def create_deployment_audit_writer(database: sqlite3.Connection):
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
        database.execute(
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
