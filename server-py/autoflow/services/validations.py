"""Element validation lifecycle and managed validation enqueue."""
from __future__ import annotations

import uuid
from urllib.parse import urljoin, urlsplit
from typing import Any
from ..core import json, now, parse_json, safe_artifact_name


class ValidationServices:
    """Element validation lifecycle and managed validation enqueue."""

    def element_validation_by_id(
        self, validation_id: str, project_id: str | None = None
    ) -> dict[str, Any]:
        from ..http import PlatformError

        row = self.database.execute(
            """
            SELECT id, project_id, environment_id, agent_id, status,
                   element_snapshot, result, error, created_at, updated_at
            FROM element_validations
            WHERE id = ? AND (? IS NULL OR project_id = ?)
            """,
            (validation_id, project_id, project_id),
        ).fetchone()
        if not row:
            raise PlatformError(404, "ELEMENT_VALIDATION_NOT_FOUND")
        return {
            "id": row[0],
            "projectId": row[1],
            "environmentId": row[2],
            "agentId": row[3],
            "status": row[4],
            "element": parse_json(row[5], {}),
            "result": parse_json(row[6], None),
            "error": row[7] or None,
            "createdAt": row[8],
            "updatedAt": row[9],
        }

    def create_element_validation(
        self, project_id: str, environment_id: str, element: dict[str, Any], created_by: str
    ) -> dict[str, Any]:
        from ..http import PlatformError

        row = self.database.execute(
            """
            SELECT data FROM project_resources
            WHERE project_id = ? AND resource_type = 'environments'
              AND resource_id = ? AND archived_at IS NULL
            """,
            (project_id, environment_id),
        ).fetchone()
        if row:
            environment = parse_json(row[0], {})
        else:
            document = self.document_for(project_id)
            environments = document["data"].get("environments", [])
            environment = next(
                (
                    item
                    for item in environments
                    if isinstance(item, dict) and item.get("id") == environment_id
                ),
                None,
            )
        if not isinstance(environment, dict):
            raise PlatformError(404, "ENVIRONMENT_NOT_FOUND")
        self.require_chromium_environment(environment)
        self.require_same_origin_element_path(environment, element)
        agent = self.managed_agent(project_id)
        validation_id = str(uuid.uuid4())
        created_at = now()
        self.database.execute(
            """
            INSERT INTO element_validations (
              id, project_id, environment_id, agent_id, status,
              element_snapshot, created_by, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)
            """,
            (
                validation_id,
                project_id,
                environment_id,
                agent["id"],
                json(element),
                created_by,
                created_at,
                created_at,
            ),
        )
        validation = self.element_validation_by_id(validation_id)
        # 复用发起者最近一次录制会话的登录态快照（进程内存，重启即失），
        # 使登录后的页面也能通过元素定位器校验。
        storage_state = self.recording_session_state.state_for(
            created_by, project_id, environment_id
        )
        self.enqueue_managed_validation(validation, environment, storage_state)
        return self.element_validation_by_id(validation_id)

    def require_same_origin_element_path(
        self,
        environment: dict[str, Any],
        element: dict[str, Any],
    ) -> None:
        from ..http import PlatformError

        base_url = str(environment.get("baseUrl", ""))
        element_path = str(element.get("path", "/"))
        try:
            base = urlsplit(base_url)
            target = urlsplit(urljoin(base_url, element_path))
            if (
                base.scheme not in ("http", "https")
                or target.scheme != base.scheme
                or target.netloc != base.netloc
            ):
                raise PlatformError(400, "ELEMENT_VALIDATION_TARGET_FORBIDDEN")
        except PlatformError:
            raise
        except Exception:
            raise PlatformError(400, "ELEMENT_VALIDATION_TARGET_INVALID") from None

    def enqueue_managed_validation(
        self,
        validation: dict[str, Any],
        environment: dict[str, Any],
        storage_state: dict[str, Any] | None = None,
    ) -> None:
        validation_id = validation["id"]

        def started() -> None:
            self.database.execute(
                """
                UPDATE element_validations SET status = 'running', updated_at = ?
                WHERE id = ? AND status = 'queued'
                """,
                (now(), validation_id),
            )

        def artifact(input_data: dict[str, Any]) -> None:
            self.database.execute(
                """
                INSERT INTO element_validation_artifacts (
                  id, validation_id, project_id, name, content_type, path,
                  created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(uuid.uuid4()),
                    validation_id,
                    validation["projectId"],
                    safe_artifact_name(str(input_data["name"])),
                    str(input_data["contentType"])[:120],
                    str(input_data["path"]),
                    now(),
                ),
            )

        def completed(result: dict[str, Any]) -> None:
            artifact_row = self.database.execute(
                """
                SELECT id FROM element_validation_artifacts
                WHERE validation_id = ? ORDER BY created_at DESC LIMIT 1
                """,
                (validation_id,),
            ).fetchone()
            payload = {
                "count": result.get("count"),
                "firstMatch": result.get("firstMatch"),
                "elapsedMs": result.get("elapsedMs"),
                "screenshotId": artifact_row[0] if artifact_row else None,
            }
            self.database.execute(
                """
                UPDATE element_validations
                SET status = ?, result = ?, error = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    result.get("status"),
                    json(payload),
                    result.get("error"),
                    now(),
                    validation_id,
                ),
            )

        self.managed_runner.enqueue(
            validation_id,
            {
                "environment": environment,
                "element": validation["element"],
                "storage_state": storage_state,
            },
            {
                "started": started,
                "artifact": artifact,
                "event": lambda *_args: None,
                "completed": completed,
            },
            kind="validation",
            workspace_id=self.project_for(validation["projectId"])["workspace_id"],
        )
