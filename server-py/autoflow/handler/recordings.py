"""Browser recording session lifecycle routes."""
from __future__ import annotations

from fastapi import APIRouter, Request, Response
from starlette.concurrency import run_in_threadpool
from ..http import PlatformError
from ..services import PlatformServices
from ._shared import (
    _recording_environment,
    _recording_flow,
    _recording_session_for_owner,
    _send,
    _text,
)


def register(router: APIRouter, services: PlatformServices) -> None:

    @router.api_route(
        "/api/platform/projects/{project_id}/recording-sessions",
        methods=["POST"],
    )
    async def recording_session_create(
        request: Request, project_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        result = services.require_project_capability(
            project_id, user.id, "flow.edit"
        )
        project = result["project"]
        try:
            body = await request.json()
        except Exception:
            raise PlatformError(400, "RECORDING_INPUT_INVALID") from None
        if not isinstance(body, dict):
            body = {}
        flow_id = _text(body.get("flowId")).strip()
        environment_id = _text(body.get("environmentId")).strip()
        start_url = _text(body.get("startUrl")).strip()
        fresh_login = bool(body.get("freshLogin"))
        if not flow_id or not environment_id:
            raise PlatformError(400, "RECORDING_INPUT_INVALID")
        _recording_flow(services, project_id, flow_id)
        environment = _recording_environment(
            services, project_id, environment_id
        )
        def _create_session():
            return services.recording_coordinator.create_session(
                project_id,
                flow_id,
                environment,
                start_url or "/",
                owner_id=user.id,
                fresh_login=fresh_login,
                login_state_provider=lambda recording_project_id, recording_environment_id: services.recording_login_state(
                    user.id, recording_project_id, recording_environment_id
                ),
            )

        session = await run_in_threadpool(_create_session)
        services.audit(
            project["workspace_id"],
            {"type": "user", "id": user.id},
            "recording.session_started",
            {"type": "recording_session", "id": session["id"]},
            {
                "flowId": flow_id,
                "environmentId": environment_id,
                "currentUrl": session["currentUrl"],
            },
            project_id,
        )
        return _send(Response(), 201, {"session": session})

    @router.api_route(
        "/api/platform/projects/{project_id}/recording-sessions",
        methods=["GET"],
    )
    async def recording_session_list(
        request: Request, project_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        services.require_project_capability(project_id, user.id, "flow.edit")
        query = request.query_params
        try:
            page = max(1, int(query.get("page", "1") or "1"))
            page_size = min(100, max(1, int(query.get("pageSize", "20") or "20")))
        except ValueError:
            raise PlatformError(400, "PAGINATION_INVALID") from None
        return _send(
            Response(),
            200,
            services.recording_coordinator.list_sessions(
                project_id, user.id, page, page_size
            ),
        )

    @router.api_route(
        "/api/platform/projects/{project_id}/recording-sessions/cancel-active",
        methods=["POST"],
    )
    async def recording_session_cancel_active(
        request: Request, project_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        capability = services.require_project_capability(
            project_id, user.id, "flow.edit"
        )
        try:
            body = await request.json()
        except Exception:
            raise PlatformError(400, "RECORDING_INPUT_INVALID") from None
        if not isinstance(body, dict):
            body = {}
        environment_id = _text(body.get("environmentId")).strip()
        if not environment_id:
            raise PlatformError(400, "RECORDING_INPUT_INVALID")
        session = await run_in_threadpool(
            services.recording_coordinator.cancel_active,
            project_id,
            environment_id,
            user.id,
        )
        if session is not None:
            services.audit(
                capability["project"]["workspace_id"],
                {"type": "user", "id": user.id},
                "recording.session_canceled",
                {"type": "recording_session", "id": session["id"]},
                {
                    "flowId": session["flowId"],
                    "environmentId": session["environmentId"],
                    "status": session["status"],
                },
                project_id,
            )
        return _send(
            Response(),
            200,
            {"canceled": session is not None, "session": session},
        )

    @router.api_route(
        "/api/platform/projects/{project_id}/recording-sessions/{session_id}",
        methods=["GET"],
    )
    async def recording_session_detail(
        request: Request, project_id: str, session_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        services.require_project_capability(project_id, user.id, "flow.edit")
        session = services.recording_coordinator.session_response(
            _recording_session_for_owner(services, project_id, session_id, user.id)
        )
        return _send(Response(), 200, {"session": session})

    @router.api_route(
        "/api/platform/projects/{project_id}/recording-sessions/{session_id}/result",
        methods=["GET"],
    )
    async def recording_session_result(
        request: Request, project_id: str, session_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        services.require_project_capability(project_id, user.id, "flow.edit")
        _recording_session_for_owner(services, project_id, session_id, user.id)
        payload = services.recording_coordinator.session_result(session_id)
        return _send(
            Response(),
            200,
            {"session": payload["session"], "result": payload["result"]},
        )

    @router.api_route(
        "/api/platform/projects/{project_id}/recording-sessions/{session_id}/events",
        methods=["GET"],
    )
    async def recording_session_events(
        request: Request, project_id: str, session_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        services.require_project_capability(project_id, user.id, "flow.edit")
        _recording_session_for_owner(services, project_id, session_id, user.id)
        query = request.query_params
        try:
            after_seq = int(query.get("afterSeq", "0") or "0")
        except ValueError:
            raise PlatformError(400, "RECORDING_AFTER_SEQ_INVALID") from None
        if after_seq < 0:
            raise PlatformError(400, "RECORDING_AFTER_SEQ_INVALID")
        try:
            limit = int(query.get("limit", "100") or "100")
        except ValueError:
            raise PlatformError(400, "RECORDING_LIMIT_INVALID") from None
        if limit < 1 or limit > 500:
            raise PlatformError(400, "RECORDING_LIMIT_INVALID")
        return _send(
            Response(),
            200,
            services.recording_coordinator.events_after(
                session_id, after_seq, limit
            ),
        )

    @router.api_route(
        "/api/platform/projects/{project_id}/recording-sessions/{session_id}/pause",
        methods=["POST"],
    )
    async def recording_session_pause(
        request: Request, project_id: str, session_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        services.require_project_capability(project_id, user.id, "flow.edit")
        _recording_session_for_owner(services, project_id, session_id, user.id)
        return _send(
            Response(),
            200,
            {"session": services.recording_coordinator.pause(session_id)},
        )

    @router.api_route(
        "/api/platform/projects/{project_id}/recording-sessions/{session_id}/resume",
        methods=["POST"],
    )
    async def recording_session_resume(
        request: Request, project_id: str, session_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        services.require_project_capability(project_id, user.id, "flow.edit")
        _recording_session_for_owner(services, project_id, session_id, user.id)
        return _send(
            Response(),
            200,
            {"session": services.recording_coordinator.resume(session_id)},
        )

    @router.api_route(
        "/api/platform/projects/{project_id}/recording-sessions/{session_id}/stop",
        methods=["POST"],
    )
    async def recording_session_stop(
        request: Request, project_id: str, session_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        capability = services.require_project_capability(
            project_id, user.id, "flow.edit"
        )
        session = _recording_session_for_owner(
            services, project_id, session_id, user.id
        )
        was_active = session["status"] not in ("stopped", "canceled", "expired", "failed")
        stopped = await run_in_threadpool(
            services.recording_coordinator.stop, session_id
        )
        result = services.recording_coordinator.session_result(session_id)
        if was_active:
            services.audit(
                capability["project"]["workspace_id"],
                {"type": "user", "id": user.id},
                "recording.session_stopped",
                {"type": "recording_session", "id": session_id},
                {
                    "flowId": stopped["flowId"],
                    "environmentId": stopped["environmentId"],
                    "status": stopped["status"],
                },
                project_id,
            )
        return _send(
            Response(),
            200,
            {"session": stopped, "result": result["result"]},
        )

    @router.api_route(
        "/api/platform/projects/{project_id}/recording-sessions/{session_id}",
        methods=["DELETE"],
    )
    async def recording_session_cancel(
        request: Request, project_id: str, session_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        capability = services.require_project_capability(
            project_id, user.id, "flow.edit"
        )
        session = _recording_session_for_owner(
            services, project_id, session_id, user.id
        )
        was_active = session["status"] not in ("stopped", "canceled", "expired", "failed")
        canceled = await run_in_threadpool(
            services.recording_coordinator.cancel, session_id
        )
        if was_active:
            services.audit(
                capability["project"]["workspace_id"],
                {"type": "user", "id": user.id},
                "recording.session_canceled",
                {"type": "recording_session", "id": session_id},
                {
                    "flowId": canceled["flowId"],
                    "environmentId": canceled["environmentId"],
                    "status": canceled["status"],
                },
                project_id,
            )
        return _send(Response(), 200, {"session": canceled})
