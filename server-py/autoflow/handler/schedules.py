"""Automation schedule routes."""
from __future__ import annotations

import uuid
from fastapi import APIRouter, Request, Response
from ..core import next_cron_time, now
from ..http import PlatformError
from ..services import PlatformServices
from ._shared import (
    _send,
    _text,
)


def register(router: APIRouter, services: PlatformServices) -> None:

    @router.api_route(
        "/api/platform/projects/{project_id}/schedules", methods=["GET", "POST"]
    )
    async def schedules(request: Request, project_id: str) -> Response:
        user = services.session_user(dict(request.headers))
        if request.method == "GET":
            result = services.require_project_role(project_id, user.id)
        else:
            result = services.require_project_capability(
                project_id, user.id, "automation.manage"
            )
        project = result["project"]
        if request.method == "GET":
            rows = services.database.execute(
                """
                SELECT id, revision_id, environment_id, dataset_version_id,
                       name, cron_expression, timezone, enabled, last_run_at,
                       next_run_at, created_at, updated_at
                FROM schedules
                WHERE project_id = ? AND archived_at IS NULL
                ORDER BY created_at DESC
                """,
                (project_id,),
            ).fetchall()
            return _send(
                Response(),
                200,
                {
                    "schedules": [
                        {
                            "id": row[0],
                            "revisionId": row[1],
                            "environmentId": row[2],
                            "datasetVersionId": row[3],
                            "name": row[4],
                            "cron": row[5],
                            "timezone": row[6],
                            "enabled": bool(row[7]),
                            "lastRunAt": row[8],
                            "nextRunAt": row[9],
                            "createdAt": row[10],
                            "updatedAt": row[11],
                        }
                        for row in rows
                    ]
                },
            )

        body = await request.json()
        if not isinstance(body, dict):
            body = {}
        name = _text(body.get("name")).strip()[:160]
        cron = _text(body.get("cron")).strip()
        timezone = _text(body.get("timezone")).strip() or "Asia/Shanghai"
        if not name or not cron or not body.get("environmentId"):
            raise PlatformError(400, "SCHEDULE_INPUT_INVALID")
        revision = services.published_revision_for(
            project_id, _text(body.get("revisionId")).strip() or None
        )
        services.require_revision_environment(
            revision, _text(body.get("environmentId")).strip()
        )
        dataset_version_id = _text(body.get("datasetVersionId")).strip() or None
        if dataset_version_id:
            services.dataset_version_for(project_id, dataset_version_id)
        schedule_id = str(uuid.uuid4())
        next_run_at = next_cron_time(cron, timezone)
        created_at = now()
        services.database.execute(
            """
            INSERT INTO schedules (
              id, project_id, revision_id, environment_id, dataset_version_id,
              name, cron_expression, timezone, enabled, next_run_at,
              created_by, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
            """,
            (
                schedule_id,
                project_id,
                revision["id"],
                _text(body.get("environmentId")).strip(),
                dataset_version_id,
                name,
                cron,
                timezone,
                next_run_at,
                user.id,
                created_at,
                created_at,
            ),
        )
        services.audit(
            project["workspace_id"],
            {"type": "user", "id": user.id},
            "schedule.created",
            {"type": "schedule", "id": schedule_id},
            {
                "revisionId": revision["id"],
                "environmentId": _text(body.get("environmentId")).strip(),
                "datasetVersionId": dataset_version_id,
                "cron": cron,
                "timezone": timezone,
            },
            project_id,
        )
        return _send(
            Response(),
            201,
            {
                "schedule": {
                    "id": schedule_id,
                    "name": name,
                    "revisionId": revision["id"],
                    "environmentId": _text(body.get("environmentId")).strip(),
                    "datasetVersionId": dataset_version_id,
                    "cron": cron,
                    "timezone": timezone,
                    "enabled": True,
                    "nextRunAt": next_run_at,
                }
            },
        )

    @router.api_route(
        "/api/platform/projects/{project_id}/schedules/{schedule_id}",
        methods=["PUT", "DELETE"],
    )
    async def schedule_detail(
        request: Request, project_id: str, schedule_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        result = services.require_project_capability(
            project_id, user.id, "automation.manage"
        )
        project = result["project"]
        if request.method == "PUT":
            body = await request.json()
            if not isinstance(body, dict):
                body = {}
            name = _text(body.get("name")).strip()[:160]
            cron = _text(body.get("cron")).strip()
            timezone = _text(body.get("timezone")).strip() or "Asia/Shanghai"
            environment_id = _text(body.get("environmentId")).strip()
            if not name or not cron or not environment_id:
                raise PlatformError(400, "SCHEDULE_INPUT_INVALID")
            revision = services.published_revision_for(
                project_id, _text(body.get("revisionId")).strip() or None
            )
            services.require_revision_environment(revision, environment_id)
            dataset_version_id = (
                _text(body.get("datasetVersionId")).strip() or None
            )
            if dataset_version_id:
                services.dataset_version_for(project_id, dataset_version_id)
            next_run_at = next_cron_time(cron, timezone)
            cursor = services.database.execute(
                """
                UPDATE schedules
                SET revision_id = ?, environment_id = ?,
                    dataset_version_id = ?, name = ?, cron_expression = ?,
                    timezone = ?, next_run_at = ?, updated_at = ?
                WHERE id = ? AND project_id = ? AND archived_at IS NULL
                """,
                (
                    revision["id"],
                    environment_id,
                    dataset_version_id,
                    name,
                    cron,
                    timezone,
                    next_run_at,
                    now(),
                    schedule_id,
                    project_id,
                ),
            )
            if cursor.rowcount == 0:
                raise PlatformError(404, "SCHEDULE_NOT_FOUND")
            services.audit(
                project["workspace_id"],
                {"type": "user", "id": user.id},
                "schedule.updated",
                {"type": "schedule", "id": schedule_id},
                {
                    "revisionId": revision["id"],
                    "environmentId": environment_id,
                    "datasetVersionId": dataset_version_id,
                    "cron": cron,
                    "timezone": timezone,
                },
                project_id,
            )
            return _send(
                Response(),
                200,
                {
                    "schedule": {
                        "id": schedule_id,
                        "name": name,
                        "revisionId": revision["id"],
                        "environmentId": environment_id,
                        "datasetVersionId": dataset_version_id,
                        "cron": cron,
                        "timezone": timezone,
                        "nextRunAt": next_run_at,
                    }
                },
            )
        cursor = services.database.execute(
            """
            UPDATE schedules SET archived_at = ?, enabled = 0, updated_at = ?
            WHERE id = ? AND project_id = ? AND archived_at IS NULL
            """,
            (now(), now(), schedule_id, project_id),
        )
        if cursor.rowcount == 0:
            raise PlatformError(404, "SCHEDULE_NOT_FOUND")
        services.audit(
            project["workspace_id"],
            {"type": "user", "id": user.id},
            "schedule.archived",
            {"type": "schedule", "id": schedule_id},
            {},
            project_id,
        )
        return _send(Response(), 200, {"scheduleId": schedule_id, "archived": True})

    @router.api_route(
        "/api/platform/projects/{project_id}/schedules/{schedule_id}/{action}",
        methods=["POST"],
    )
    async def schedule_action(
        request: Request, project_id: str, schedule_id: str, action: str
    ) -> Response:
        if action not in ("enable", "disable", "run"):
            raise PlatformError(404, "NOT_FOUND")
        user = services.session_user(dict(request.headers))
        result = services.require_project_capability(
            project_id, user.id, "automation.manage"
        )
        project = result["project"]
        schedule = services.database.execute(
            """
            SELECT id, revision_id, environment_id, dataset_version_id
            FROM schedules WHERE id = ? AND project_id = ? AND archived_at IS NULL
            """,
            (schedule_id, project_id),
        ).fetchone()
        if not schedule:
            raise PlatformError(404, "SCHEDULE_NOT_FOUND")
        if action == "run":
            queued = services.queue_published_runs(
                {
                    "projectId": project_id,
                    "revisionId": schedule[1],
                    "environmentId": schedule[2],
                    "datasetVersionId": schedule[3],
                    "createdBy": f"schedule:{schedule_id}",
                    "source": "schedule",
                }
            )
            services.database.execute(
                """
                UPDATE schedules
                SET last_run_at = ?, updated_at = ?
                WHERE id = ? AND project_id = ?
                """,
                (now(), now(), schedule_id, project_id),
            )
            services.audit(
                project["workspace_id"],
                {"type": "user", "id": user.id},
                "schedule.run_requested",
                {"type": "schedule", "id": schedule_id},
                {"runIds": queued["runIds"]},
                project_id,
            )
            return _send(Response(), 202, {"runIds": queued["runIds"]})

        enabled = 1 if action == "enable" else 0
        services.database.execute(
            """
            UPDATE schedules
            SET enabled = ?, updated_at = ?
            WHERE id = ? AND project_id = ?
            """,
            (enabled, now(), schedule_id, project_id),
        )
        services.audit(
            project["workspace_id"],
            {"type": "user", "id": user.id},
            "schedule.enabled" if action == "enable" else "schedule.disabled",
            {"type": "schedule", "id": schedule_id},
            {},
            project_id,
        )
        return _send(
            Response(),
            200,
            {"scheduleId": schedule_id, "enabled": action == "enable"},
        )
