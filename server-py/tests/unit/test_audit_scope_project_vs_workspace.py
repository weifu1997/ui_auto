"""Audit read-scope regression tests (P2-3).

``GET /api/platform/projects/{project_id}/audit-events`` requires any workspace
membership (``require_project_role`` read path passes for a plain ``member``),
yet its WHERE clause returns workspace-level rows too:

    (project_id = ? OR (project_id IS NULL AND workspace_id = ?))

Workspace-level rows are where security events live (logins with client IPs,
``workspace.created``, account changes). Every project member could therefore
read the whole workspace's login/security trail, including other users'
timestamps and source IPs. Workspace-level events must be visible only to
workspace admins; project members see only the project's own events.
"""

from __future__ import annotations

import asyncio
import json

from starlette.requests import Request

from autoflow.core import now
from autoflow.handler import create_platform_router
from autoflow.services import AuthUser, PlatformServices


def _setup(tmp_path):
    services = PlatformServices(str(tmp_path))
    router = create_platform_router(services)
    owner = AuthUser("owner-1", "owner@example.test", "Owner")
    member = AuthUser("member-1", "member@example.test", "Member")
    services.database.execute(
        """
        INSERT INTO platform_users (id, email, name, created_at)
        VALUES (?, ?, ?, ?)
        """,
        (owner.id, owner.email, owner.name, now()),
    )
    services.database.execute(
        """
        INSERT INTO platform_users (id, email, name, created_at)
        VALUES (?, ?, ?, ?)
        """,
        (member.id, member.email, member.name, now()),
    )
    workspace = services.create_workspace(owner, "Audit workspace")
    services.database.execute(
        """
        INSERT INTO workspace_members (workspace_id, user_id, role)
        VALUES (?, ?, 'member')
        """,
        (workspace["id"], member.id),
    )
    project_id = "project-1"
    services.database.execute(
        """
        INSERT INTO platform_projects (
          id, workspace_id, slug, name, description, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            project_id,
            workspace["id"],
            project_id,
            "Project",
            "",
            now(),
            now(),
        ),
    )

    # 工作区级安全事件：owner 的登录（detail 含 IP），project_id IS NULL。
    services.audit(
        workspace["id"],
        {"type": "user", "id": owner.id},
        "auth.login_succeeded",
        {"type": "user", "id": owner.id},
        {"ip": "203.0.113.7"},
    )
    # 项目级事件：发布审计，project_id = project-1。
    services.audit(
        workspace["id"],
        {"type": "user", "id": owner.id},
        "flow_revision.published",
        {"type": "revision", "id": "rev-2"},
        {},
        project_id=project_id,
    )

    audit_route = next(
        route
        for route in router.routes
        if getattr(route, "path", None)
        == "/api/platform/projects/{project_id}/audit-events"
    )
    return services, router, audit_route, owner, member, workspace, project_id


def _call(route, project_id: str, session) -> list[dict]:
    async def invoke():
        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": f"/api/platform/projects/{project_id}",
            "raw_path": f"/api/platform/projects/{project_id}".encode(),
            "query_string": b"",
            "headers": [(b"authorization", f"Bearer {session['token']}".encode())],
            "client": ("127.0.0.1", 1234),
            "server": ("127.0.0.1", 8787),
        }

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        return await route.endpoint(
            Request(scope, receive=receive), project_id=project_id
        )

    response = asyncio.run(invoke())
    assert response.status_code == 200
    return json.loads(response.body)["events"]


def test_project_member_cannot_read_workspace_level_audit(tmp_path):
    """A plain member sees the project's own events, never workspace-level rows
    (other users' logins/IPs, workspace.created)."""
    services, router, audit_route, owner, member, workspace, project_id = _setup(
        tmp_path
    )
    try:
        member_session = services.create_auth_session(member)
        events = _call(audit_route, project_id, member_session)

        # 修复前：member 能看到 owner 的登录事件与 workspace.created → 断言失败。
        assert [event["action"] for event in events] == [
            "flow_revision.published"
        ]
        assert all(event["actorId"] == owner.id for event in events)
        # 绝不能把登录类工作区安全事件漏给非管理员成员。
        assert not any(event["action"] == "auth.login_succeeded" for event in events)
    finally:
        services.close()


def test_workspace_admin_still_reads_workspace_level_audit(tmp_path):
    """Workspace admins keep the current scope: project rows plus workspace-level
    security rows, so the governance surface is not degraded for them."""
    services, router, audit_route, owner, member, workspace, project_id = _setup(
        tmp_path
    )
    try:
        owner_session = services.create_auth_session(owner)
        events = _call(audit_route, project_id, owner_session)
        actions = {event["action"] for event in events}
        assert actions == {
            "auth.login_succeeded",
            "flow_revision.published",
            "workspace.created",
        }
        login = next(event for event in events if event["action"] == "auth.login_succeeded")
        assert login["detail"] == {"ip": "203.0.113.7"}
    finally:
        services.close()
