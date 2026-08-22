"""Project resource (flows/elements/variables/environments) routes."""
from __future__ import annotations

import sqlite3
import uuid
from fastapi import APIRouter, Request, Response
from ..core import json, now, parse_json
from ..http import PlatformError
from ..resources import public_resource_data
from ..services import PlatformServices
from ._shared import (
    RESOURCE_CAPABILITIES,
    _send,
    _text,
)


def register(router: APIRouter, services: PlatformServices) -> None:

    @router.api_route(
        "/api/platform/projects/{project_id}/resources/{resource_type}",
        methods=["GET", "POST"],
    )
    async def resource_collection(
        request: Request, project_id: str, resource_type: str
    ) -> Response:
        if resource_type not in RESOURCE_CAPABILITIES:
            raise PlatformError(404, "RESOURCE_NOT_FOUND")
        user = services.session_user(dict(request.headers))
        capability = RESOURCE_CAPABILITIES[resource_type]
        if request.method == "GET":
            result = services.require_project_role(project_id, user.id)
        else:
            result = services.require_project_capability(
                project_id, user.id, capability
            )
        project = result["project"]
        if request.method == "GET":
            include_archived = request.query_params.get("archived") == "1"
            query = """
                SELECT resource_id, data, version, archived_at, updated_at, updated_by
                FROM project_resources
                WHERE project_id = ? AND resource_type = ?
            """
            if not include_archived:
                query += " AND archived_at IS NULL"
            query += " ORDER BY updated_at DESC"
            rows = services.database.execute(
                query, (project_id, resource_type)
            ).fetchall()
            resources = [
                {
                    "id": row[0],
                    "data": public_resource_data(parse_json(row[1], {})),
                    "version": row[2],
                    "archivedAt": row[3],
                    "updatedAt": row[4],
                    "updatedBy": row[5],
                }
                for row in rows
            ]
            return _send(Response(), 200, {"resources": resources})

        body = await request.json()
        if not isinstance(body, dict):
            body = {}
        raw_data = body.get("data")
        if not isinstance(raw_data, dict):
            raw_data = {}
        if (
            raw_data.get("secret") is True
            and isinstance(raw_data.get("value"), str)
            and raw_data["value"].strip() != ""
        ):
            raise PlatformError(400, "SECRET_VALUE_NOT_PERSISTED")
        data = public_resource_data(raw_data)
        resource_id = _text(body.get("id")).strip()
        if not resource_id and isinstance(data.get("id"), str):
            resource_id = data["id"].strip()
        if not resource_id:
            resource_id = str(uuid.uuid4())
        if len(resource_id) > 240:
            raise PlatformError(400, "RESOURCE_ID_INVALID")
        timestamp = now()
        try:
            services.database.execute(
                """
                INSERT INTO project_resources (
                  project_id, resource_type, resource_id, data, version,
                  updated_at, updated_by
                ) VALUES (?, ?, ?, ?, 1, ?, ?)
                """,
                (
                    project_id,
                    resource_type,
                    resource_id,
                    json({**data, "id": resource_id}),
                    timestamp,
                    user.id,
                ),
            )
        except sqlite3.IntegrityError:
            raise PlatformError(409, "RESOURCE_ALREADY_EXISTS")
        services.audit(
            project["workspace_id"],
            {"type": "user", "id": user.id},
            f"{resource_type}.created",
            {"type": resource_type, "id": resource_id},
            {},
            project_id,
        )
        return _send(
            Response(),
            201,
            {
                "resource": {
                    "id": resource_id,
                    "data": {**data, "id": resource_id},
                    "version": 1,
                    "archivedAt": None,
                    "updatedAt": timestamp,
                    "updatedBy": user.id,
                }
            },
        )

    @router.api_route(
        "/api/platform/projects/{project_id}/resources/{resource_type}/{resource_id}",
        methods=["GET", "PUT", "PATCH", "DELETE"],
    )
    async def resource_detail(
        request: Request,
        project_id: str,
        resource_type: str,
        resource_id: str,
    ) -> Response:
        if resource_type not in RESOURCE_CAPABILITIES:
            raise PlatformError(404, "RESOURCE_NOT_FOUND")
        user = services.session_user(dict(request.headers))
        capability = RESOURCE_CAPABILITIES[resource_type]
        if request.method == "GET":
            result = services.require_project_role(project_id, user.id)
        else:
            result = services.require_project_capability(
                project_id, user.id, capability
            )
        project = result["project"]
        current = services.database.execute(
            """
            SELECT data, version, archived_at, updated_at, updated_by
            FROM project_resources
            WHERE project_id = ? AND resource_type = ? AND resource_id = ?
            """,
            (project_id, resource_type, resource_id),
        ).fetchone()
        if not current:
            raise PlatformError(404, "RESOURCE_NOT_FOUND")
        if request.method == "GET":
            return _send(
                Response(),
                200,
                {
                    "resource": {
                        "id": resource_id,
                        "data": public_resource_data(parse_json(current[0], {})),
                        "version": current[1],
                        "archivedAt": current[2],
                        "updatedAt": current[3],
                        "updatedBy": current[4],
                    }
                },
            )
        if request.method == "PUT" or request.method == "PATCH":
            body = await request.json()
            if not isinstance(body, dict) or not isinstance(
                body.get("expectedVersion"), int
            ):
                raise PlatformError(400, "EXPECTED_VERSION_REQUIRED")
            expected_version = body["expectedVersion"]
            previous = parse_json(current[0], {})
            if request.method == "PATCH":
                patch = body.get("data")
                merged = {
                    **previous,
                    **(patch if isinstance(patch, dict) else {}),
                    "id": resource_id,
                }
            else:
                raw = body.get("data")
                merged = {
                    **(raw if isinstance(raw, dict) else {}),
                    "id": resource_id,
                }
            if (
                merged.get("secret") is True
                and isinstance(merged.get("value"), str)
                and merged["value"].strip() != ""
            ):
                raise PlatformError(400, "SECRET_VALUE_NOT_PERSISTED")
            data = public_resource_data(merged)
            timestamp = now()
            archived_at = (
                timestamp
                if body.get("archived") is True
                else None
                if body.get("archived") is False
                else current[2]
            )
            cursor = services.database.execute(
                """
                UPDATE project_resources
                SET data = ?, version = version + 1, archived_at = ?,
                    updated_at = ?, updated_by = ?
                WHERE project_id = ? AND resource_type = ? AND resource_id = ?
                  AND version = ?
                """,
                (
                    json(data),
                    archived_at,
                    timestamp,
                    user.id,
                    project_id,
                    resource_type,
                    resource_id,
                    expected_version,
                ),
            )
            if cursor.rowcount == 0:
                raise PlatformError(
                    409,
                    "RESOURCE_VERSION_CONFLICT",
                    {"updatedBy": current[4], "updatedAt": current[3]},
                )
            version = expected_version + 1
            services.audit(
                project["workspace_id"],
                {"type": "user", "id": user.id},
                f"{resource_type}.updated",
                {"type": resource_type, "id": resource_id},
                {"version": version, "archived": body.get("archived")},
                project_id,
            )
            return _send(
                Response(),
                200,
                {
                    "resource": {
                        "id": resource_id,
                        "data": data,
                        "version": version,
                        "archivedAt": archived_at,
                        "updatedAt": timestamp,
                        "updatedBy": user.id,
                    }
                },
            )

        expected_text = request.query_params.get("expectedVersion")
        try:
            expected_version = int(expected_text)
        except (TypeError, ValueError):
            raise PlatformError(400, "EXPECTED_VERSION_REQUIRED")
        timestamp = now()
        cursor = services.database.execute(
            """
            UPDATE project_resources
            SET archived_at = ?, version = version + 1, updated_at = ?, updated_by = ?
            WHERE project_id = ? AND resource_type = ? AND resource_id = ?
              AND version = ?
            """,
            (
                timestamp,
                timestamp,
                user.id,
                project_id,
                resource_type,
                resource_id,
                expected_version,
            ),
        )
        if cursor.rowcount == 0:
            raise PlatformError(
                409,
                "RESOURCE_VERSION_CONFLICT",
                {"updatedBy": current[4], "updatedAt": current[3]},
            )
        services.audit(
            project["workspace_id"],
            {"type": "user", "id": user.id},
            f"{resource_type}.archived",
            {"type": resource_type, "id": resource_id},
            {},
            project_id,
        )
        return _send(
            Response(),
            200,
            {"id": resource_id, "archived": True, "version": expected_version + 1},
        )
