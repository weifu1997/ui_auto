"""Due schedule processing."""
from __future__ import annotations

from ..core import next_cron_time, now
from ._shared import (
    _iso_add_seconds,
)


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
            try:
                queued = self.queue_published_runs(
                    {
                        "projectId": schedule[1],
                        "revisionId": schedule[2],
                        "environmentId": schedule[3],
                        "datasetVersionId": schedule[4],
                        "createdBy": f"schedule:{schedule[0]}",
                        "source": "schedule",
                        "dispatchKey": f"schedule:{schedule[0]}:{schedule[7]}",
                    }
                )
                self.database.execute(
                    """
                    UPDATE schedules
                    SET last_run_at = ?, next_run_at = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (attempted_at, next_cron_time(schedule[5], schedule[6]), now(), schedule[0]),
                )
                project = self.project_for(schedule[1])
                self.audit(
                    project["workspace_id"],
                    {"type": "system", "id": f"schedule:{schedule[0]}"},
                    "schedule.triggered",
                    {"type": "schedule", "id": schedule[0]},
                    {"runIds": queued["runIds"]},
                    schedule[1],
                )
            except Exception as exc:
                try:
                    next_run_at = next_cron_time(schedule[5], schedule[6])
                except Exception:
                    next_run_at = _iso_add_seconds(60)
                self.database.execute(
                    """
                    UPDATE schedules SET next_run_at = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (next_run_at, now(), schedule[0]),
                )
                project = self.project_for(schedule[1])
                self.audit(
                    project["workspace_id"],
                    {"type": "system", "id": f"schedule:{schedule[0]}"},
                    "schedule.skipped",
                    {"type": "schedule", "id": schedule[0]},
                    {
                        "error": (
                            exc.code
                            if isinstance(exc, PlatformError)
                            else "SCHEDULE_TRIGGER_FAILED"
                        )
                    },
                    schedule[1],
                )
