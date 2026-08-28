"""Run batch creation, listing, cancel, and retry."""
from __future__ import annotations

import sqlite3
import uuid
from typing import Any
from ..core import json, now, parse_json
from ..resources import as_record


class BatchServices:
    """Run batch creation, listing, cancel, and retry."""

    BATCH_MIN_FLOWS = 2
    BATCH_MAX_FLOWS = 20
    BATCH_MAX_TOTAL_STEPS = 2000
    _RUN_BATCH_COUNTS_CTE = """
        counts AS (
          SELECT batch_id,
                 COUNT(*) AS total,
                 SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
                 SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
                 SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
                 SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
                 SUM(CASE WHEN status = 'canceled' THEN 1 ELSE 0 END) AS canceled,
                 COUNT(*) - SUM(
                   CASE WHEN status IN ('queued', 'running') THEN 1 ELSE 0 END
                 ) AS completed
          FROM platform_runs
          WHERE batch_id IS NOT NULL
          GROUP BY batch_id
        )
    """
    _RUN_BATCH_STATUS_EXPR = """
            CASE
              WHEN COALESCE(c.total, 0) = 0 THEN 'failed'
              WHEN COALESCE(c.queued, 0) = COALESCE(c.total, 0) THEN 'queued'
              WHEN COALESCE(c.running, 0) > 0
                OR (COALESCE(c.queued, 0) > 0 AND COALESCE(c.completed, 0) > 0)
                THEN 'running'
              WHEN COALESCE(c.success, 0) = COALESCE(c.total, 0) THEN 'success'
              WHEN COALESCE(c.canceled, 0) = COALESCE(c.total, 0) THEN 'canceled'
              WHEN COALESCE(c.completed, 0) = COALESCE(c.total, 0)
                AND COALESCE(c.success, 0) > 0 THEN 'partial_failed'
              WHEN COALESCE(c.completed, 0) = COALESCE(c.total, 0)
                AND COALESCE(c.failed, 0) > 0 THEN 'failed'
              ELSE 'running'
            END
    """

    def _run_batch_response(self, row: Any) -> dict[str, Any]:
        total = int(row[12] or 0)
        queued = int(row[13] or 0)
        running = int(row[14] or 0)
        success = int(row[15] or 0)
        failed = int(row[16] or 0)
        canceled = int(row[17] or 0)
        completed = success + failed + canceled
        return {
            "id": row[0],
            "projectId": row[1],
            "environmentId": row[2],
            "clientRequestId": row[3],
            "source": row[4],
            "retryOfBatchId": row[5],
            "flowIds": parse_json(row[6], []),
            "cancellationRequested": bool(row[7]),
            "createdBy": row[8],
            "createdAt": row[9],
            "updatedAt": row[10],
            "status": row[11],
            "counts": {
                "total": total,
                "queued": queued,
                "running": running,
                "success": success,
                "failed": failed,
                "canceled": canceled,
                "completed": completed,
            },
        }

    def _run_batch_select(self) -> str:
        status_expr = " ".join(
            line.strip() for line in self._RUN_BATCH_STATUS_EXPR.splitlines()
        ).strip()
        return f"""
        SELECT b.id, b.project_id, b.environment_id, b.client_request_id,
               b.source, b.retry_of_batch_id, b.requested_flow_ids,
               b.cancellation_requested, b.created_by, b.created_at, b.updated_at,
               {status_expr} AS status,
               COALESCE(c.total, 0) AS total, COALESCE(c.queued, 0) AS queued,
               COALESCE(c.running, 0) AS running, COALESCE(c.success, 0) AS success,
               COALESCE(c.failed, 0) AS failed, COALESCE(c.canceled, 0) AS canceled
        """

    def run_batch_by_id(self, project_id: str, batch_id: str) -> dict[str, Any]:
        from ..http import PlatformError

        row = self.database.execute(
            f"""
            WITH {self._RUN_BATCH_COUNTS_CTE}
            {self._run_batch_select()}
            FROM run_batches b
            LEFT JOIN counts c ON c.batch_id = b.id
            WHERE b.id = ? AND b.project_id = ?
            """,
            (batch_id, project_id),
        ).fetchone()
        if not row:
            raise PlatformError(404, "RUN_BATCH_NOT_FOUND")
        return self._run_batch_response(row)

    def run_batches_page(
        self,
        project_id: str,
        page: int,
        page_size: int,
        status: str | None = None,
    ) -> dict[str, Any]:
        params: list[Any] = [project_id]
        status_filter = ""
        if status:
            status_filter = "WHERE status = ?"
            params.append(status)
        rows = self.database.execute(
            f"""
            WITH {self._RUN_BATCH_COUNTS_CTE}
            SELECT * FROM (
              {self._run_batch_select()}
              FROM run_batches b
              LEFT JOIN counts c ON c.batch_id = b.id
              WHERE b.project_id = ?
              ORDER BY b.created_at DESC, b.id DESC
            ) {status_filter}
            LIMIT ? OFFSET ?
            """,
            (*params, page_size, (page - 1) * page_size),
        ).fetchall()
        total_row = self.database.execute(
            f"""
            WITH {self._RUN_BATCH_COUNTS_CTE}
            SELECT COUNT(*) FROM (
              {self._run_batch_select()}
              FROM run_batches b
              LEFT JOIN counts c ON c.batch_id = b.id
              WHERE b.project_id = ?
            ) {status_filter}
            """,
            tuple(params),
        ).fetchone()
        return {
            "batches": [self._run_batch_response(row) for row in rows],
            "total": int(total_row[0] or 0),
            "page": page,
            "pageSize": page_size,
        }

    def batch_runs(self, project_id: str, batch_id: str) -> list[dict[str, Any]]:
        rows = self.database.execute(
            """
            SELECT id, project_id, revision_id, environment_id, agent_id,
                   executor_type, status, snapshot, cancellation_requested,
                   result, created_at, updated_at, batch_item_index,
                   retry_of_run_id
            FROM platform_runs
            WHERE batch_id = ? AND project_id = ?
            ORDER BY batch_item_index ASC
            """,
            (batch_id, project_id),
        ).fetchall()
        return [
            {
                "id": row[0],
                "projectId": row[1],
                "revisionId": row[2],
                "environmentId": row[3],
                "agentId": row[4],
                "executorType": row[5],
                "status": row[6],
                "snapshot": parse_json(row[7], {}),
                "cancellationRequested": bool(row[8]),
                "result": parse_json(row[9], None),
                "createdAt": row[10],
                "updatedAt": row[11],
                "batchItemIndex": row[12],
                "retryOfRunId": row[13],
            }
            for row in rows
        ]

    def _validate_batch_input(self, input: dict[str, Any]) -> list[str]:
        from ..http import PlatformError

        flow_ids = input.get("flowIds")
        if not isinstance(flow_ids, list) or not all(
            isinstance(value, str) and value.strip() for value in flow_ids
        ):
            raise PlatformError(400, "BATCH_FLOW_IDS_INVALID")
        flow_ids = [value.strip() for value in flow_ids]
        if len(set(flow_ids)) != len(flow_ids):
            raise PlatformError(400, "BATCH_DUPLICATE_FLOW")
        if not (
            self.BATCH_MIN_FLOWS
            <= len(flow_ids)
            <= self.BATCH_MAX_FLOWS
        ):
            raise PlatformError(400, "BATCH_FLOW_COUNT_INVALID")
        if not (input.get("environmentId") or "").strip():
            raise PlatformError(400, "ENVIRONMENT_REQUIRED")
        if not (input.get("clientRequestId") or "").strip():
            raise PlatformError(400, "BATCH_CLIENT_REQUEST_ID_REQUIRED")
        if (
            input.get("revisionId")
            or input.get("datasetVersionId")
            or input.get("upToStepId")
        ):
            raise PlatformError(400, "BATCH_INPUT_NOT_SUPPORTED")
        return flow_ids

    def _existing_run_batch(
        self, project_id: str, client_request_id: str
    ) -> dict[str, Any] | None:
        existing = self.database.execute(
            """
            SELECT id FROM run_batches
            WHERE project_id = ? AND client_request_id = ?
            """,
            (project_id, client_request_id),
        ).fetchone()
        if not existing:
            return None
        return self.run_batch_by_id(project_id, existing[0])

    def _insert_run_batch(
        self,
        *,
        project_id: str,
        environment_id: str,
        client_request_id: str,
        flow_ids: list[str],
        created_by: str,
        specs: list[dict[str, Any]],
        retry_of_batch_id: str | None = None,
        retry_of_run_ids: list[str] | None = None,
        retry_rows: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        import sqlite3

        from ..http import PlatformError

        batch_id = str(uuid.uuid4())
        created_at = now()
        run_ids: list[str] = []
        self.database.execute("BEGIN IMMEDIATE")
        try:
            self.database.execute(
                """
                INSERT INTO run_batches (
                  id, project_id, environment_id, client_request_id, source,
                  retry_of_batch_id, requested_flow_ids, cancellation_requested,
                  created_by, created_at, updated_at
                ) VALUES (?, ?, ?, ?, 'manual', ?, ?, 0, ?, ?, ?)
                """,
                (
                    batch_id,
                    project_id,
                    environment_id,
                    client_request_id,
                    retry_of_batch_id,
                    json(flow_ids),
                    created_by,
                    created_at,
                    created_at,
                ),
            )
            for index, spec in enumerate(specs):
                run_ids.append(
                    self.insert_run_from_spec(
                        spec,
                        row=(
                            retry_rows[index]
                            if retry_rows
                            else {"rowNumber": None, "data": None}
                        ),
                        created_by=created_by,
                        source="manual",
                        batch_id=batch_id,
                        batch_item_index=index,
                        retry_of_run_id=(
                            retry_of_run_ids[index]
                            if retry_of_run_ids
                            else None
                        ),
                    )
                )
            self.database.execute("COMMIT")
        except sqlite3.IntegrityError:
            self.database.execute("ROLLBACK")
            existing = self._existing_run_batch(project_id, client_request_id)
            if existing is None:
                raise
            if (
                existing["environmentId"] != environment_id
                or existing["flowIds"] != flow_ids
            ):
                raise PlatformError(409, "IDEMPOTENCY_KEY_REUSED")
            return {
                "batch": existing,
                "runs": self.batch_runs(project_id, existing["id"]),
                "replayed": True,
            }
        except Exception:
            self.database.execute("ROLLBACK")
            raise
        for run_id in run_ids:
            self.enqueue_managed_run(run_id)
        return {
            "batch": self.run_batch_by_id(project_id, batch_id),
            "runs": self.batch_runs(project_id, batch_id),
            "replayed": False,
        }

    def create_run_batch(self, input: dict[str, Any]) -> dict[str, Any]:
        from ..http import PlatformError

        project_id = input["projectId"]
        flow_ids = self._validate_batch_input(input)
        environment_id = input["environmentId"].strip()
        client_request_id = input["clientRequestId"].strip()
        existing = self._existing_run_batch(project_id, client_request_id)
        if existing is not None:
            if (
                existing["environmentId"] != environment_id
                or existing["flowIds"] != flow_ids
            ):
                raise PlatformError(409, "IDEMPOTENCY_KEY_REUSED")
            return {
                "batch": existing,
                "runs": self.batch_runs(project_id, existing["id"]),
                "replayed": True,
            }
        specs: list[dict[str, Any]] = []
        preflight_errors: list[dict[str, str]] = []
        total_steps = 0
        for flow_id in flow_ids:
            try:
                spec = self.resolve_run_spec(
                    {
                        "projectId": project_id,
                        "flowId": flow_id,
                        "environmentId": environment_id,
                    }
                )
                # A revision can carry a dataset default even when the batch
                # request does not. Batches are intentionally one run per flow.
                if spec["datasetVersionId"]:
                    raise PlatformError(400, "BATCH_INPUT_NOT_SUPPORTED")
                if not spec["flowSteps"]:
                    raise PlatformError(400, "FLOW_HAS_NO_STEPS")
                missing = self.missing_secret_names(
                    project_id,
                    [
                        name
                        for name in spec["secretNames"]
                        if name in spec["requiredSecretNames"]
                    ],
                )
                if missing:
                    raise PlatformError(409, "RUN_SECRET_NOT_CONFIGURED")
            except PlatformError as error:
                preflight_errors.append({"flowId": flow_id, "code": error.code})
                continue
            total_steps += len(spec["flowSteps"])
            specs.append(spec)
        if preflight_errors:
            raise PlatformError(
                409,
                "BATCH_PREFLIGHT_FAILED",
                {"items": preflight_errors},
            )
        if total_steps > self.BATCH_MAX_TOTAL_STEPS:
            raise PlatformError(413, "BATCH_TOTAL_STEPS_EXCEEDED")
        return self._insert_run_batch(
            project_id=project_id,
            environment_id=environment_id,
            client_request_id=client_request_id,
            flow_ids=flow_ids,
            created_by=input["createdBy"],
            specs=specs,
        )

    def cancel_run_batch(
        self, project_id: str, batch_id: str, actor_id: str
    ) -> dict[str, Any]:
        from ..http import PlatformError

        self.run_batch_by_id(project_id, batch_id)
        self.database.execute("BEGIN IMMEDIATE")
        try:
            self.database.execute(
                """
                UPDATE run_batches
                SET cancellation_requested = 1, updated_at = ?
                WHERE id = ? AND cancellation_requested = 0
                """,
                (now(), batch_id),
            )
            queued_rows = self.database.execute(
                """
                SELECT id FROM platform_runs
                WHERE batch_id = ? AND project_id = ? AND status = 'queued'
                """,
                (batch_id, project_id),
            ).fetchall()
            if queued_rows:
                self.database.execute(
                    """
                    UPDATE platform_runs
                    SET status = 'canceled', updated_at = ?
                    WHERE batch_id = ? AND project_id = ?
                      AND status = 'queued'
                    """,
                    (now(), batch_id, project_id),
                )
            running_rows = self.database.execute(
                """
                SELECT id FROM platform_runs
                WHERE batch_id = ? AND project_id = ? AND status = 'running'
                  AND cancellation_requested = 0
                """,
                (batch_id, project_id),
            ).fetchall()
            if running_rows:
                self.database.execute(
                    """
                    UPDATE platform_runs
                    SET cancellation_requested = 1, updated_at = ?
                    WHERE batch_id = ? AND project_id = ? AND status = 'running'
                      AND cancellation_requested = 0
                    """,
                    (now(), batch_id, project_id),
                )
            affected = [row[0] for row in queued_rows] + [
                row[0] for row in running_rows
            ]
            for run_id in affected:
                self.append_run_event(
                    run_id, "run.cancel_requested", {"actorId": actor_id}
                )
            self.database.execute("COMMIT")
        except Exception:
            self.database.execute("ROLLBACK")
            raise
        for run_id in affected:
            # queued 子项也必须在提交后从 ManagedRunner 队列移除，
            # 否则 DB 已 canceled 但 runner 仍可能继续执行该流程。
            self.cancel_managed_run(run_id)
        return {
            "batch": self.run_batch_by_id(project_id, batch_id),
            "runs": self.batch_runs(project_id, batch_id),
            "affectedQueued": len(queued_rows),
            "affectedRunning": len(running_rows),
        }

    def retry_run_batch(
        self,
        project_id: str,
        batch_id: str,
        actor_id: str,
        client_request_id: str,
    ) -> dict[str, Any]:
        from ..http import PlatformError

        batch = self.run_batch_by_id(project_id, batch_id)
        if batch["status"] not in ("success", "partial_failed", "failed", "canceled"):
            raise PlatformError(409, "BATCH_NOT_RETRYABLE")
        runs = self.batch_runs(project_id, batch_id)
        retry_items = [
            run for run in runs if run["status"] in ("failed", "canceled")
        ]
        if not retry_items:
            raise PlatformError(409, "BATCH_NOT_RETRYABLE")
        retry_flow_ids: list[str] = []
        for run in retry_items:
            flow_id = as_record(run["snapshot"].get("flow")).get("id")
            retry_flow_ids.append(
                flow_id if isinstance(flow_id, str) else run["revisionId"]
            )
        existing = self._existing_run_batch(project_id, client_request_id)
        if existing is not None:
            if (
                existing.get("retryOfBatchId") == batch_id
                and existing["flowIds"] == retry_flow_ids
            ):
                return {
                    "batch": existing,
                    "runs": self.batch_runs(project_id, existing["id"]),
                    "replayed": True,
                }
            raise PlatformError(409, "IDEMPOTENCY_KEY_REUSED")
        specs: list[dict[str, Any]] = []
        retry_rows: list[dict[str, Any]] = []
        for run in retry_items:
            spec = self.clone_retry_spec_from_run(run)
            self._preflight_retry_spec(project_id, spec)
            specs.append(spec)
            retry_rows.append(self._row_from_retry_snapshot(run["snapshot"]))
        return self._insert_run_batch(
            project_id=project_id,
            environment_id=batch["environmentId"],
            client_request_id=client_request_id,
            flow_ids=retry_flow_ids,
            created_by=actor_id,
            specs=specs,
            retry_of_batch_id=batch_id,
            retry_of_run_ids=[run["id"] for run in retry_items],
            retry_rows=retry_rows,
        )
