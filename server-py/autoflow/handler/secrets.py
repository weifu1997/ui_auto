"""Project secret routes."""
from __future__ import annotations

import uuid
from fastapi import APIRouter, Request, Response
from ..core import now
from ..http import PlatformError
from ..services import PlatformServices
from ._shared import (
    _send,
    _text,
)


def register(router: APIRouter, services: PlatformServices) -> None:

    @router.api_route(
        "/api/platform/projects/{project_id}/secrets", methods=["GET", "POST"]
    )
    async def project_secrets(request: Request, project_id: str) -> Response:
        user = services.session_user(dict(request.headers))
        if request.method == "GET":
            services.require_project_role(project_id, user.id)
        else:
            services.require_project_capability(project_id, user.id, "secret.manage")
        if request.method == "GET":
            rows = services.database.execute(
                """
                SELECT id, name, key_version, created_at, updated_at
                FROM project_secrets WHERE project_id = ? ORDER BY name
                """,
                (project_id,),
            ).fetchall()
            return _send(
                Response(),
                200,
                {
                    "secrets": [
                        {
                            "id": row[0],
                            "name": row[1],
                            "keyVersion": row[2],
                            "createdAt": row[3],
                            "updatedAt": row[4],
                        }
                        for row in rows
                    ]
                },
            )

        body = await request.json()
        if not isinstance(body, dict):
            body = {}
        name = _text(body.get("name")).strip()
        value = body.get("value")
        if not name or not isinstance(value, str) or not value:
            raise PlatformError(400, "SECRET_INPUT_INVALID")
        encrypted = services.encrypt(value)
        existing = services.database.execute(
            """
            SELECT id, key_version, created_at FROM project_secrets
            WHERE project_id = ? AND name = ?
            """,
            (project_id, name),
        ).fetchone()
        secret_id = existing[0] if existing else str(uuid.uuid4())
        key_version = (int(existing[1]) if existing else 0) + 1
        project = services.project_for(project_id)
        services.database.execute(
            """
            INSERT INTO project_secrets (
              id, project_id, name, key_version, iv, tag, ciphertext,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(project_id, name) DO UPDATE SET
              key_version = excluded.key_version,
              iv = excluded.iv,
              tag = excluded.tag,
              ciphertext = excluded.ciphertext,
              updated_at = excluded.updated_at
            """,
            (
                secret_id,
                project_id,
                name,
                key_version,
                encrypted["iv"],
                encrypted["tag"],
                encrypted["ciphertext"],
                existing[2] if existing else now(),
                now(),
            ),
        )
        services.audit(
            project["workspace_id"],
            {"type": "user", "id": user.id},
            "secret.rotated",
            {"type": "secret", "id": secret_id},
            {"name": name, "keyVersion": key_version},
            project_id,
        )
        return _send(
            Response(),
            201,
            {"secret": {"id": secret_id, "name": name, "keyVersion": key_version}},
        )
