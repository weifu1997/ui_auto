"""Due schedule processing."""
from __future__ import annotations

from ..core import next_cron_time, now


class ScheduleServices:
    """Due schedule processing."""

    def process_due_schedules(self) -> None:
        from ..http import PlatformError

        rows = self.database.execute(
            """
            SELECT id, project_id, revision_id, environment_id,
                   dataset_version_id, cron_expression, timezone, next_run_at
            FROM schedules
            WHERE enabled = 1 AND archived_at IS NULL AND next_run_at <= ?
              AND project_id NOT IN (
                SELECT id FROM platform_projects WHERE archived_at IS NOT NULL
              )
            ORDER BY next_run_at ASC LIMIT 20
            """,
            (now(),),
        ).fetchall()
        for schedule in rows:
            attempted_at = now()
            schedule_id = schedule[0]
            project_id = schedule[1]
            # 先算出下一次触发再入队。dispatchKey 绑定的是“本次触发的 next_run_at”；
            # 若入队后才推进、且推进又失败（旧逻辑退回 +60s），调度会立刻重新到期，
            # 每次 tick 都换一个全新 dispatchKey → 绕过 insert_run_from_spec 的去重，
            # 产生“每 ~60s 一个新 run”的重复风暴。
            try:
                next_run_at = next_cron_time(schedule[5], schedule[6])
            except PlatformError:
                # cron 永远到不了下一次触发（如 “0 9 30 2 *”）：禁用，而不是反复重试。
                self.database.execute(
                    """
                    UPDATE schedules
                    SET enabled = 0, updated_at = ?
                    WHERE id = ?
                    """,
                    (now(), schedule_id),
                )
                project = self.project_for(project_id)
                self.audit(
                    project["workspace_id"],
                    {"type": "system", "id": f"schedule:{schedule_id}"},
                    "schedule.skipped",
                    {"type": "schedule", "id": schedule_id},
                    {"error": "SCHEDULE_CRON_INVALID"},
                    project_id,
                )
                continue
            try:
                queued = self.queue_published_runs(
                    {
                        "projectId": project_id,
                        "revisionId": schedule[2],
                        "environmentId": schedule[3],
                        "datasetVersionId": schedule[4],
                        "createdBy": f"schedule:{schedule_id}",
                        "source": "schedule",
                        "dispatchKey": f"schedule:{schedule_id}:{schedule[7]}",
                    }
                )
            except Exception as exc:
                # 入队失败：保持 next_run_at 不变。下次 tick 仍以同一 dispatchKey 重试，
                # insert_run_from_spec 幂等去重，不会重复创建 run。
                project = self.project_for(project_id)
                self.audit(
                    project["workspace_id"],
                    {"type": "system", "id": f"schedule:{schedule_id}"},
                    "schedule.skipped",
                    {"type": "schedule", "id": schedule_id},
                    {
                        "error": (
                            exc.code
                            if isinstance(exc, PlatformError)
                            else "SCHEDULE_TRIGGER_FAILED"
                        )
                    },
                    project_id,
                )
                continue
            self.database.execute(
                """
                UPDATE schedules
                SET last_run_at = ?, next_run_at = ?, updated_at = ?
                WHERE id = ?
                """,
                (attempted_at, next_run_at, now(), schedule_id),
            )
            project = self.project_for(project_id)
            self.audit(
                project["workspace_id"],
                {"type": "system", "id": f"schedule:{schedule_id}"},
                "schedule.triggered",
                {"type": "schedule", "id": schedule_id},
                {"runIds": queued["runIds"]},
                project_id,
            )
