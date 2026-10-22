"""Audit event and analytics query routes."""
from __future__ import annotations

from typing import Any
from fastapi import APIRouter, Request, Response
from ..core import parse_json
from ..services import PlatformServices
from ..workspaces import role_has_capability
from ._shared import (
    _send,
)


def register(router: APIRouter, services: PlatformServices) -> None:

    @router.api_route(
        "/api/platform/projects/{project_id}/audit-events", methods=["GET"]
    )
    async def audit_events(request: Request, project_id: str) -> Response:
        user = services.session_user(dict(request.headers))
        result = services.require_project_role(project_id, user.id)
        project = result["project"]
        role = result["role"]
        params = request.query_params
        try:
            page = max(1, int(params.get("page", "1")))
        except (TypeError, ValueError):
            page = 1
        try:
            page_size = min(100, max(1, int(params.get("pageSize", "20"))))
        except (TypeError, ValueError):
            page_size = 20
        action = params.get("action", "").strip()
        actor_id = params.get("actorId", "").strip()
        actor_type = params.get("actorType", "").strip()
        from_value = params.get("from", "").strip()
        to_value = params.get("to", "").strip()
        q = params.get("q", "").strip()
        # 项目级审计对能读该项目的人可见；工作区级事件（登录/IP、workspace.*、
        # 账号变更等安全记录）只对具备 workspace.manage 能力的管理员可见，避免任意
        # 项目成员顺带读取整个工作区里其他成员的安全审计。
        workspace_capable = role_has_capability(role, "workspace.manage")
        conditions: list[str]
        sql_params: list[Any]
        if workspace_capable:
            conditions = [
                "(project_id = ? OR (project_id IS NULL AND workspace_id = ?))"
            ]
            sql_params = [project_id, project["workspace_id"]]
        else:
            conditions = ["project_id = ?"]
            sql_params = [project_id]
        if action:
            conditions.append("action LIKE ?")
            sql_params.append(f"{action}%")
        if actor_id:
            conditions.append("actor_id = ?")
            sql_params.append(actor_id)
        if actor_type:
            conditions.append("actor_type = ?")
            sql_params.append(actor_type)
        if from_value:
            conditions.append("created_at >= ?")
            sql_params.append(from_value)
        if to_value:
            conditions.append("created_at <= ?")
            sql_params.append(to_value)
        if q:
            like = f"%{q}%"
            conditions.append(
                "(action LIKE ? OR target_type LIKE ? OR target_id LIKE ? OR detail LIKE ?)"
            )
            sql_params.extend([like, like, like, like])
        where = " AND ".join(conditions)
        total = services.database.execute(
            f"SELECT COUNT(*) FROM audit_events WHERE {where}", tuple(sql_params)
        ).fetchone()[0]
        rows = services.database.execute(
            f"""
            SELECT id, actor_type, actor_id, action, target_type, target_id,
                   detail, created_at
            FROM audit_events
            WHERE {where}
            ORDER BY created_at DESC LIMIT ? OFFSET ?
            """,
            tuple([*sql_params, page_size, (page - 1) * page_size]),
        ).fetchall()
        return _send(
            Response(),
            200,
            {
                "events": [
                    {
                        "id": row[0],
                        "actorType": row[1],
                        "actorId": row[2],
                        "action": row[3],
                        "targetType": row[4],
                        "targetId": row[5],
                        "detail": parse_json(row[6], {}),
                        "createdAt": row[7],
                    }
                    for row in rows
                ],
                "total": total,
                "page": page,
                "pageSize": page_size,
            },
        )

    @router.api_route(
        "/api/platform/projects/{project_id}/analytics", methods=["GET"]
    )
    async def analytics(request: Request, project_id: str) -> Response:
        user = services.session_user(dict(request.headers))
        services.require_project_role(project_id, user.id)
        params = request.query_params
        try:
            window_days = int(params.get("window", ""))
        except (TypeError, ValueError):
            window_days = 0
        try:
            limit = int(params.get("limit", ""))
        except (TypeError, ValueError):
            limit = 0
        period = "week" if params.get("period") == "week" else "day"
        raw_category = params.get("categoryBy")
        category_by = (
            raw_category
            if raw_category in ("code", "step")
            else "message"
        )
        return _send(
            Response(),
            200,
            {
                "analytics": services.project_analytics(
                    project_id,
                    {
                        "windowDays": (
                            min(365, max(1, window_days))
                            if window_days > 0
                            else None
                        ),
                        "from": params.get("from", "").strip() or None,
                        "to": params.get("to", "").strip() or None,
                        "period": period,
                        "limit": max(1, limit) if limit > 0 else None,
                        "categoryBy": category_by,
                    },
                )
            },
        )
