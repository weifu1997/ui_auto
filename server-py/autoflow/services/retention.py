"""Retention cleanup."""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from ..core import now


class RetentionServices:
    """Retention cleanup."""

    def retention_cleanup(
        self,
        audit_days: int = 180,
        run_days: int = 90,
        artifact_days: int = 15,
        dry_run: bool = False,
    ) -> dict[str, int]:
        """DATA-01 retention pass.

        Removes expired artifacts (file + row), runs (cascade events/outputs/
        artifacts), audit events, expired sessions and delivered notifications.
        Returns counts; when ``dry_run`` is True nothing is deleted.
        """
        artifact_directory = self.managed_runner.artifact_directory

        def cutoff(days: int) -> str:
            return (
                datetime.now(timezone.utc) - timedelta(days=days)
            ).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"

        artifact_cutoff = cutoff(artifact_days)
        run_cutoff = cutoff(run_days)
        audit_cutoff = cutoff(audit_days)

        summary = {
            "artifacts": 0,
            "runs": 0,
            "runEvents": 0,
            "flowOutputs": 0,
            "auditEvents": 0,
            "sessions": 0,
            "deliveries": 0,
        }

        def _delete_artifact_file(path_value: str | None) -> None:
            if not path_value:
                return
            try:
                candidate = Path(path_value).resolve()
                base = Path(artifact_directory).resolve()
                if str(candidate).startswith(str(base) + os.sep) and candidate.is_file():
                    candidate.unlink()
            except Exception:
                pass

        # 1. Expired artifacts (shortest retention) — file + row.
        artifact_rows = self.database.execute(
            "SELECT id, path FROM platform_artifacts WHERE created_at <= ?",
            (artifact_cutoff,),
        ).fetchall()
        for row in artifact_rows:
            summary["artifacts"] += 1
            if not dry_run:
                _delete_artifact_file(row[1])
                self.database.execute(
                    "DELETE FROM platform_artifacts WHERE id = ?", (row[0],)
                )

        # 2. Expired runs — cascade events/outputs/artifacts, then the run.
        run_ids = self.database.execute(
            "SELECT id FROM platform_runs WHERE created_at <= ?",
            (run_cutoff,),
        ).fetchall()
        for run_row in run_ids:
            run_id = run_row[0]
            summary["runs"] += 1
            if dry_run:
                continue
            run_artifact_rows = self.database.execute(
                "SELECT id, path FROM platform_artifacts WHERE run_id = ?",
                (run_id,),
            ).fetchall()
            for artifact_row in run_artifact_rows:
                _delete_artifact_file(artifact_row[1])
                self.database.execute(
                    "DELETE FROM platform_artifacts WHERE id = ?", (artifact_row[0],)
                )
            summary["runEvents"] += self.database.execute(
                "DELETE FROM platform_run_events WHERE run_id = ?", (run_id,)
            ).rowcount
            summary["flowOutputs"] += self.database.execute(
                "DELETE FROM flow_outputs WHERE run_id = ?", (run_id,)
            ).rowcount
            self.database.execute(
                "DELETE FROM deliveries WHERE run_id = ?", (run_id,)
            )
            self.database.execute(
                "DELETE FROM platform_runs WHERE id = ?", (run_id,)
            )

        # 3. Expired audit events.
        summary["auditEvents"] = self.database.execute(
            "DELETE FROM audit_events WHERE created_at <= ?", (audit_cutoff,)
        ).rowcount

        # 4. Expired sessions and delivered notifications.
        summary["sessions"] = self.database.execute(
            "DELETE FROM platform_sessions WHERE expires_at <= ?", (now(),)
        ).rowcount
        summary["deliveries"] = self.database.execute(
            """
            DELETE FROM deliveries
            WHERE status IN ('delivered', 'failed') AND created_at <= ?
            """,
            (run_cutoff,),
        ).rowcount

        return summary
