"""Shared helpers and constants for the platform route modules."""
from __future__ import annotations

import re
from typing import Any
from fastapi import APIRouter, Request, Response
from ..core import json, parse_json
from ..http import PlatformError
from ..services import PlatformServices

RESOURCE_CAPABILITIES = {
    "flows": "flow.edit",
    "elements": "element.manage",
    "variables": "variable.manage",
    "environments": "environment.manage",
}


LOGIN_RATE_LIMIT_PER_MINUTE = 10


LOGIN_RATE_WINDOW_MS = 60_000


def _send(response: Response, status_code: int, body: Any) -> Response:
    return Response(
        content=json(body),
        status_code=status_code,
        media_type="application/json; charset=utf-8",
    )


def _text(value: Any) -> str:
    return "" if value is None else str(value)


def _batch_run_summaries(runs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    summaries: list[dict[str, Any]] = []
    for run in runs:
        snapshot = run.get("snapshot")
        flow = snapshot.get("flow") if isinstance(snapshot, dict) else None
        flow_name = flow.get("name") if isinstance(flow, dict) else None
        summaries.append(
            {
                "id": run["id"],
                "status": run["status"],
                "revisionId": run["revisionId"],
                "environmentId": run["environmentId"],
                "flowName": flow_name if isinstance(flow_name, str) else None,
                "cancellationRequested": run["cancellationRequested"],
                "retryOfRunId": run.get("retryOfRunId"),
                "batchItemIndex": run.get("batchItemIndex"),
                "createdAt": run["createdAt"],
                "updatedAt": run["updatedAt"],
            }
        )
    return summaries


def _recording_environment(
    services: PlatformServices,
    project_id: str,
    environment_id: str,
) -> dict[str, Any]:
    row = services.database.execute(
        """
        SELECT data FROM project_resources
        WHERE project_id = ? AND resource_type = 'environments'
          AND resource_id = ? AND archived_at IS NULL
        """,
        (project_id, environment_id),
    ).fetchone()
    if row:
        environment = parse_json(row[0], {})
        if isinstance(environment, dict):
            return environment
    document = services.document_for(project_id)
    environments = document["data"].get("environments", [])
    for item in environments:
        if isinstance(item, dict) and item.get("id") == environment_id:
            return item
    raise PlatformError(404, "ENVIRONMENT_NOT_FOUND")


def _recording_flow(
    services: PlatformServices,
    project_id: str,
    flow_id: str,
) -> dict[str, Any]:
    row = services.database.execute(
        """
        SELECT data FROM project_resources
        WHERE project_id = ? AND resource_type = 'flows'
          AND resource_id = ? AND archived_at IS NULL
        """,
        (project_id, flow_id),
    ).fetchone()
    if row:
        flow = parse_json(row[0], {})
        if isinstance(flow, dict):
            return flow
    document = services.document_for(project_id)
    flows = document["data"].get("flows", [])
    for item in flows:
        if isinstance(item, dict) and item.get("id") == flow_id:
            return item
    raise PlatformError(404, "FLOW_NOT_FOUND")


def _recording_session_for_owner(
    services: PlatformServices,
    project_id: str,
    session_id: str,
    user_id: str,
) -> dict[str, Any]:
    session = services.recording_coordinator._require_session(session_id)
    if session.get("projectId") != project_id or session.get("ownerId") != user_id:
        raise PlatformError(404, "RECORDING_SESSION_NOT_FOUND")
    return session


def _assert_snapshot_depth(value: Any, limit: int = 100, current: int = 0) -> None:
    if current > limit:
        raise PlatformError(400, "SNAPSHOT_TOO_DEEP")
    if isinstance(value, list):
        for item in value:
            _assert_snapshot_depth(item, limit, current + 1)
    elif isinstance(value, dict):
        for item in value.values():
            _assert_snapshot_depth(item, limit, current + 1)


_SENSITIVE_REVISION_HINT = re.compile(
    r"password|passwd|secret|token|api[\s_-]*key|credential|密码|口令|秘钥|密钥|令牌|凭证",
    re.IGNORECASE,
)


_SECRET_TEMPLATE = re.compile(r"^\{\{\s*[^}]+\s*\}\}$")


def _assert_revision_secret_safety(
    flow: dict[str, Any], secret_names: list[str]
) -> None:
    """Reject materialized sensitive input before it reaches a revision snapshot."""
    names = {name.strip() for name in secret_names if name.strip()}
    variables = flow.get("variables")
    if isinstance(variables, dict):
        for key, value in variables.items():
            if (
                isinstance(key, str)
                and _SENSITIVE_REVISION_HINT.search(key)
                and isinstance(value, str)
                and value
                and not _SECRET_TEMPLATE.fullmatch(value.strip())
            ):
                raise PlatformError(400, "REVISION_SECRET_VALUE_FORBIDDEN")
    steps = flow.get("steps")
    if not isinstance(steps, list):
        return
    for step in steps:
        if not isinstance(step, dict):
            continue
        hint = " ".join(
            str(step.get(key) or "") for key in ("title", "element", "name", "fieldHint")
        )
        value = step.get("value")
        if not _SENSITIVE_REVISION_HINT.search(hint) or not isinstance(value, str) or not value:
            continue
        if not _SECRET_TEMPLATE.fullmatch(value.strip()):
            raise PlatformError(400, "REVISION_SECRET_VALUE_FORBIDDEN")
        if not names or not any(name in value for name in names):
            raise PlatformError(400, "REVISION_SECRET_BINDING_INVALID")


def _client_ip(request: Request) -> str:
    if request.client:
        return request.client.host or "unknown"
    return "unknown"
