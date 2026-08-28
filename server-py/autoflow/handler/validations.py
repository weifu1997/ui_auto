"""Element validation and validation-artifact routes."""
from __future__ import annotations

from pathlib import Path
from fastapi import APIRouter, Request, Response
from fastapi.responses import FileResponse
from ..http import PlatformError
from ..services import PlatformServices
from ._shared import (
    _send,
    _text,
)


def register(router: APIRouter, services: PlatformServices) -> None:

    @router.api_route(
        "/api/platform/projects/{project_id}/element-validations",
        methods=["POST"],
    )
    async def element_validations(request: Request, project_id: str) -> Response:
        user = services.session_user(dict(request.headers))
        result = services.require_project_capability(
            project_id, user.id, "run.execute"
        )
        project = result["project"]
        body = await request.json()
        if not isinstance(body, dict):
            body = {}
        environment_id = _text(body.get("environmentId")).strip()
        element = body.get("element")
        if not environment_id or not isinstance(element, dict):
            raise PlatformError(400, "ELEMENT_VALIDATION_INPUT_INVALID")
        validation = services.create_element_validation(
            project_id, environment_id, element, user.id
        )
        services.audit(
            project["workspace_id"],
            {"type": "user", "id": user.id},
            "element.validation_started",
            {"type": "element_validation", "id": validation["id"]},
            {
                "environmentId": environment_id,
                "elementId": element.get("id"),
            },
            project_id,
        )
        return _send(Response(), 202, {"validation": validation})

    @router.api_route(
        "/api/platform/projects/{project_id}/element-validations/{validation_id}",
        methods=["GET"],
    )
    async def element_validation_detail(
        request: Request, project_id: str, validation_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        services.require_project_role(project_id, user.id)
        validation = services.element_validation_by_id(validation_id, project_id)
        return _send(Response(), 200, {"validation": validation})

    @router.api_route(
        "/api/platform/projects/{project_id}/element-validations/{validation_id}/cancel",
        methods=["POST"],
    )
    async def element_validation_cancel(
        request: Request, project_id: str, validation_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        services.require_project_capability(project_id, user.id, "run.execute")
        validation = services.cancel_element_validation(validation_id, project_id)
        return _send(Response(), 200, {"validation": validation})

    @router.api_route(
        "/api/platform/validation-artifacts/{artifact_id}", methods=["GET"]
    )
    async def validation_artifact(
        request: Request, artifact_id: str
    ) -> FileResponse:
        user = services.session_user(dict(request.headers))
        artifact = services.database.execute(
            """
            SELECT id, name, content_type, path, project_id
            FROM element_validation_artifacts WHERE id = ?
            """,
            (artifact_id,),
        ).fetchone()
        if not artifact:
            raise PlatformError(404, "ARTIFACT_NOT_FOUND")
        services.require_project_role(artifact[4], user.id)
        path = Path(artifact[3])
        if not path.is_file():
            raise PlatformError(404, "ARTIFACT_FILE_MISSING")
        return FileResponse(
            path,
            media_type=artifact[2],
            filename=artifact[1],
        )
