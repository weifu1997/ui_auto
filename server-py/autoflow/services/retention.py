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
            summary["runSnapshots"] = summary.get("runSnapshots", 0) + self.database.execute(
                "DELETE FROM run_snapshots WHERE run_id = ?", (run_id,)
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

        # 5. W1-2 孤儿文件清扫：磁盘上存在而 platform_artifacts 无行引用、
        # 且写入时间超过 24h 的产物文件。来源是取消窗口/completed 崩溃等
        # 「已写盘未登记」的半途文件；retention 只认 DB 行，这些文件此前
        # 只增不减。
        summary["orphanFiles"] = self._sweep_orphan_artifact_files(
            artifact_directory, max_age_hours=24, dry_run=dry_run
        )

        return summary

    def _sweep_orphan_artifact_files(
        self,
        artifact_directory: Path,
        *,
        max_age_hours: int,
        dry_run: bool,
    ) -> int:
        base = Path(artifact_directory)
        if not base.is_dir():
            return 0
        referenced: set[str] = set()
        for (path_value,) in self.database.execute(
            "SELECT path FROM platform_artifacts"
        ).fetchall():
            if isinstance(path_value, str) and path_value:
                try:
                    referenced.add(str(Path(path_value).resolve()))
                except OSError:
                    continue
        cutoff_ts = (
            datetime.now(timezone.utc) - timedelta(hours=max_age_hours)
        ).timestamp()
        removed = 0
        for candidate in base.rglob("*"):
            if not candidate.is_file():
                continue
            try:
                resolved = str(candidate.resolve())
                stat_result = candidate.stat()
            except OSError:
                continue
            if resolved in referenced:
                continue
            if stat_result.st_mtime > cutoff_ts:
                continue
            removed += 1
            if not dry_run:
                try:
                    candidate.unlink()
                except OSError:
                    pass
        return removed
