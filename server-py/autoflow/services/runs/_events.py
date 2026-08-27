"""Run event write and run-detail event serialization.

`_RunEventsMixin`（事件写入 + run 详情的事件序列化）。适配注：runs.py 无独立事件分页/游标方法，事件以 `run_response` 内嵌 `LIMIT 500` 呈现。
"""
from __future__ import annotations

from typing import Any

from ...core import json, now, parse_json

class _RunEventsMixin:
    """Run event write and run-detail event serialization."""

    def append_run_event(
        self, run_id: str, kind: str, data: dict[str, Any]
    ) -> None:
        self.database.execute(
            """
            INSERT INTO platform_run_events (run_id, kind, data, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (run_id, kind, json(data), now()),
        )

    def run_response(self, run: dict[str, Any]) -> dict[str, Any]:
        agent = self.database.execute(
            """
            SELECT id, name, browser_version, os, max_concurrency, last_seen_at
            FROM agents WHERE id = ?
            """,
            (run["agentId"],),
        ).fetchone()
        artifacts = self.database.execute(
            """
            SELECT id, name, content_type, created_at FROM platform_artifacts
            WHERE run_id = ? ORDER BY created_at ASC
            """,
            (run["id"],),
        ).fetchall()
        events = self.database.execute(
            """
            SELECT id, kind, data, created_at FROM platform_run_events
            WHERE run_id = ? ORDER BY id ASC LIMIT 500
            """,
            (run["id"],),
        ).fetchall()
        flow_outputs = self.database.execute(
            """
            SELECT name, value, source, created_at FROM flow_outputs
            WHERE run_id = ? ORDER BY name ASC
            """,
            (run["id"],),
        ).fetchall()
        response: dict[str, Any] = {
            **run,
            "artifacts": [
                {
                    "id": row[0],
                    "name": row[1],
                    "contentType": row[2],
                    "createdAt": row[3],
                }
                for row in artifacts
            ],
            "events": [
                {
                    "id": row[0],
                    "kind": row[1],
                    "data": parse_json(row[2], {}),
                    "at": row[3],
                }
                for row in events
            ],
            "flowOutputs": [
                {
                    "name": row[0],
                    "value": row[1],
                    "source": row[2],
                    "createdAt": row[3],
                }
                for row in flow_outputs
            ],
        }
        if run["executorType"] == "agent" and agent:
            response["agent"] = {
                "id": agent[0],
                "name": agent[1],
                "browserVersion": agent[2],
                "os": agent[3],
                "maxConcurrency": agent[4],
                "lastSeenAt": agent[5],
            }
        return response
