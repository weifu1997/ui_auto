"""Notification channel, subscription and delivery routes."""
from __future__ import annotations

import sqlite3
import uuid
from typing import Any
from fastapi import APIRouter, Request, Response
from ..core import json, now
from ..http import PlatformError
from ..resources import as_record
from ..services import PlatformServices
from ..services._shared import notification_client_error
from ._shared import (
    _send,
    _text,
)


def register(router: APIRouter, services: PlatformServices) -> None:

    @router.api_route(
        "/api/platform/workspaces/{workspace_id}/notification-channels",
        methods=["GET", "POST"],
    )
    async def notification_channels(
        request: Request, workspace_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        if request.method == "GET":
            services.require_workspace_role(workspace_id, user.id)
        else:
            services.require_workspace_capability(
                workspace_id, user.id, "automation.manage"
            )
        if request.method == "GET":
            rows = services.database.execute(
                """
                SELECT id, name, channel_type, enabled, created_at, updated_at
                FROM notification_channels
                WHERE workspace_id = ? AND archived_at IS NULL ORDER BY name
                """,
                (workspace_id,),
            ).fetchall()
            return _send(
                Response(),
                200,
                {
                    "channels": [
                        {
                            "id": row[0],
                            "name": row[1],
                            "type": row[2],
                            "enabled": bool(row[3]),
                            "createdAt": row[4],
                            "updatedAt": row[5],
                        }
                        for row in rows
                    ]
                },
            )

        body = await request.json()
        if not isinstance(body, dict):
            body = {}
        name = _text(body.get("name")).strip()[:160]
        channel_type = body.get("type")
        config = body.get("config")
        allowed_types = {"webhook", "feishu", "dingtalk", "wecom", "email"}
        if (
            not name
            or channel_type not in allowed_types
            or not isinstance(config, dict)
            or not isinstance(config.get("url"), str)
        ):
            raise PlatformError(400, "NOTIFICATION_CHANNEL_INPUT_INVALID")
        try:
            endpoint = services.notification_target(config["url"])
        except Exception:
            raise PlatformError(400, "NOTIFICATION_URL_INVALID") from None
        keyword = config.get("keyword")
        keyword = (
            keyword.strip()[:200]
            if isinstance(keyword, str) and keyword.strip()
            else None
        )
        encrypted = services.encrypt(
            json(
                {
                    "url": endpoint["url"],
                    "headers": as_record(config.get("headers")),
                    **({"keyword": keyword} if keyword else {}),
                }
            )
        )
        channel_id = str(uuid.uuid4())
        created_at = now()
        try:
            services.database.execute(
                """
                INSERT INTO notification_channels (
                  id, workspace_id, name, channel_type, config_iv,
                  config_tag, config_ciphertext, enabled, created_by,
                  created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
                """,
                (
                    channel_id,
                    workspace_id,
                    name,
                    channel_type,
                    encrypted["iv"],
                    encrypted["tag"],
                    encrypted["ciphertext"],
                    user.id,
                    created_at,
                    created_at,
                ),
            )
        except sqlite3.IntegrityError:
            raise PlatformError(409, "NOTIFICATION_CHANNEL_NAME_EXISTS") from None
        services.audit(
            workspace_id,
            {"type": "user", "id": user.id},
            "notification_channel.created",
            {"type": "notification_channel", "id": channel_id},
            {"name": name, "type": channel_type},
        )
        return _send(
            Response(),
            201,
            {
                "channel": {
                    "id": channel_id,
                    "name": name,
                    "type": channel_type,
                    "enabled": True,
                    "createdAt": created_at,
                }
            },
        )

    @router.api_route(
        (
            "/api/platform/workspaces/{workspace_id}/notification-channels/"
            "{channel_id}"
        ),
        methods=["PUT", "DELETE"],
    )
    async def notification_channel_detail(
        request: Request, workspace_id: str, channel_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        services.require_workspace_capability(
            workspace_id, user.id, "automation.manage"
        )
        if request.method == "PUT":
            body = await request.json()
            if not isinstance(body, dict):
                body = {}
            current = services.database.execute(
                """
                SELECT name, channel_type, config_iv, config_tag,
                       config_ciphertext, enabled
                FROM notification_channels
                WHERE id = ? AND workspace_id = ? AND archived_at IS NULL
                """,
                (channel_id, workspace_id),
            ).fetchone()
            if not current:
                raise PlatformError(404, "NOTIFICATION_CHANNEL_NOT_FOUND")
            name = (
                _text(body.get("name")).strip()[:160]
                if body.get("name") is not None
                else current[0]
            )
            channel_type = body.get("type", current[1])
            enabled = (
                current[5]
                if body.get("enabled") is None
                else 1 if body.get("enabled") else 0
            )
            allowed_types = {"webhook", "feishu", "dingtalk", "wecom", "email"}
            if not name or channel_type not in allowed_types:
                raise PlatformError(400, "NOTIFICATION_CHANNEL_INPUT_INVALID")
            config = body.get("config")
            new_config = None
            if isinstance(config, dict):
                url = config.get("url")
                if isinstance(url, str) and url.strip():
                    try:
                        endpoint = services.notification_target(url)
                    except Exception:
                        raise PlatformError(400, "NOTIFICATION_URL_INVALID") from None
                    keyword = config.get("keyword")
                    keyword = (
                        keyword.strip()[:200]
                        if isinstance(keyword, str) and keyword.strip()
                        else None
                    )
                    new_config = {
                        "url": endpoint["url"],
                        "headers": as_record(config.get("headers")),
                        **({"keyword": keyword} if keyword else {}),
                    }
            if new_config is not None:
                encrypted = services.encrypt(json(new_config))
                cursor = services.database.execute(
                    """
                    UPDATE notification_channels
                    SET name = ?, channel_type = ?, enabled = ?,
                        config_iv = ?, config_tag = ?, config_ciphertext = ?,
                        updated_at = ?
                    WHERE id = ? AND workspace_id = ? AND archived_at IS NULL
                    """,
                    (
                        name,
                        channel_type,
                        enabled,
                        encrypted["iv"],
                        encrypted["tag"],
                        encrypted["ciphertext"],
                        now(),
                        channel_id,
                        workspace_id,
                    ),
                )
            else:
                cursor = services.database.execute(
                    """
                    UPDATE notification_channels
                    SET name = ?, channel_type = ?, enabled = ?, updated_at = ?
                    WHERE id = ? AND workspace_id = ? AND archived_at IS NULL
                    """,
                    (
                        name,
                        channel_type,
                        enabled,
                        now(),
                        channel_id,
                        workspace_id,
                    ),
                )
            if cursor.rowcount == 0:
                raise PlatformError(404, "NOTIFICATION_CHANNEL_NOT_FOUND")
            services.audit(
                workspace_id,
                {"type": "user", "id": user.id},
                "notification_channel.updated",
                {"type": "notification_channel", "id": channel_id},
                {"name": name, "type": channel_type, "enabled": bool(enabled)},
            )
            return _send(
                Response(),
                200,
                {
                    "channel": {
                        "id": channel_id,
                        "name": name,
                        "type": channel_type,
                        "enabled": bool(enabled),
                    }
                },
            )
        cursor = services.database.execute(
            """
            UPDATE notification_channels
            SET archived_at = ?, enabled = 0, updated_at = ?
            WHERE id = ? AND workspace_id = ? AND archived_at IS NULL
            """,
            (now(), now(), channel_id, workspace_id),
        )
        if cursor.rowcount == 0:
            raise PlatformError(404, "NOTIFICATION_CHANNEL_NOT_FOUND")
        services.audit(
            workspace_id,
            {"type": "user", "id": user.id},
            "notification_channel.archived",
            {"type": "notification_channel", "id": channel_id},
        )
        return _send(Response(), 200, {"channelId": channel_id, "archived": True})

    @router.api_route(
        (
            "/api/platform/workspaces/{workspace_id}/notification-channels/"
            "{channel_id}/test"
        ),
        methods=["POST"],
    )
    async def notification_channel_test(
        request: Request, workspace_id: str, channel_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        services.require_workspace_capability(
            workspace_id, user.id, "automation.manage"
        )
        try:
            result = services.send_test_notification(channel_id, workspace_id)
        except PlatformError:
            raise
        except Exception as exc:
            error = notification_client_error(exc)
            services.audit(
                workspace_id,
                {"type": "user", "id": user.id},
                "notification_channel.test_sent",
                {"type": "notification_channel", "id": channel_id},
                {"status": None, "error": error},
            )
            return _send(
                Response(),
                200,
                {"tested": True, "status": None, "error": error},
            )
        services.audit(
            workspace_id,
            {"type": "user", "id": user.id},
            "notification_channel.test_sent",
            {"type": "notification_channel", "id": channel_id},
            {"status": result.get("status"), "error": result.get("error")},
        )
        return _send(
            Response(),
            200,
            {
                "tested": True,
                "status": result.get("status"),
                "error": result.get("error"),
            },
        )

    @router.api_route(
        "/api/platform/projects/{project_id}/notification-subscriptions",
        methods=["GET", "PUT"],
    )
    async def notification_subscriptions(
        request: Request, project_id: str
    ) -> Response:
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
                SELECT s.channel_id, s.on_success, s.on_failure,
                       c.name, c.channel_type, c.enabled
                FROM notification_subscriptions s
                JOIN notification_channels c ON c.id = s.channel_id
                WHERE s.project_id = ? AND c.workspace_id = ?
                  AND c.archived_at IS NULL
                ORDER BY c.name
                """,
                (project_id, project["workspace_id"]),
            ).fetchall()
            return _send(
                Response(),
                200,
                {
                    "subscriptions": [
                        {
                            "channelId": row[0],
                            "name": row[3],
                            "type": row[4],
                            "channelEnabled": bool(row[5]),
                            "onSuccess": bool(row[1]),
                            "onFailure": bool(row[2]),
                        }
                        for row in rows
                    ]
                },
            )

        body = await request.json()
        if not isinstance(body, dict):
            body = {}
        channel_id = _text(body.get("channelId")).strip()
        if not channel_id:
            raise PlatformError(400, "NOTIFICATION_SUBSCRIPTION_INPUT_INVALID")
        channel = services.database.execute(
            """
            SELECT id FROM notification_channels
            WHERE id = ? AND workspace_id = ? AND archived_at IS NULL
            """,
            (channel_id, project["workspace_id"]),
        ).fetchone()
        if not channel:
            raise PlatformError(404, "NOTIFICATION_CHANNEL_NOT_FOUND")
        on_success = 1 if body.get("onSuccess") else 0
        on_failure = 0 if body.get("onFailure") is False else 1
        services.database.execute(
            """
            INSERT INTO notification_subscriptions (
              project_id, channel_id, on_success, on_failure
            ) VALUES (?, ?, ?, ?)
            ON CONFLICT(project_id, channel_id) DO UPDATE SET
              on_success = excluded.on_success,
              on_failure = excluded.on_failure
            """,
            (project_id, channel_id, on_success, on_failure),
        )
        services.audit(
            project["workspace_id"],
            {"type": "user", "id": user.id},
            "notification_subscription.saved",
            {"type": "notification_channel", "id": channel_id},
            {
                "onSuccess": bool(on_success),
                "onFailure": bool(on_failure),
            },
            project_id,
        )
        return _send(
            Response(),
            200,
            {
                "channelId": channel_id,
                "onSuccess": bool(on_success),
                "onFailure": bool(on_failure),
            },
        )

    @router.api_route(
        "/api/platform/projects/{project_id}/deliveries", methods=["GET"]
    )
    async def deliveries(request: Request, project_id: str) -> Response:
        user = services.session_user(dict(request.headers))
        services.require_project_role(project_id, user.id)
        query = request.query_params
        try:
            page = max(1, int(query.get("page", "1") or "1"))
            page_size = min(100, max(1, int(query.get("pageSize", "20") or "20")))
        except ValueError:
            raise PlatformError(400, "PAGINATION_INVALID") from None
        conditions = ["r.project_id = ?"]
        params: list[Any] = [project_id]
        status = _text(query.get("status")).strip()
        channel = _text(query.get("channel")).strip()
        from_time = _text(query.get("from")).strip()
        to_time = _text(query.get("to")).strip()
        if status:
            conditions.append("d.status = ?")
            params.append(status)
        if channel:
            conditions.append("c.name = ?")
            params.append(channel)
        if from_time:
            conditions.append("d.created_at >= ?")
            params.append(from_time)
        if to_time:
            conditions.append("d.created_at <= ?")
            params.append(to_time)
        where = " AND ".join(conditions)
        total = services.database.execute(
            f"""
            SELECT COUNT(*)
            FROM deliveries d
            JOIN platform_runs r ON r.id = d.run_id
            JOIN notification_channels c ON c.id = d.channel_id
            JOIN platform_projects p ON p.id = r.project_id
            WHERE {where} AND c.workspace_id = p.workspace_id
            """,
            tuple(params),
        ).fetchone()[0]
        rows = services.database.execute(
            f"""
            SELECT d.id, d.run_id, d.status, d.attempt_count, d.response_code,
                   d.error, d.created_at, d.delivered_at, c.name, c.channel_type
            FROM deliveries d
            JOIN platform_runs r ON r.id = d.run_id
            JOIN notification_channels c ON c.id = d.channel_id
            JOIN platform_projects p ON p.id = r.project_id
            WHERE {where} AND c.workspace_id = p.workspace_id
            ORDER BY d.created_at DESC LIMIT ? OFFSET ?
            """,
            (*params, page_size, (page - 1) * page_size),
        ).fetchall()
        return _send(
            Response(),
            200,
            {
                "deliveries": [
                    {
                        "id": row[0],
                        "runId": row[1],
                        "status": row[2],
                        "attempts": row[3],
                        "responseCode": row[4],
                        "error": row[5],
                        "createdAt": row[6],
                        "deliveredAt": row[7],
                        "channel": {"name": row[8], "type": row[9]},
                    }
                    for row in rows
                ],
                "total": total,
                "page": page,
                "pageSize": page_size,
            },
        )
