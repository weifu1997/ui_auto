"""Super-admin account management and workspace membership/invitation routes."""
from __future__ import annotations

from fastapi import APIRouter, Request, Response
from ..http import PlatformError
from ..services import PlatformServices
from ._shared import (
    _send,
    _text,
)


def register(router: APIRouter, services: PlatformServices) -> None:

    @router.api_route("/api/admin/accounts", methods=["GET"])
    async def accounts(request: Request) -> Response:
        user = services.session_user(dict(request.headers))
        services.require_super_admin(user.id)
        return _send(Response(), 200, {"accounts": services.accounts()})

    @router.api_route("/api/admin/accounts/{account_id}", methods=["PATCH"])
    async def account_detail(request: Request, account_id: str) -> Response:
        user = services.session_user(dict(request.headers))
        services.require_super_admin(user.id)
        body = await request.json()
        if not isinstance(body, dict):
            body = {}
        if isinstance(body.get("enabled"), bool):
            account = services.set_account_enabled(account_id, body["enabled"], user.id)
        elif body.get("globalRole") in (None, "super_admin") and "globalRole" in body:
            account = services.set_account_global_role(
                account_id, body.get("globalRole"), user.id
            )
        else:
            raise PlatformError(400, "ACCOUNT_UPDATE_INVALID")
        return _send(Response(), 200, {"account": account})

    @router.api_route(
        "/api/admin/accounts/{account_id}/password-reset", methods=["POST"]
    )
    async def issue_password_reset(request: Request, account_id: str) -> Response:
        user = services.session_user(dict(request.headers))
        services.require_super_admin(user.id)
        reset = services.issue_password_reset(account_id, user.id)
        response = _send(Response(), 201, {"passwordReset": reset})
        response.headers["cache-control"] = "no-store"
        return response

    @router.api_route("/api/workspaces/{workspace_id}/members", methods=["GET"])
    async def workspace_members(request: Request, workspace_id: str) -> Response:
        user = services.session_user(dict(request.headers))
        services.require_workspace_capability(workspace_id, user.id, "member.manage")
        return _send(
            Response(), 200, {"members": services.workspace_members(workspace_id)}
        )

    @router.api_route(
        "/api/workspaces/{workspace_id}/members/{member_id}",
        methods=["PATCH", "DELETE"],
    )
    async def workspace_member_detail(
        request: Request, workspace_id: str, member_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        services.require_workspace_capability(workspace_id, user.id, "member.manage")
        if request.method == "DELETE":
            services.remove_workspace_member(workspace_id, member_id, user.id)
            return _send(Response(), 200, {"removed": True})
        body = await request.json()
        if not isinstance(body, dict) or not isinstance(body.get("role"), str):
            raise PlatformError(400, "WORKSPACE_ROLE_INVALID")
        member = services.update_workspace_member_role(
            workspace_id, member_id, body["role"], user.id
        )
        return _send(Response(), 200, {"member": member})

    @router.api_route(
        "/api/workspaces/{workspace_id}/invitations", methods=["GET", "POST"]
    )
    async def workspace_invitations(request: Request, workspace_id: str) -> Response:
        user = services.session_user(dict(request.headers))
        services.require_workspace_capability(workspace_id, user.id, "invite.manage")
        if request.method == "GET":
            return _send(
                Response(),
                200,
                {"invitations": services.workspace_invitations(workspace_id)},
            )
        body = await request.json()
        if not isinstance(body, dict):
            body = {}
        invitation = services.create_workspace_invitation(
            workspace_id,
            user.id,
            _text(body.get("email")),
            _text(body.get("role")),
        )
        response = _send(Response(), 201, {"invitation": invitation})
        response.headers["cache-control"] = "no-store"
        return response

    @router.api_route(
        "/api/workspaces/{workspace_id}/invitations/{invitation_id}/revoke",
        methods=["POST"],
    )
    async def revoke_workspace_invitation(
        request: Request, workspace_id: str, invitation_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        services.require_workspace_capability(workspace_id, user.id, "invite.manage")
        services.revoke_workspace_invitation(workspace_id, invitation_id, user.id)
        return _send(Response(), 200, {"revoked": True})
