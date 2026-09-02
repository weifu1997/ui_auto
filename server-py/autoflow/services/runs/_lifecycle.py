"""Run lifecycle: spec resolution, create/cancel/retry/terminal-state persistence."""
from __future__ import annotations

import json as _json
import shutil
import tempfile
import threading
import uuid
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from ...netguard import is_link_local_or_metadata_host
from ...core import (
    MAX_RUNS_PER_DISPATCH,
    json,
    now,
    parse_json,
    public_flow_output_names,
    safe_artifact_name,
)
from ...resources import as_record
from .._shared import _TERMINAL_RUN_STATUSES

class _RunsLifecycleMixin:
    """Run lifecycle: create/cancel/retry/terminal-state."""

    def resolve_run_spec(self, input: dict[str, Any]) -> dict[str, Any]:
        from ...http import PlatformError

        project_id = input["projectId"]
        revision = self.published_revision_for(
            project_id,
            input.get("revisionId") or None,
            flow_id=input.get("flowId") or None,
            environment_id=input.get("environmentId") or None,
            allow_superseded=bool(input.get("allowSuperseded")),
        )
        environment = parse_json(revision["environment_snapshot"], {})
        environment_id = input.get("environmentId")
        if not environment_id:
            environment_id = (
                environment.get("id") if isinstance(environment, dict) else ""
            )
        if not environment_id:
            raise PlatformError(400, "ENVIRONMENT_REQUIRED")
        if environment.get("id") != environment_id:
            raise PlatformError(409, "REVISION_ENVIRONMENT_MISMATCH")
        self.require_chromium_environment(
            environment if isinstance(environment, dict) else {}
        )
        self.ensure_chromium_available()
        agent = self.managed_agent(project_id)
        dataset_version_id = input.get("datasetVersionId")
        if not dataset_version_id:
            snapshot_dataset = parse_json(revision["dataset_snapshot"], None)
            if isinstance(snapshot_dataset, dict):
                version_id = snapshot_dataset.get("versionId")
                if isinstance(version_id, str):
                    dataset_version_id = version_id
        dataset_version = (
            self.dataset_version_for(project_id, dataset_version_id)
            if dataset_version_id
            else None
        )
        rows = (
            self.dataset_rows_for(dataset_version["id"])
            if dataset_version
            else [{"rowNumber": None, "data": None}]
        )
        max_runs = input.get("maxRuns")
        # 调用方显式给 maxRuns 用调用方的；否则落到平台默认上限，避免一次数据集
        # 批量派发在单事务里无界写行。webhook 已自带 maxRuns=WEBHOOK_MAX_RUNS。
        if max_runs is None:
            max_runs = MAX_RUNS_PER_DISPATCH
        if len(rows) > int(max_runs):
            raise PlatformError(413, "RUN_COUNT_LIMIT_EXCEEDED")
        flow = parse_json(revision["flow_snapshot"], {})
        flow_steps = flow.get("steps", []) if isinstance(flow, dict) else []
        if not isinstance(flow_steps, list):
            flow_steps = []
        up_to_step_id = input.get("upToStepId")
        if up_to_step_id and not any(
            as_record(step).get("id") == up_to_step_id for step in flow_steps
        ):
            raise PlatformError(400, "RUN_STEP_NOT_FOUND")
        secret_names = flow.get("secretNames", [])
        if not isinstance(secret_names, list):
            secret_names = []
        secret_names = [value for value in secret_names if isinstance(value, str)]
        step_limit = (
            next(
                (
                    index + 1
                    for index, step in enumerate(flow_steps)
                    if as_record(step).get("id") == up_to_step_id
                ),
                0,
            )
            if up_to_step_id
            else len(flow_steps)
        )
        required_secret_names: set[str] = set()
        for step in flow_steps[:step_limit]:
            value = as_record(step).get("value")
            if not isinstance(value, str):
                value = ""
            for name in secret_names:
                if (
                    f"{{{{{name}}}}}" in value
                    or f"{{{{ {name} }}}}" in value
                    or f"{{{{secret.{name}}}}}" in value
                    or f"{{{{ secret.{name} }}}}" in value
                ):
                    required_secret_names.add(name)
        return {
            "projectId": project_id,
            "revision": revision,
            "environment": environment,
            "environmentId": environment_id,
            "datasetVersionId": dataset_version_id,
            "datasetVersion": dataset_version,
            "rows": rows,
            "flow": flow,
            "flowSteps": flow_steps,
            "secretNames": secret_names,
            "requiredSecretNames": required_secret_names,
            "upToStepId": up_to_step_id or None,
            "agent": agent,
        }

    @staticmethod
    def _required_retry_variable_names(
        flow: dict[str, Any], secret_names: list[str]
    ) -> set[str]:
        secret_set = {str(name) for name in secret_names}
        required: set[str] = set()
        steps = flow.get("steps") if isinstance(flow, dict) else []
        if not isinstance(steps, list):
            steps = []
        for step in steps:
            value = as_record(step).get("value")
            if not isinstance(value, str):
                continue
            for match in re.finditer(r"{{\s*([^}]+)\s*}}", value):
                expression = match.group(1).strip()
                if not expression:
                    continue
                if (
                    expression.startswith("secret.")
                    or expression in secret_set
                    or expression.startswith("data.")
                    or expression.startswith("flow.")
                    or expression.startswith("run.")
                    or expression == "env.baseUrl"
                ):
                    continue
                required.add(expression)
        return required

    def _preflight_retry_variables(
        self, project_id: str, flow: dict[str, Any], secret_names: list[str]
    ) -> None:
        from ...http import PlatformError

        required = self._required_retry_variable_names(flow, secret_names)
        if not required:
            return
        rows = self.database.execute(
            """
            SELECT data FROM project_resources
            WHERE project_id = ? AND resource_type = 'variables'
              AND archived_at IS NULL
            """,
            (project_id,),
        ).fetchall()
        available: set[str] = set()
        for variable_row in rows:
            variable = parse_json(variable_row[0], {})
            if (
                not isinstance(variable, dict)
                or variable.get("secret") is True
                or not isinstance(variable.get("name"), str)
                or not isinstance(variable.get("value"), str)
            ):
                continue
            scope = (
                "env"
                if variable.get("scope") == "环境"
                else "project"
                if variable.get("scope") == "项目"
                else ""
            )
            key = f"{scope}.{variable['name']}" if scope else variable["name"]
            available.add(key)
        missing = sorted(required - available)
        if missing:
            raise PlatformError(409, "RUN_VARIABLE_NOT_CONFIGURED")

    def _preflight_retry_spec(self, project_id: str, spec: dict[str, Any]) -> None:
        from ...http import PlatformError

        snapshot_secret_names = [
            name
            for name in spec["secretNames"]
            if name in spec["requiredSecretNames"]
        ]
        missing = self.missing_secret_names(project_id, snapshot_secret_names)
        if missing:
            raise PlatformError(409, "RUN_SECRET_NOT_CONFIGURED")
        self._preflight_retry_variables(
            project_id, spec["flow"], spec["secretNames"]
        )

    @staticmethod
    def _row_from_retry_snapshot(snapshot: dict[str, Any]) -> dict[str, Any]:
        dataset_row = snapshot.get("datasetRow")
        if isinstance(dataset_row, dict):
            return {
                "rowNumber": dataset_row.get("number"),
                "data": dataset_row.get("data"),
            }
        return {"rowNumber": None, "data": None}

    def clone_retry_spec_from_run(self, run: dict[str, Any]) -> dict[str, Any]:
        """从源 run 的持久 snapshot 构造一对一 retry spec，不重新解析 revision/dataset。"""
        from ...http import PlatformError

        snapshot = run.get("snapshot")
        if not isinstance(snapshot, dict):
            raise PlatformError(409, "RUN_SNAPSHOT_NOT_RETRYABLE")
        flow = snapshot.get("flow")
        environment = snapshot.get("environment")
        if not isinstance(flow, dict) or not isinstance(environment, dict):
            raise PlatformError(409, "RUN_SNAPSHOT_NOT_RETRYABLE")
        revision_id = snapshot.get("flowRevisionId")
        revision_checksum = snapshot.get("flowRevisionChecksum")
        if (
            not isinstance(revision_id, str)
            or not isinstance(revision_checksum, str)
            or run.get("revisionId") != revision_id
        ):
            raise PlatformError(409, "RUN_SNAPSHOT_NOT_RETRYABLE")
        if environment.get("id") != run.get("environmentId"):
            raise PlatformError(409, "RUN_SNAPSHOT_NOT_RETRYABLE")
        up_to_step_id = snapshot.get("upToStepId")
        steps = flow.get("steps") if isinstance(flow.get("steps"), list) else []
        if up_to_step_id and not any(
            as_record(step).get("id") == up_to_step_id for step in steps
        ):
            raise PlatformError(409, "RUN_SNAPSHOT_NOT_RETRYABLE")
        elements = snapshot.get("elements")
        if not isinstance(elements, list):
            raise PlatformError(409, "RUN_SNAPSHOT_NOT_RETRYABLE")
        dataset = snapshot.get("dataset")
        if dataset is not None and (
            not isinstance(dataset, dict)
            or not all(
                key in dataset
                for key in ("datasetId", "versionId", "versionNumber", "checksum", "columns")
            )
        ):
            raise PlatformError(409, "RUN_SNAPSHOT_NOT_RETRYABLE")
        dataset_row = snapshot.get("datasetRow")
        if dataset_row is not None and (
            not isinstance(dataset_row, dict)
            or "number" not in dataset_row
            or "data" not in dataset_row
        ):
            raise PlatformError(409, "RUN_SNAPSHOT_NOT_RETRYABLE")
        secret_names = snapshot.get("secretNames", [])
        if not isinstance(secret_names, list) or not all(
            isinstance(name, str) for name in secret_names
        ):
            raise PlatformError(409, "RUN_SNAPSHOT_NOT_RETRYABLE")
        return {
            "projectId": run["projectId"],
            "revision": {
                "id": revision_id,
                "checksum": revision_checksum,
                "element_snapshot": json(elements),
            },
            "environmentId": run["environmentId"],
            "environment": _json.loads(_json.dumps(environment)),
            "flow": _json.loads(_json.dumps(flow)),
            "flowSteps": _json.loads(_json.dumps(steps)),
            "datasetVersionId": (
                dataset.get("versionId") if isinstance(dataset, dict) else None
            ),
            "datasetVersion": (
                {
                    "id": dataset["versionId"],
                    "datasetId": dataset["datasetId"],
                    "versionNumber": dataset["versionNumber"],
                    "checksum": dataset["checksum"],
                    "columns": dataset["columns"],
                }
                if isinstance(dataset, dict)
                else None
            ),
            "secretNames": list(secret_names),
            "requiredSecretNames": set(secret_names),
            "upToStepId": up_to_step_id or None,
            "agent": self.managed_agent(run["projectId"]),
        }

    def retry_run_snapshot(
        self,
        project_id: str,
        run_id: str,
        actor_id: str,
        dispatch_key: str | None = None,
    ) -> dict[str, Any]:
        from ...http import PlatformError

        run = self.run_by_id(run_id)
        if run["projectId"] != project_id:
            raise PlatformError(404, "RUN_NOT_FOUND")
        if run["status"] not in ("failed", "canceled"):
            raise PlatformError(409, "RUN_NOT_RETRYABLE")
        spec = self.clone_retry_spec_from_run(run)
        self._preflight_retry_spec(project_id, spec)
        row = self._row_from_retry_snapshot(run["snapshot"])
        new_run_id: str | None = None
        self.database.execute("BEGIN IMMEDIATE")
        try:
            new_run_id = self.insert_run_from_spec(
                spec,
                row=row,
                created_by=actor_id,
                source="manual",
                dispatch_key=dispatch_key,
                retry_of_run_id=run_id,
            )
            self.database.execute("COMMIT")
        except Exception:
            self.database.execute("ROLLBACK")
            raise
        if new_run_id is None:
            raise RuntimeError("retry_run_snapshot failed to create run")
        self.enqueue_managed_run(new_run_id)
        return {
            "runIds": [new_run_id],
            "runs": [self.run_response(self.run_by_id(new_run_id))],
        }

    def insert_run_from_spec(
        self,
        spec: dict[str, Any],
        *,
        row: dict[str, Any],
        created_by: str,
        source: str,
        dispatch_key: str | None = None,
        batch_id: str | None = None,
        batch_item_index: int | None = None,
        retry_of_run_id: str | None = None,
    ) -> str:
        from ...http import PlatformError

        project_id = spec["projectId"]
        revision = spec["revision"]
        environment_id = spec["environmentId"]
        environment = spec["environment"]
        dataset_version = spec["datasetVersion"]
        dataset_version_id = spec["datasetVersionId"]
        flow = spec["flow"]
        agent = spec["agent"]
        up_to_step_id = spec["upToStepId"]
        if dispatch_key:
            existing = self.database.execute(
                "SELECT id FROM platform_runs WHERE dispatch_key = ? AND project_id = ?",
                (dispatch_key, project_id),
            ).fetchone()
            if existing:
                return existing[0]
        snapshot_secret_names = [
            name
            for name in spec["secretNames"]
            if name in spec["requiredSecretNames"]
        ]
        missing = self.missing_secret_names(project_id, snapshot_secret_names)
        if missing:
            raise PlatformError(409, "RUN_SECRET_NOT_CONFIGURED")
        run_id = str(uuid.uuid4())
        created_at = now()
        # 运行 snapshot 不保存普通变量值；变量在 enqueue/恢复时按项目当前值读取。
        flow_snapshot = dict(flow)
        flow_snapshot.pop("variables", None)
        snapshot = {
            "flowRevisionId": revision["id"],
            "flowRevisionChecksum": revision["checksum"],
            "environmentId": environment_id,
            "flow": flow_snapshot,
            "environment": environment,
            "elements": parse_json(revision["element_snapshot"], []),
            "dataset": (
                {
                    "datasetId": dataset_version["datasetId"],
                    "versionId": dataset_version["id"],
                    "versionNumber": dataset_version["versionNumber"],
                    "checksum": dataset_version["checksum"],
                    "columns": dataset_version["columns"],
                }
                if dataset_version
                else None
            ),
            "datasetRow": (
                {"number": row["rowNumber"], "data": row["data"]}
                if row["data"] is not None
                else None
            ),
            "secretNames": snapshot_secret_names,
            "upToStepId": up_to_step_id,
            "executor": {
                "type": "managed",
                "id": agent["id"],
                "name": agent["name"],
                "browserVersion": agent["browserVersion"],
            },
            "trigger": source,
        }
        if batch_id:
            snapshot["batchId"] = batch_id
            snapshot["batchItemIndex"] = batch_item_index
        self.database.execute(
            """
            INSERT INTO platform_runs (
              id, project_id, revision_id, environment_id, agent_id,
              executor_type, dispatch_key, status, snapshot,
              batch_id, batch_item_index, retry_of_run_id,
              created_by, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'managed', ?, 'queued', ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run_id,
                project_id,
                revision["id"],
                environment_id,
                agent["id"],
                dispatch_key,
                json(snapshot),
                batch_id,
                batch_item_index,
                retry_of_run_id,
                created_by,
                created_at,
                created_at,
            ),
        )
        self.append_run_event(
            run_id,
            "run.queued",
            {
                "revisionId": revision["id"],
                "environmentId": environment_id,
                "executorType": "managed",
                "source": source,
                "datasetVersionId": dataset_version_id,
                "datasetRow": row["rowNumber"],
            },
        )
        if retry_of_run_id:
            self.append_run_event(
                run_id,
                "run.retried",
                {"priorRunId": retry_of_run_id, "actorId": created_by},
            )
        return run_id

    def run_by_id(
        self, run_id: str, project_id: str | None = None
    ) -> dict[str, Any]:
        from ...http import PlatformError

        row = self.database.execute(
            """
            SELECT id, project_id, revision_id, environment_id, agent_id,
                   executor_type, status, snapshot, cancellation_requested,
                   result, created_at, updated_at, retry_of_run_id
            FROM platform_runs
            WHERE id = ? AND (? IS NULL OR project_id = ?)
            """,
            (run_id, project_id, project_id),
        ).fetchone()
        if not row:
            raise PlatformError(404, "RUN_NOT_FOUND")
        return {
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
            "retryOfRunId": row[12],
        }

    def delete_run(self, project_id: str, run_id: str) -> dict[str, Any]:
        from ...http import PlatformError

        run = self.database.execute(
            "SELECT id, project_id, status FROM platform_runs WHERE id = ?",
            (run_id,),
        ).fetchone()
        if not run:
            raise PlatformError(404, "RUN_NOT_FOUND")
        if run[1] != project_id:
            raise PlatformError(404, "RUN_NOT_FOUND")
        if run[2] not in _TERMINAL_RUN_STATUSES:
            raise PlatformError(409, "RUN_NOT_DELETABLE")
        self.database.execute("BEGIN IMMEDIATE")
        try:
            self.database.execute("DELETE FROM deliveries WHERE run_id = ?", (run_id,))
            self.database.execute("DELETE FROM flow_outputs WHERE run_id = ?", (run_id,))
            self.database.execute("DELETE FROM platform_artifacts WHERE run_id = ?", (run_id,))
            self.database.execute("DELETE FROM platform_run_events WHERE run_id = ?", (run_id,))
            self.database.execute("DELETE FROM platform_runs WHERE id = ? AND project_id = ?", (run_id, project_id))
            self.database.execute("COMMIT")
        except Exception:
            self.database.execute("ROLLBACK")
            raise
        return {"runId": run_id, "deleted": True}

    def delete_runs(self, project_id: str, run_ids: list[str]) -> dict[str, Any]:
        if not run_ids:
            return {"runIds": [], "deletedCount": 0}
        placeholders = ",".join("?" for _ in run_ids)
        terminal_placeholders = ",".join("?" for _ in _TERMINAL_RUN_STATUSES)
        rows = self.database.execute(
            f"""
            SELECT id FROM platform_runs
            WHERE project_id = ?
              AND id IN ({placeholders})
              AND status IN ({terminal_placeholders})
            """,
            [project_id, *run_ids, *_TERMINAL_RUN_STATUSES],
        ).fetchall()
        deletable_run_ids = [row[0] for row in rows]
        if not deletable_run_ids:
            return {"runIds": [], "deletedCount": 0}
        deletable_placeholders = ",".join("?" for _ in deletable_run_ids)
        self.database.execute("BEGIN IMMEDIATE")
        try:
            self.database.execute(
                f"DELETE FROM deliveries WHERE run_id IN ({deletable_placeholders})",
                deletable_run_ids,
            )
            self.database.execute(
                f"DELETE FROM flow_outputs WHERE run_id IN ({deletable_placeholders})",
                deletable_run_ids,
            )
            self.database.execute(
                f"DELETE FROM platform_artifacts WHERE run_id IN ({deletable_placeholders})",
                deletable_run_ids,
            )
            self.database.execute(
                f"DELETE FROM platform_run_events WHERE run_id IN ({deletable_placeholders})",
                deletable_run_ids,
            )
            cursor = self.database.execute(
                f"DELETE FROM platform_runs WHERE id IN ({deletable_placeholders}) AND project_id = ?",
                [*deletable_run_ids, project_id],
            )
            deleted_count = cursor.rowcount
            self.database.execute("COMMIT")
        except Exception:
            self.database.execute("ROLLBACK")
            raise
        return {"runIds": deletable_run_ids, "deletedCount": deleted_count}

    def request_run_cancel(self, run_id: str, project_id: str) -> None:
        """W1-5：取消标记先行落库。

        旧实现"先读状态再分支 UPDATE"存在窗口——读到 queued 后 worker 抢先
        转 running，分支语句 0 行命中，cancellation_requested 未持久化，
        终态被错记为 failed。现在无条件先把标记写到（queued/running 界内），
        再对仍处 queued 的行直接置 canceled；completed 映射尊重标记。
        """
        self.database.execute(
            """
            UPDATE platform_runs
            SET cancellation_requested = 1, updated_at = ?
            WHERE id = ? AND project_id = ? AND status IN ('queued', 'running')
            """,
            (now(), run_id, project_id),
        )
        self.database.execute(
            """
            UPDATE platform_runs
            SET status = 'canceled', updated_at = ?
            WHERE id = ? AND project_id = ? AND status = 'queued'
            """,
            (now(), run_id, project_id),
        )

    def cancel_managed_run(self, run_id: str) -> bool:
        return self.managed_runner.cancel(run_id)

    def managed_runner_input(self, run: dict[str, Any]) -> dict[str, Any]:
        snapshot = run["snapshot"]
        flow = as_record(snapshot.get("flow"))
        environment = as_record(snapshot.get("environment"))
        variable_rows = self.database.execute(
            """
            SELECT data FROM project_resources
            WHERE project_id = ? AND resource_type = 'variables'
              AND archived_at IS NULL
            """,
            (run["projectId"],),
        ).fetchall()
        variables: dict[str, str] = {}
        for variable_row in variable_rows:
            variable = parse_json(variable_row[0], {})
            if (
                not isinstance(variable, dict)
                or variable.get("secret") is True
                or not isinstance(variable.get("name"), str)
                or not isinstance(variable.get("value"), str)
            ):
                continue
            scope = (
                "env"
                if variable.get("scope") == "环境"
                else "project"
                if variable.get("scope") == "项目"
                else ""
            )
            key = f"{scope}.{variable['name']}" if scope else variable["name"]
            variables[key] = variable["value"]
        secret_names = snapshot.get("secretNames", [])
        if not isinstance(secret_names, list):
            secret_names = []
        secret_names = [name for name in secret_names if isinstance(name, str)]
        dataset_row = as_record(as_record(snapshot.get("datasetRow")).get("data"))
        return {
            "environment": environment,
            "flow": {
                "id": flow.get("id") if isinstance(flow.get("id"), str) else run["revisionId"],
                "name": flow.get("name") if isinstance(flow.get("name"), str) else "Published flow",
                "steps": flow.get("steps") if isinstance(flow.get("steps"), list) else [],
            },
            "elements": snapshot.get("elements")
            if isinstance(snapshot.get("elements"), list)
            else [],
            "variables": variables,
            "data": {
                str(key): str(value or "")
                for key, value in dataset_row.items()
            },
            "secrets": self.secret_values(run["projectId"], secret_names),
            "upToStepId": (
                snapshot.get("upToStepId")
                if isinstance(snapshot.get("upToStepId"), str)
                else None
            ),
        }

    def enqueue_managed_run(self, run_id: str) -> None:
        run = self.run_by_id(run_id)
        if run["status"] != "queued":
            return
        input = self.managed_runner_input(run)

        def started() -> bool:
            return self.mark_run_started(run_id)

        def progress(step_index: int) -> None:
            # W0-4 心跳：仅刷新 updated_at，不进事件流（每步都发事件会淹没详情页）。
            self.touch_run_heartbeat(run_id, step_index)

        def event(kind: str, data: dict[str, Any]) -> None:
            self.append_run_event(
                run_id,
                kind,
                self.redact_run_value(run, data),
            )

        def artifact(input_data: dict[str, Any]) -> None:
            artifact_id = str(uuid.uuid4())
            self.database.execute(
                """
                INSERT INTO platform_artifacts (
                  id, run_id, project_id, name, content_type, path, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    artifact_id,
                    run_id,
                    run["projectId"],
                    safe_artifact_name(str(input_data["name"])),
                    str(input_data["contentType"])[:120],
                    str(input_data["path"]),
                    now(),
                ),
            )
            self.append_run_event(
                run_id,
                "artifact.created",
                {
                    "artifactId": artifact_id,
                    "name": str(input_data["name"]),
                    "contentType": str(input_data["contentType"]),
                },
            )

        def completed(result: dict[str, Any]) -> None:
            self.finalize_completed_run(run_id, result)

        self.managed_runner.enqueue(
            run_id,
            input,
            {
                "started": started,
                "event": event,
                "artifact": artifact,
                "completed": completed,
                "progress": progress,
            },
            kind="run",
            workspace_id=self.project_for(run["projectId"])["workspace_id"],
        )

    @staticmethod
    def _flow_secret_names(flow: Any) -> list[str]:
        """从试跑流程步骤里收集 `{{secret.X}}` 占位符对应的 secret 名。"""
        steps = flow.get("steps") if isinstance(flow, dict) else []
        if not isinstance(steps, list):
            steps = []
        names: set[str] = set()
        for step in steps:
            record = as_record(step)
            value = record.get("value")
            if not isinstance(value, str):
                continue
            for match in re.finditer(r"{{\s*([^}]+?)\s*}}", value):
                expression = match.group(1).strip()
                if expression.startswith("secret."):
                    name = expression[len("secret.") :].strip()
                    if name:
                        names.add(name)
        return sorted(names)

    def preview_run(self, project_id: str, input: dict[str, Any]) -> dict[str, Any]:
        """断言试跑通道：直调 runner，最小 hooks，不持久化。

        - `upToStepId` 执行到该步（含）；不存在时复用 `RUN_STEP_NOT_FOUND`。
        - 不写 `platform_runs` / `platform_run_events` / artifacts。
        - 服务端解析项目 secret 注入 `input.secrets`，返回前统一脱敏。
        """
        from ...http import PlatformError
        from ...runner import execute_browser_run

        flow = as_record(input.get("flow"))
        steps = flow.get("steps") if isinstance(flow, dict) else []
        if not isinstance(steps, list):
            steps = []
        up_to_step_id = input.get("upToStepId")
        if up_to_step_id:
            if not any(as_record(step).get("id") == up_to_step_id for step in steps):
                raise PlatformError(400, "RUN_STEP_NOT_FOUND")
        requested = input.get("secretNames")
        if not isinstance(requested, list):
            requested = []
        secret_names = sorted(
            {
                *[name for name in requested if isinstance(name, str)],
                *self._flow_secret_names(flow),
            }
        )
        environment = as_record(input.get("environment"))
        base_url = (
            str(environment.get("baseUrl", "")) if isinstance(environment, dict) else ""
        )
        # P1-1 SSRF：preview 的 environment 完全由调用方随请求提供（不走已发布
        # 环境快照），需在拉起浏览器前先拒 link-local/云 metadata baseUrl；
        # 正常 run 由 runner._target_url 在导航出口拦同一类地址。
        if base_url and is_link_local_or_metadata_host(urlsplit(base_url).hostname):
            raise PlatformError(400, "PREVIEW_URL_FORBIDDEN")
        execution_input = {
            "environment": environment,
            "flow": {
                "id": flow.get("id") if isinstance(flow, dict) else "preview",
                "name": flow.get("name") if isinstance(flow, dict) else "试跑流程",
                "steps": steps,
            },
            "elements": input.get("elements")
            if isinstance(input.get("elements"), list)
            else [],
            "variables": input.get("variables")
            if isinstance(input.get("variables"), dict)
            else {},
            "data": input.get("data") if isinstance(input.get("data"), dict) else {},
            "secrets": self.secret_values(project_id, secret_names),
            "upToStepId": up_to_step_id or None,
        }
        signal = threading.Event()
        events: list[dict[str, Any]] = []
        # W1-2：预览产物统一落在专用临时目录，结束时整体删除，
        # 不再向 /tmp 根部散落一次性 png/zip。
        preview_directory = tempfile.mkdtemp(prefix="autoflow-preview-")
        hooks = {
            "signal": signal,
            "artifact_path": lambda _name, extension: str(
                Path(preview_directory) / f"artifact_{uuid.uuid4()}.{extension}"
            ),
            "artifact": lambda _data: None,
            "event": lambda kind, data: events.append({"kind": kind, "data": data}),
            "browser": lambda *_args: None,
        }
        try:
            result = execute_browser_run(execution_input, hooks)
        except RuntimeError as error:
            if str(error) == "RUN_STEP_NOT_FOUND":
                raise PlatformError(400, "RUN_STEP_NOT_FOUND") from None
            raise PlatformError(400, "PREVIEW_RUN_FAILED") from error
        finally:
            shutil.rmtree(preview_directory, ignore_errors=True)
        run_ref = {"projectId": project_id}
        return {
            "result": self.redact_run_value(run_ref, result),
            "events": self.redact_run_value(run_ref, events),
        }

    def persist_flow_outputs(
        self,
        run: dict[str, Any],
        result: dict[str, Any],
    ) -> None:
        outputs = as_record(result.get("flowOutputs"))
        allowed_names = public_flow_output_names(run)
        for name, source_value in outputs.items():
            output_name = str(name).strip()[:120]
            if output_name not in allowed_names:
                continue
            if isinstance(source_value, str):
                value = source_value
            elif isinstance(source_value, (int, float, bool)):
                value = str(source_value)
            else:
                value = ""
            value = self.redact_run_value(run, value)
            if not value:
                continue
            self.database.execute(
                """
                INSERT INTO flow_outputs (
                  id, run_id, name, value, source, created_at
                ) VALUES (?, ?, ?, ?, 'agent', ?)
                ON CONFLICT(run_id, name) DO UPDATE SET
                  value = excluded.value, source = excluded.source,
                  created_at = excluded.created_at
                """,
                (str(uuid.uuid4()), run["id"], output_name, str(value)[:20000], now()),
            )

    def audit_run_lifecycle(
        self,
        run_id: str,
        run: dict[str, Any],
        status: str,
    ) -> None:
        project = self.project_for(run["projectId"])
        detail: dict[str, Any] = {"status": status}
        if status == "failed":
            failure = self.database.execute(
                """
                SELECT kind, data FROM platform_run_events
                WHERE run_id = ? AND (kind LIKE '%failed%' OR kind LIKE '%error%')
                ORDER BY id DESC LIMIT 1
                """,
                (run_id,),
            ).fetchone()
            failure_data = parse_json(failure[1], {}) if failure else {}
            if isinstance(failure_data, dict):
                if isinstance(failure_data.get("code"), str) and failure_data["code"]:
                    detail["errorCode"] = failure_data["code"]
                elif isinstance(failure_data.get("reason"), str) and failure_data["reason"]:
                    detail["errorCode"] = failure_data["reason"][:200]
                if isinstance(failure_data.get("stepId"), str) and failure_data["stepId"]:
                    detail["stepId"] = failure_data["stepId"]
        self.audit(
            project["workspace_id"],
            {"type": "system", "id": "managed-runner"},
            f"run.{'canceled' if status == 'canceled' else 'failed' if status == 'failed' else 'completed'}",
            {"type": "run_batch", "id": run_id},
            detail,
            run["projectId"],
        )

    def mark_run_started(self, run_id: str) -> bool:
        """Flip queued -> running. Return False if the row is no longer queued
        (canceled/watchdog won the race) so the worker must not execute."""
        updated = self.database.execute(
            """
            UPDATE platform_runs SET status = 'running', updated_at = ?
            WHERE id = ? AND status = 'queued'
            """,
            (now(), run_id),
        )
        if updated.rowcount != 1:
            return False
        self.append_run_event(run_id, "run.started", {"executorType": "managed"})
        return True

    def touch_run_heartbeat(self, run_id: str, step_index: int = -1) -> None:
        """W0-4 心跳：步骤开始时刷新 running 行的 updated_at。

        watchdog 只依据 updated_at 新鲜度判活；异常情况下静默放弃本次心跳
        （失败只影响误杀窗口，绝不能把执行线程拖挂）。
        """
        try:
            self.database.execute(
                """
                UPDATE platform_runs SET updated_at = ?
                WHERE id = ? AND status = 'running'
                """,
                (now(), run_id),
            )
        except Exception:
            pass

    def finalize_completed_run(self, run_id: str, result: dict[str, Any]) -> None:
        """执行终态落库（W1-1 事务化）。

        状态终写、flowOutputs、run.complete 事件、审计与投递登记放在同一个
        BEGIN IMMEDIATE 内；中途崩溃不再出现「账面已结束但输出丢失」。
        投递的网络发送在提交之后统一触发。截图/trace 文件由 runner 在执行
        期间先行落盘，事务失败时产生的无行引用文件由 retention 孤儿清扫处理。
        """
        current_run = self.run_by_id(run_id)
        safe_result = self.redact_run_value(current_run, result)
        requested_status = (
            result.get("status")
            if result.get("status") in ("success", "failed")
            else "failed"
        )
        status = "canceled" if current_run["cancellationRequested"] else requested_status
        try:
            self.database.execute("BEGIN IMMEDIATE")
            updated = self.database.execute(
                """
                UPDATE platform_runs
                SET status = ?, result = ?, updated_at = ?
                WHERE id = ? AND status IN ('queued', 'running')
                """,
                (status, json(safe_result), now(), run_id),
            )
            if updated.rowcount != 1:
                self.database.execute("ROLLBACK")
                # W0-4 兜底：run 被 watchdog 判死（failed）后真实 success 结果
                # 才返回时，状态不改回（通知口径已按 failed 发出），但产物与
                # 可解释事件必须补齐入库，不再静默丢弃。
                if requested_status == "success" and current_run["status"] == "failed":
                    self.absorb_late_completed_run(run_id, current_run, safe_result)
                return
            self.persist_flow_outputs(current_run, safe_result)
            self.append_run_event(
                run_id,
                "run.complete",
                {"status": status, "result": safe_result, "executorType": "managed"},
            )
            self.audit_run_lifecycle(run_id, current_run, status)
            self.queue_run_deliveries(
                self.run_by_id(run_id), status, flush=False
            )
            self.database.execute("COMMIT")
        except Exception:
            try:
                self.database.execute("ROLLBACK")
            except Exception:
                pass
            raise
        # Network delivery stays on the maintenance loop. Flushing here would
        # block a ManagedRunner worker for up to 20 * 10s.

    def absorb_late_completed_run(
        self,
        run_id: str,
        current_run: dict[str, Any],
        safe_result: dict[str, Any],
    ) -> None:
        """W0-4 兜底：watchdog 误杀后迟到的 success 结果，产物补齐入库。"""
        try:
            self.persist_flow_outputs(current_run, safe_result)
            self.append_run_event(
                run_id,
                "run.lateCompletion",
                {"attemptedStatus": "success", "result": safe_result},
            )
        except Exception:
            # 兜底路径自身的写盘失败不应反向炸掉 worker 回调线程。
            pass

    def finalize_run_as_interrupted(self, run_id: str, reason: str) -> None:
        try:
            self.database.execute("BEGIN IMMEDIATE")
            updated = self.database.execute(
                """
                UPDATE platform_runs
                SET status = 'failed', result = ?, updated_at = ?
                WHERE id = ? AND status IN ('queued', 'running')
                """,
                (json({"error": reason, "interrupted": True}), now(), run_id),
            )
            if updated.rowcount != 1:
                self.database.execute("ROLLBACK")
                return
            self.append_run_event(run_id, "run.interrupted", {"reason": reason})
            self.append_run_event(
                run_id, "run.failed", {"reason": reason, "interrupted": True}
            )
            self.audit_run_lifecycle(run_id, self.run_by_id(run_id), "failed")
            self.queue_run_deliveries(
                self.run_by_id(run_id), "failed", flush=False
            )
            self.database.execute("COMMIT")
        except Exception:
            try:
                self.database.execute("ROLLBACK")
            except Exception:
                pass
            raise
