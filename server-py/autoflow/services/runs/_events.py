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
        # 事件封顶 500 条，但必须保留最近 500 条（时间正序）。取最早 500 条会把
        # 长流程的最新进度/结束标记截掉，UI 看起来永远“运行中”。
        events = self.database.execute(
            """
            SELECT id, kind, data, created_at FROM (
              SELECT id, kind, data, created_at FROM platform_run_events
              WHERE run_id = ?
              ORDER BY id DESC LIMIT 500
            )
            ORDER BY id ASC
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

    def run_summaries(
        self, project_id: str, run_ids: list[str]
    ) -> list[dict[str, Any]]:
        """Lean per-run summaries for list / dispatch (P1-5).

        Returns one summary per id, preserving ``run_ids`` order, with the
        fields the UI derives from a full run (flow/environment names, total and
        completed steps, progress, screenshot count) computed server-side — so a
        list page or dataset dispatch no longer embeds each run's whole frozen
        snapshot / events / artifacts into the response. Query count is constant
        (1 run row + 2 grouped aggregates) regardless of list size: no N+1.
        Progress semantics match the frontend: a ``success`` run counts all
        steps as completed; other statuses count ``step.completed`` events.

        P1-5c：快照外置后名称/步数读轻量派生列（flow_name/environment_name/
        total_steps，写入与迁移 v16 派生），不再为列表逐行解析整份快照。
        """
        if not run_ids:
            return []
        placeholders = ",".join("?" for _ in run_ids)
        rows = self.database.execute(
            f"""
            SELECT id, project_id, environment_id, status,
                   flow_name, environment_name, total_steps,
                   retry_of_run_id, created_at, updated_at
            FROM platform_runs
            WHERE project_id = ? AND id IN ({placeholders})
            """,
            (project_id, *run_ids),
        ).fetchall()
        if not rows:
            return []
        completed_counts = dict(
            self.database.execute(
                f"""
                SELECT run_id, COUNT(*) FROM platform_run_events
                WHERE run_id IN ({placeholders})
                  AND kind IN ('step.completed', 'step.succeeded')
                GROUP BY run_id
                """,
                tuple(run_ids),
            ).fetchall()
        )
        screenshot_counts = dict(
            self.database.execute(
                f"""
                SELECT run_id, COUNT(*) FROM platform_artifacts
                WHERE run_id IN ({placeholders}) AND content_type LIKE 'image/%'
                GROUP BY run_id
                """,
                tuple(run_ids),
            ).fetchall()
        )
        by_id: dict[str, dict[str, Any]] = {}
        for row in rows:
            run_id = row[0]
            status = row[3]
            flow_name = row[4] or "平台运行"
            environment_name = row[5] or row[2]  # fallback: environmentId
            total_steps = row[6] or 0
            completed_steps = (
                total_steps if status == "success" else completed_counts.get(run_id, 0)
            )
            if total_steps > 0:
                progress = min(100, round(completed_steps * 100 / total_steps))
            else:
                progress = 100 if status == "success" else 0
            by_id[run_id] = {
                "id": run_id,
                "projectId": row[1],
                "environmentId": row[2],
                "status": status,
                "retryOfRunId": row[7],
                "createdAt": row[8],
                "updatedAt": row[9],
                "flowName": flow_name,
                "environmentName": environment_name,
                "totalSteps": total_steps,
                "completedSteps": completed_steps,
                "progress": progress,
                "screenshotCount": screenshot_counts.get(run_id, 0),
            }
        return [by_id[run_id] for run_id in run_ids if run_id in by_id]
