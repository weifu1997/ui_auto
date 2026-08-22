"""Project metadata, document and settings routes."""
from __future__ import annotations

from fastapi import APIRouter, Request, Response
from ..core import json, now, parse_json
from ..http import PlatformError
from ..resources import as_record
from ..services import PlatformServices
from ._shared import (
    RESOURCE_CAPABILITIES,
    _send,
    _text,
)


def register(router: APIRouter, services: PlatformServices) -> None:

    @router.api_route("/api/platform/projects/{project_id}", methods=["GET", "PATCH"])
    async def project_base(request: Request, project_id: str) -> Response:
        user = services.session_user(dict(request.headers))
        if request.method == "GET":
            result = services.require_project_role(project_id, user.id)
        else:
            result = services.require_project_capability(
                project_id, user.id, "project.manage"
            )
        project = result["project"]
        if request.method == "GET":
            return _send(
                Response(), 200, {"project": services.project_response(project)}
            )
        body = await request.json()
        if not isinstance(body, dict):
            body = {}
        name = _text(body.get("name")).strip()[:160] or project["name"]
        description = (
            project["description"]
            if body.get("description") is None
            else _text(body.get("description")).strip()[:1000]
        )
        archived_at = (
            now()
            if body.get("archived") is True
            else None
            if body.get("archived") is False
            else project["archived_at"]
        )
        if body.get("archived") is True:
            services.database.execute(
                """
                UPDATE schedules SET enabled = 0, updated_at = ?
                WHERE project_id = ? AND enabled = 1
                """,
                (now(), project_id),
            )
            services.database.execute(
                """
                UPDATE webhook_triggers SET enabled = 0
                WHERE project_id = ? AND enabled = 1
                """,
                (project_id,),
            )
        services.database.execute(
            """
            UPDATE platform_projects
            SET name = ?, description = ?, archived_at = ?, updated_at = ?
            WHERE id = ? AND workspace_id = ?
            """,
            (
                name,
                description,
                archived_at,
                now(),
                project_id,
                project["workspace_id"],
            ),
        )
        services.audit(
            project["workspace_id"],
            {"type": "user", "id": user.id},
            "project.updated",
            {"type": "project", "id": project_id},
            {"archived": body.get("archived")},
            project_id,
        )
        return _send(
            Response(),
            200,
            {"project": services.project_response(services.project_for(project_id))},
        )

    @router.api_route(
        "/api/platform/projects/{project_id}/document", methods=["GET", "PUT"]
    )
    async def project_document(request: Request, project_id: str) -> Response:
        user = services.session_user(dict(request.headers))
        if request.method == "GET":
            result = services.require_project_role(project_id, user.id)
        else:
            result = services.require_project_capability(
                project_id, user.id, "dataset.manage"
            )
        project = result["project"]
        if request.method == "GET":
            return _send(Response(), 200, services.document_for(project_id))
        body = await request.json()
        if not isinstance(body, dict) or not isinstance(body.get("data"), dict):
            raise PlatformError(400, "DOCUMENT_REQUIRED")
        data = body["data"]
        for key, capability in RESOURCE_CAPABILITIES.items():
            if key in data:
                services.require_project_capability(project_id, user.id, capability)
        result = services.put_document(
            project_id, data, body.get("expectedVersion")
        )
        services.database.execute(
            """
            UPDATE platform_projects SET updated_at = ?
            WHERE id = ? AND workspace_id = ?
            """,
            (now(), project_id, project["workspace_id"]),
        )
        services.audit(
            project["workspace_id"],
            {"type": "user", "id": user.id},
            "project.document_saved",
            {"type": "project", "id": project_id},
            {"version": result["version"]},
            project_id,
        )
        return _send(Response(), 200, result)

    @router.api_route(
        "/api/platform/projects/{project_id}/settings", methods=["GET", "PUT"]
    )
    async def project_settings(request: Request, project_id: str) -> Response:
        user = services.session_user(dict(request.headers))
        if request.method == "GET":
            result = services.require_project_role(project_id, user.id)
        else:
            result = services.require_project_capability(
                project_id, user.id, "project.manage"
            )
        project = result["project"]
        current = services.database.execute(
            """
            SELECT data, version, updated_at, updated_by FROM project_settings
            WHERE project_id = ?
            """,
            (project_id,),
        ).fetchone()
        if request.method == "GET":
            return _send(
                Response(),
                200,
                {
                    "settings": {
                        "data": parse_json(current[0] if current else None, {}),
                        "version": current[1] if current else 0,
                        "updatedAt": current[2] if current else None,
                        "updatedBy": current[3] if current else None,
                    }
                },
            )

        body = await request.json()
        if not isinstance(body, dict):
            body = {}
        expected_version = body.get("expectedVersion")
        current_version = current[1] if current else 0
        if not isinstance(expected_version, int) or expected_version != current_version:
            raise PlatformError(
                409,
                "RESOURCE_VERSION_CONFLICT",
                {
                    "updatedBy": current[3] if current else None,
                    "updatedAt": current[2] if current else None,
                },
            )
        data = as_record(body.get("data"))
        version = expected_version + 1
        timestamp = now()
        services.database.execute(
            """
            INSERT INTO project_settings (
              project_id, data, version, updated_at, updated_by
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(project_id) DO UPDATE SET
              data = excluded.data,
              version = excluded.version,
              updated_at = excluded.updated_at,
              updated_by = excluded.updated_by
            """,
            (project_id, json(data), version, timestamp, user.id),
        )
        services.audit(
            project["workspace_id"],
            {"type": "user", "id": user.id},
            "project.settings_updated",
            {"type": "project", "id": project_id},
            {"version": version},
            project_id,
        )
        return _send(
            Response(),
            200,
            {
                "settings": {
                    "data": data,
                    "version": version,
                    "updatedAt": timestamp,
                    "updatedBy": user.id,
                }
            },
        )
