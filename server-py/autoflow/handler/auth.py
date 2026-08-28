"""Login/session/invitation/password-reset routes."""
from __future__ import annotations

import time
from fastapi import APIRouter, Request, Response
from ..auth import clear_session_cookie, password_matches, set_session_cookie
from ..core import authorization, digest
from ..http import PlatformError
from ..services import PlatformServices
from ._shared import (
    LOGIN_RATE_LIMIT_PER_MINUTE,
    LOGIN_RATE_WINDOW_MS,
    _client_ip,
    _send,
    _text,
)


def register(router: APIRouter, services: PlatformServices) -> None:

    login_rate_windows: dict[str, list[float]] = {}

    @router.api_route("/api/auth/register", methods=["POST"])
    async def register(request: Request) -> Response:
        # Bootstrap and invitation acceptance are the only account creation
        # paths. Keeping this route as a stable terminal error avoids silently
        # re-opening public registration through stale clients.
        raise PlatformError(410, "REGISTRATION_DISABLED")

    @router.api_route("/api/auth/login", methods=["POST"])
    async def login(request: Request) -> Response:
        ip = _client_ip(request)
        now_ms = time.time() * 1000
        cutoff = now_ms - LOGIN_RATE_WINDOW_MS
        hits = [
            timestamp
            for timestamp in login_rate_windows.get(ip, [])
            if timestamp > cutoff
        ]
        if len(hits) >= LOGIN_RATE_LIMIT_PER_MINUTE:
            login_rate_windows[ip] = hits
            raise PlatformError(429, "RATE_LIMITED")
        hits.append(now_ms)
        login_rate_windows[ip] = hits
        stale = [
            key
            for key, stamps in login_rate_windows.items()
            if key != ip and all(stamp <= cutoff for stamp in stamps)
        ]
        for key in stale:
            login_rate_windows.pop(key, None)

        body = await request.json()
        if not isinstance(body, dict):
            body = {}
        email = _text(body.get("email")).strip().lower()
        password = _text(body.get("password"))
        if not email or "@" not in email or not password:
            raise PlatformError(400, "LOGIN_INPUT_INVALID")
        user_row = services.database.execute(
            """
            SELECT id, email, name, global_role FROM platform_users
            WHERE email = ? AND enabled = 1
            """,
            (email,),
        ).fetchone()
        credential = None
        if user_row:
            credential = services.database.execute(
                """
                SELECT password_hash FROM platform_user_credentials
                WHERE user_id = ?
                """,
                (user_row[0],),
            ).fetchone()
        if not user_row or not credential or not password_matches(password, credential[0]):
            if user_row:
                failed_workspace = services.database.execute(
                    """
                    SELECT w.id FROM workspaces w
                    JOIN workspace_members m ON m.workspace_id = w.id
                    WHERE m.user_id = ? ORDER BY w.created_at ASC LIMIT 1
                    """,
                    (user_row[0],),
                ).fetchone()
                if failed_workspace:
                    services.audit(
                        failed_workspace[0],
                        {"type": "user", "id": user_row[0]},
                        "auth.login_failed",
                        {"type": "user", "id": user_row[0]},
                        {"reason": "LOGIN_INVALID", "ip": _client_ip(request)},
                    )
            raise PlatformError(401, "LOGIN_INVALID")
        from ..services import AuthUser

        user = AuthUser(user_row[0], user_row[1], user_row[2], user_row[3])
        session = services.create_auth_session(user)
        login_workspace = services.database.execute(
            """
            SELECT w.id FROM workspaces w
            JOIN workspace_members m ON m.workspace_id = w.id
            WHERE m.user_id = ? ORDER BY w.created_at ASC LIMIT 1
            """,
            (user.id,),
        ).fetchone()
        if login_workspace:
            services.audit(
                login_workspace[0],
                {"type": "user", "id": user.id},
                "auth.login_succeeded",
                {"type": "user", "id": user.id},
                {"ip": _client_ip(request)},
            )
        response = _send(Response(), 200, session)
        response.headers["set-cookie"] = set_session_cookie(
            session["token"], session["expiresAt"]
        )
        response.headers["cache-control"] = "no-store"
        return response

    @router.api_route("/api/auth/logout", methods=["POST"])
    async def logout(request: Request) -> Response:
        token = authorization(dict(request.headers))
        logout_user = None
        try:
            if token:
                logout_user = services.session_user(dict(request.headers))
        except PlatformError:
            pass
        if token:
            services.database.execute(
                "DELETE FROM platform_sessions WHERE token_hash = ?",
                (digest(token),),
            )
        if logout_user:
            logout_workspace = services.database.execute(
                """
                SELECT w.id FROM workspaces w
                JOIN workspace_members m ON m.workspace_id = w.id
                WHERE m.user_id = ? ORDER BY w.created_at ASC LIMIT 1
                """,
                (logout_user.id,),
            ).fetchone()
            if logout_workspace:
                services.audit(
                    logout_workspace[0],
                    {"type": "user", "id": logout_user.id},
                    "auth.logout",
                    {"type": "user", "id": logout_user.id},
                    {},
                )
        response = _send(Response(), 200, {"loggedOut": True})
        response.headers["set-cookie"] = clear_session_cookie()
        return response

    @router.api_route("/api/auth/session", methods=["GET"])
    async def session(request: Request) -> Response:
        user = services.session_user(dict(request.headers))
        return _send(
            Response(),
            200,
            {
                "user": {
                    "id": user.id,
                    "email": user.email,
                    "name": user.name,
                    "globalRole": user.global_role,
                },
                "workspaces": services.workspaces_for_user(user.id),
            },
        )

    @router.api_route("/api/auth/invitations/accept", methods=["POST"])
    async def accept_invitation(request: Request) -> Response:
        body = await request.json()
        if not isinstance(body, dict):
            body = {}
        current_user = None
        try:
            current_user = services.session_user(dict(request.headers))
        except PlatformError:
            # A new account does not have a session yet. The invitation service
            # still validates a supplied stale session as an anonymous request.
            pass
        user, created = services.accept_workspace_invitation(
            _text(body.get("token")),
            _text(body.get("email")),
            _text(body.get("password")) or None,
            _text(body.get("name")) or None,
            current_user,
        )
        result = {
            "accepted": True,
            "newAccount": created,
            "user": {
                "id": user.id,
                "email": user.email,
                "name": user.name,
                "globalRole": user.global_role,
            },
        }
        response = _send(Response(), 201 if created else 200, result)
        if created:
            session = services.create_auth_session(user)
            response.headers["set-cookie"] = set_session_cookie(
                session["token"], session["expiresAt"]
            )
        response.headers["cache-control"] = "no-store"
        return response

    @router.api_route("/api/auth/password-resets/accept", methods=["POST"])
    async def accept_password_reset(request: Request) -> Response:
        body = await request.json()
        if not isinstance(body, dict):
            body = {}
        services.accept_password_reset(
            _text(body.get("token")), _text(body.get("password"))
        )
        response = _send(Response(), 200, {"reset": True})
        response.headers["set-cookie"] = clear_session_cookie()
        response.headers["cache-control"] = "no-store"
        return response
