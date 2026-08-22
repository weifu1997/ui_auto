"""Shared helpers, constants, and AuthUser for the service mixins."""
from __future__ import annotations

import sqlite3
import http.client
import io
import ssl
from urllib.parse import urlsplit
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

_CHROMIUM_AVAILABLE: bool | None = None


_CHROMIUM_AVAILABLE_AT: float | None = None


_CHROMIUM_CACHE_TTL_NEGATIVE: float = 30.0  # 不可用结果 30s 后允许重试，避免安装完 Chromium 还要重启进程


_CHROMIUM_CACHE_TTL_POSITIVE: float = 3600.0  # 可用结果缓存 1h


_TERMINAL_RUN_STATUSES = ("success", "failed", "canceled")


BOOTSTRAP_SCHEMA = """
    CREATE TABLE IF NOT EXISTS platform_users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS platform_user_credentials (
      user_id TEXT PRIMARY KEY REFERENCES platform_users(id),
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS platform_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES platform_users(id),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspace_members (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      user_id TEXT NOT NULL REFERENCES platform_users(id),
      role TEXT NOT NULL,
      PRIMARY KEY (workspace_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS platform_projects (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (workspace_id, slug)
    );
    CREATE TABLE IF NOT EXISTS project_documents (
      project_id TEXT PRIMARY KEY REFERENCES platform_projects(id),
      data TEXT NOT NULL,
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS platform_imports (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      source_id TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      result TEXT NOT NULL,
      UNIQUE (workspace_id, source_id)
    );
    CREATE TABLE IF NOT EXISTS flow_revisions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES platform_projects(id),
      flow_id TEXT,
      flow_name TEXT,
      environment_id TEXT,
      revision_number INTEGER NOT NULL,
      status TEXT NOT NULL,
      flow_snapshot TEXT NOT NULL,
      environment_snapshot TEXT NOT NULL,
      element_snapshot TEXT NOT NULL,
      dataset_snapshot TEXT NOT NULL,
      checksum TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      published_at TEXT,
      UNIQUE (project_id, revision_number)
    );
    CREATE TABLE IF NOT EXISTS project_secrets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES platform_projects(id),
      name TEXT NOT NULL,
      key_version INTEGER NOT NULL,
      iv TEXT NOT NULL,
      tag TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (project_id, name)
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      project_id TEXT,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deployment_audit_events (
      id TEXT PRIMARY KEY,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS deployment_audit_events_created
      ON deployment_audit_events (created_at DESC);
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      name TEXT NOT NULL,
      credential_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      browser_version TEXT NOT NULL,
      os TEXT NOT NULL,
      max_concurrency INTEGER NOT NULL,
      current_task TEXT,
      last_seen_at TEXT,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS platform_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES platform_projects(id),
      revision_id TEXT NOT NULL REFERENCES flow_revisions(id),
      environment_id TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      status TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      cancellation_requested INTEGER NOT NULL DEFAULT 0,
      result TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS element_validations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES platform_projects(id),
      environment_id TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      status TEXT NOT NULL,
      element_snapshot TEXT NOT NULL,
      result TEXT,
      error TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS platform_run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES platform_runs(id),
      kind TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS platform_artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES platform_runs(id),
      project_id TEXT NOT NULL REFERENCES platform_projects(id),
      name TEXT NOT NULL,
      content_type TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS datasets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES platform_projects(id),
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (project_id, name)
    );
    CREATE TABLE IF NOT EXISTS dataset_versions (
      id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL REFERENCES datasets(id),
      version_number INTEGER NOT NULL,
      columns_json TEXT NOT NULL,
      row_count INTEGER NOT NULL,
      checksum TEXT NOT NULL,
      source_name TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (dataset_id, version_number)
    );
    CREATE TABLE IF NOT EXISTS dataset_rows (
      id TEXT PRIMARY KEY,
      dataset_version_id TEXT NOT NULL REFERENCES dataset_versions(id),
      row_number INTEGER NOT NULL,
      data_json TEXT NOT NULL,
      UNIQUE (dataset_version_id, row_number)
    );
    CREATE TABLE IF NOT EXISTS flow_outputs (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES platform_runs(id),
      name TEXT NOT NULL,
      value TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (run_id, name)
    );
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES platform_projects(id),
      revision_id TEXT NOT NULL REFERENCES flow_revisions(id),
      environment_id TEXT NOT NULL,
      dataset_version_id TEXT REFERENCES dataset_versions(id),
      name TEXT NOT NULL,
      cron_expression TEXT NOT NULL,
      timezone TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT,
      next_run_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS webhook_triggers (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES platform_projects(id),
      revision_id TEXT NOT NULL REFERENCES flow_revisions(id),
      environment_id TEXT NOT NULL,
      dataset_version_id TEXT REFERENCES dataset_versions(id),
      name TEXT NOT NULL,
      signing_secret_iv TEXT,
      signing_secret_tag TEXT,
      signing_secret_ciphertext TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_triggered_at TEXT
    );
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      trigger_id TEXT NOT NULL REFERENCES webhook_triggers(id),
      delivery_id TEXT NOT NULL,
      received_at TEXT NOT NULL,
      PRIMARY KEY (trigger_id, delivery_id)
    );
    CREATE TABLE IF NOT EXISTS notification_channels (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      name TEXT NOT NULL,
      channel_type TEXT NOT NULL,
      config_iv TEXT NOT NULL,
      config_tag TEXT NOT NULL,
      config_ciphertext TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (workspace_id, name)
    );
    CREATE TABLE IF NOT EXISTS notification_subscriptions (
      project_id TEXT NOT NULL REFERENCES platform_projects(id),
      channel_id TEXT NOT NULL REFERENCES notification_channels(id),
      on_success INTEGER NOT NULL DEFAULT 0,
      on_failure INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (project_id, channel_id)
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES notification_channels(id),
      run_id TEXT NOT NULL REFERENCES platform_runs(id),
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      payload TEXT NOT NULL,
      response_code INTEGER,
      error TEXT,
      next_attempt_at TEXT,
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE (channel_id, run_id)
    );
    CREATE INDEX IF NOT EXISTS platform_projects_workspace ON platform_projects (workspace_id, archived_at);
    CREATE INDEX IF NOT EXISTS flow_revisions_project ON flow_revisions (project_id, revision_number DESC);
    CREATE INDEX IF NOT EXISTS agents_workspace ON agents (workspace_id, status, last_seen_at);
    CREATE INDEX IF NOT EXISTS platform_runs_project ON platform_runs (project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS datasets_project ON datasets (project_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS dataset_versions_dataset ON dataset_versions (dataset_id, version_number DESC);
    CREATE INDEX IF NOT EXISTS dataset_rows_version ON dataset_rows (dataset_version_id, row_number);
    CREATE INDEX IF NOT EXISTS flow_outputs_run ON flow_outputs (run_id, name);
    CREATE INDEX IF NOT EXISTS schedules_due ON schedules (enabled, next_run_at);
    CREATE INDEX IF NOT EXISTS webhook_triggers_project ON webhook_triggers (project_id, enabled);
    CREATE INDEX IF NOT EXISTS webhook_deliveries_received ON webhook_deliveries (received_at);
    CREATE INDEX IF NOT EXISTS deliveries_channel ON deliveries (channel_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS audit_events_project ON audit_events (project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS platform_run_events_run ON platform_run_events (run_id, id);
    CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries (status, next_attempt_at);
"""


@dataclass
class AuthUser:
    id: str
    email: str
    name: str
    global_role: str | None = None


def _format_notification_body(
    channel_type: str,
    payload: dict[str, Any],
    keyword: str | None = None,
) -> dict[str, Any]:
    content = (
        f"{keyword} AutoFlow {payload.get('status', '')}: "
        f"{payload.get('runId', '')} ({payload.get('environmentId', '')})"
        if keyword
        else (
            f"AutoFlow {payload.get('status', '')}: "
            f"{payload.get('runId', '')} ({payload.get('environmentId', '')})"
        )
    )
    if channel_type == "feishu":
        return {"msg_type": "text", "content": {"text": content}}
    if channel_type == "dingtalk":
        return {"msgtype": "text", "text": {"content": content}}
    if channel_type == "wecom":
        return {"msgtype": "text", "text": {"content": content}}
    return payload


def _post_notification(
    target: dict[str, str],
    headers: dict[str, str],
    body: str,
) -> dict[str, Any]:
    parsed = urlsplit(target["url"])
    hostname = parsed.hostname or ""
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"
    request_headers = {
        "Host": parsed.netloc or hostname,
        "content-type": "application/json",
        **headers,
    }
    if parsed.scheme == "https":
        connection = http.client.HTTPSConnection(
            target["address"],
            port,
            timeout=10,
            context=ssl.create_default_context(),
            server_hostname=hostname,
        )
    else:
        connection = http.client.HTTPConnection(
            target["address"], port, timeout=10
        )
    try:
        connection.request("POST", path, body=body, headers=request_headers)
        response = connection.getresponse()
        response_body = response.read(2048).decode("utf-8", errors="replace")
        return {"status": response.status, "body": response_body[:2048]}
    finally:
        connection.close()


def _iso_add_seconds(seconds: int) -> str:
    return (
        datetime.now(timezone.utc) + timedelta(seconds=seconds)
    ).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _now_ms() -> float:
    return datetime.now(timezone.utc).timestamp() * 1000


def _read_xlsx(content: bytes) -> list[list[Any]]:
    from datetime import date, datetime

    import openpyxl

    workbook = openpyxl.load_workbook(
        io.BytesIO(content), read_only=True, data_only=True
    )
    sheet = workbook.active
    rows: list[list[Any]] = []
    for values in sheet.iter_rows(values_only=True):
        row: list[Any] = []
        for value in values:
            if isinstance(value, datetime):
                row.append(value.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z")
            elif isinstance(value, date):
                row.append(value.isoformat())
            elif value is None:
                row.append("")
            else:
                row.append(value)
        rows.append(row)
    workbook.close()
    return rows


def _parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _iso_from_ms(value: float) -> str:
    return (
        datetime.fromtimestamp(value / 1000, timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%S.%f"
        )[:-3]
        + "Z"
    )


def _iso_ms(value: str | None) -> float | None:
    if not value:
        return None
    try:
        parsed = _parse_iso(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp() * 1000


def _period_key(iso: str, period: str) -> str:
    if period == "day":
        return iso[:10]
    date_value = _parse_iso(iso).date()
    year, week, _ = date_value.isocalendar()
    return f"{year}-W{week:02d}"


def _fetch_runs(
    database: sqlite3.Connection,
    project_id: str,
    from_iso: str | None,
    to_iso: str | None,
    limit: int = 2000,
) -> list[dict[str, Any]]:
    query = """
        SELECT id, revision_id, status, snapshot, created_at
        FROM platform_runs WHERE project_id = ?
    """
    params: list[Any] = [project_id]
    if from_iso:
        query += " AND created_at >= ?"
        params.append(from_iso)
    if to_iso:
        query += " AND created_at <= ?"
        params.append(to_iso)
    query += " ORDER BY created_at DESC LIMIT ?"
    params.append(limit)
    return [
        {
            "id": row[0],
            "revision_id": row[1],
            "status": row[2],
            "snapshot": row[3],
            "created_at": row[4],
        }
        for row in database.execute(query, tuple(params)).fetchall()
    ]


def _summarize_runs(run_rows: list[dict[str, Any]]) -> dict[str, int]:
    terminal = [
        run for run in run_rows if run["status"] in ("success", "failed", "canceled")
    ]
    failed_runs = sum(1 for run in run_rows if run["status"] == "failed")
    canceled_runs = sum(1 for run in run_rows if run["status"] == "canceled")
    success_runs = sum(1 for run in terminal if run["status"] == "success")
    return {
        "totalRuns": len(run_rows),
        "successRate": round((success_runs / len(terminal)) * 100) if terminal else 0,
        "failedRuns": failed_runs,
        "canceledRuns": canceled_runs,
        "failedRate": round((failed_runs / len(run_rows)) * 100) if run_rows else 0,
        "canceledRate": round((canceled_runs / len(run_rows)) * 100) if run_rows else 0,
    }
