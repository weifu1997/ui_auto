import asyncio
import json
import sqlite3

import pytest
from fastapi import Request
from fastapi.testclient import TestClient

from autoflow.handler import create_platform_router
from autoflow.http import PlatformError
from autoflow.main import create_app
from autoflow.migrations import add_identity_membership_rbac
from autoflow.services import BOOTSTRAP_SCHEMA, AuthUser, PlatformServices
from autoflow.workspaces import GLOBAL_ROLE_SUPER_ADMIN


def _route(router, path: str):
    return next(route for route in router.routes if getattr(route, "path", None) == path)


def _call(route, *, method: str, body: dict | None = None, token: str | None = None, path_params: dict | None = None):
    async def run():
        raw_body = json.dumps(body).encode() if body is not None else b""

        async def receive():
            return {"type": "http.request", "body": raw_body, "more_body": False}

        headers = [(b"content-type", b"application/json")]
        if token:
            headers.append((b"authorization", f"Bearer {token}".encode()))
        scope = {
            "type": "http",
            "method": method,
            "path": "/api/test",
            "raw_path": b"/api/test",
            "query_string": b"",
            "headers": headers,
            "client": ("127.0.0.1", 1234),
            "server": ("127.0.0.1", 8787),
        }
        return await route.endpoint(Request(scope, receive=receive), **(path_params or {}))

    return asyncio.run(run())


def _bootstrap(services: PlatformServices) -> tuple[AuthUser, dict, dict]:
    super_admin = services.bootstrap_super_admin(
        "super@example.test", "Super Admin", "bootstrap-password"
    )
    session = services.create_auth_session(super_admin)
    workspace = services.create_workspace(super_admin, "Primary workspace")
    return super_admin, session, workspace


def test_migration_normalizes_legacy_roles_and_revokes_sessions():
    database = sqlite3.connect(":memory:")
    try:
        database.executescript(BOOTSTRAP_SCHEMA)
        database.execute(
            "INSERT INTO platform_users (id, email, name, created_at) VALUES (?, ?, ?, ?)",
            ("user-admin", "admin@example.test", "Admin", "2026-01-01T00:00:00.000Z"),
        )
        database.execute(
            "INSERT INTO platform_users (id, email, name, created_at) VALUES (?, ?, ?, ?)",
            ("user-member", "member@example.test", "Member", "2026-01-01T00:00:00.000Z"),
        )
        database.execute(
            "INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)",
            ("workspace-1", "Workspace", "2026-01-01T00:00:00.000Z"),
        )
        database.execute(
            "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)",
            ("workspace-1", "user-admin", "owner"),
        )
        database.execute(
            "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)",
            ("workspace-1", "user-member", "viewer"),
        )
        database.execute(
            "INSERT INTO platform_sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
            ("old-session", "user-admin", "2099-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"),
        )

        add_identity_membership_rbac(database)

        roles = database.execute(
            "SELECT user_id, role FROM workspace_members ORDER BY user_id"
        ).fetchall()
        assert roles == [("user-admin", "admin"), ("user-member", "member")]
        assert database.execute("SELECT COUNT(*) FROM platform_sessions").fetchone() == (0,)
        assert database.execute(
            "SELECT global_role FROM platform_users WHERE id = ?", ("user-admin",)
        ).fetchone() == (None,)
    finally:
        database.close()


def test_public_registration_is_terminal_without_side_effects(tmp_path):
    services = PlatformServices(str(tmp_path))
    try:
        router = create_platform_router(services)
        register = _route(router, "/api/auth/register")
        before = services.database.execute("SELECT COUNT(*) FROM platform_users").fetchone()[0]
        with pytest.raises(PlatformError) as error:
            _call(
                register,
                method="POST",
                body={"email": "public@example.test", "password": "password-123"},
            )
        assert error.value.status == 410
        assert error.value.code == "REGISTRATION_DISABLED"
        assert services.database.execute("SELECT COUNT(*) FROM platform_users").fetchone()[0] == before
        assert services.database.execute("SELECT COUNT(*) FROM workspaces").fetchone() == (0,)
    finally:
        services.close()


def test_bootstrap_writes_redacted_deployment_audit_event(tmp_path):
    services = PlatformServices(str(tmp_path))
    try:
        user = services.bootstrap_super_admin(
            "bootstrap@example.test", "Bootstrap", "bootstrap-password"
        )
        row = services.database.execute(
            """
            SELECT actor_type, actor_id, action, target_type, target_id, detail
            FROM deployment_audit_events
            """
        ).fetchone()
        assert row[:5] == (
            "system",
            "bootstrap",
            "account.super_admin_bootstrapped",
            "user",
            user.id,
        )
        assert json.loads(row[5]) == {
            "created": True,
            "promoted": False,
            "revokedSessions": 0,
        }
        assert "bootstrap@example.test" not in row[5]
        assert "bootstrap-password" not in row[5]
    finally:
        services.close()


def test_bootstrap_promotion_revokes_existing_sessions_and_is_audited(tmp_path):
    services = PlatformServices(str(tmp_path))
    try:
        services.database.execute(
            """
            INSERT INTO platform_users (id, email, name, created_at)
            VALUES (?, ?, ?, ?)
            """,
            ("existing-user", "existing@example.test", "Existing", "2026-01-01T00:00:00.000Z"),
        )
        services.database.execute(
            """
            INSERT INTO platform_user_credentials (user_id, password_hash, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            """,
            ("existing-user", "existing-credential", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"),
        )
        services.create_auth_session(
            AuthUser("existing-user", "existing@example.test", "Existing")
        )

        promoted = services.bootstrap_super_admin(
            "existing@example.test", None, None
        )

        assert promoted.id == "existing-user"
        assert promoted.global_role == GLOBAL_ROLE_SUPER_ADMIN
        assert services.database.execute(
            "SELECT COUNT(*) FROM platform_sessions WHERE user_id = ?",
            (promoted.id,),
        ).fetchone() == (0,)
        detail = services.database.execute(
            """
            SELECT detail FROM deployment_audit_events
            WHERE action = 'account.super_admin_bootstrapped' AND target_id = ?
            """,
            (promoted.id,),
        ).fetchone()[0]
        assert json.loads(detail) == {
            "created": False,
            "promoted": True,
            "revokedSessions": 1,
        }
        assert "existing@example.test" not in detail
    finally:
        services.close()


def test_replacing_an_active_invitation_writes_a_safe_revocation_audit(tmp_path):
    services = PlatformServices(str(tmp_path))
    try:
        super_admin, _, workspace = _bootstrap(services)
        first = services.create_workspace_invitation(
            workspace["id"], super_admin.id, "replaced@example.test", "member"
        )
        second = services.create_workspace_invitation(
            workspace["id"], super_admin.id, "replaced@example.test", "admin"
        )
        assert services.database.execute(
            "SELECT revoked_at IS NOT NULL FROM workspace_invitations WHERE id = ?",
            (first["id"],),
        ).fetchone() == (1,)
        assert services.database.execute(
            "SELECT revoked_at FROM workspace_invitations WHERE id = ?",
            (second["id"],),
        ).fetchone() == (None,)
        audit = services.database.execute(
            """
            SELECT action, target_id, detail FROM audit_events
            WHERE action = 'workspace.invitation_revoked' AND target_id = ?
            """,
            (first["id"],),
        ).fetchone()
        assert audit[:2] == ("workspace.invitation_revoked", first["id"])
        assert json.loads(audit[2]) == {"reason": "replaced"}
        serialized = json.dumps(audit)
        for sensitive in (first["token"], second["token"], "replaced@example.test"):
            assert sensitive not in serialized
    finally:
        services.close()


def test_invitation_acceptance_is_atomic_replay_safe_and_redacted(tmp_path):
    services = PlatformServices(str(tmp_path))
    try:
        super_admin, _, workspace = _bootstrap(services)
        invitation = services.create_workspace_invitation(
            workspace["id"], super_admin.id, "new@example.test", "member"
        )
        stored = services.database.execute(
            "SELECT token_hash FROM workspace_invitations WHERE id = ?",
            (invitation["id"],),
        ).fetchone()[0]
        assert stored != invitation["token"]
        assert invitation["token"] not in stored

        user, created = services.accept_workspace_invitation(
            invitation["token"],
            "new@example.test",
            "member-password",
            "New member",
        )
        assert created is True
        first_session = services.create_auth_session(user)
        before = {
            "users": services.database.execute("SELECT COUNT(*) FROM platform_users").fetchone()[0],
            "members": services.database.execute("SELECT COUNT(*) FROM workspace_members").fetchone()[0],
            "sessions": services.database.execute("SELECT COUNT(*) FROM platform_sessions").fetchone()[0],
            "accepted_audits": services.database.execute(
                "SELECT COUNT(*) FROM audit_events WHERE action = 'workspace.invitation_accepted'"
            ).fetchone()[0],
        }
        with pytest.raises(PlatformError) as error:
            services.accept_workspace_invitation(
                invitation["token"],
                "new@example.test",
                "different-password",
                "Different",
            )
        assert error.value.status == 410
        assert error.value.code == "INVITE_ALREADY_USED"
        assert error.value.detail is None
        # The replay terminal state wins even if a caller removes the email
        # that was valid for the first acceptance.
        with pytest.raises(PlatformError) as malformed_replay:
            services.accept_workspace_invitation(
                invitation["token"], "", None, None
            )
        assert malformed_replay.value.status == 410
        assert malformed_replay.value.code == "INVITE_ALREADY_USED"
        after = {
            "users": services.database.execute("SELECT COUNT(*) FROM platform_users").fetchone()[0],
            "members": services.database.execute("SELECT COUNT(*) FROM workspace_members").fetchone()[0],
            "sessions": services.database.execute("SELECT COUNT(*) FROM platform_sessions").fetchone()[0],
            "accepted_audits": services.database.execute(
                "SELECT COUNT(*) FROM audit_events WHERE action = 'workspace.invitation_accepted'"
            ).fetchone()[0],
        }
        assert after == before
        assert services.session_user({"authorization": f"Bearer {first_session['token']}"}).id == user.id
    finally:
        services.close()


def test_invitation_replay_has_exact_http_terminal_contract(tmp_path):
    services = PlatformServices(str(tmp_path))
    try:
        super_admin, super_session, workspace = _bootstrap(services)
        invitation = services.create_workspace_invitation(
            workspace["id"], super_admin.id, "http@example.test", "member"
        )
        # Use the app lifespan so the request runs against the same startup and
        # shutdown contract as the production service, and closes resources.
        with TestClient(create_app(services), raise_server_exceptions=False) as client:
            accepted = client.post(
                "/api/auth/invitations/accept",
                json={
                    "token": invitation["token"],
                    "email": "http@example.test",
                    "password": "http-member-password",
                    "name": "HTTP member",
                },
            )
            assert accepted.status_code == 201
            assert accepted.headers["cache-control"] == "no-store"
            before = {
                "accounts": services.database.execute(
                    "SELECT COUNT(*) FROM platform_users"
                ).fetchone()[0],
                "memberships": services.database.execute(
                    "SELECT COUNT(*) FROM workspace_members"
                ).fetchone()[0],
                "sessions": services.database.execute(
                    "SELECT COUNT(*) FROM platform_sessions"
                ).fetchone()[0],
                "acceptedAudits": services.database.execute(
                    "SELECT COUNT(*) FROM audit_events WHERE action = 'workspace.invitation_accepted'"
                ).fetchone()[0],
            }
            for body, headers in (
                ({"token": invitation["token"]}, {}),
                (
                    {
                        "token": invitation["token"],
                        "email": "changed@example.test",
                        "password": "different-password",
                        "name": "Different account",
                    },
                    {"authorization": f"Bearer {super_session['token']}"},
                ),
            ):
                replay = client.post(
                    "/api/auth/invitations/accept",
                    json=body,
                    headers=headers,
                )
                assert replay.status_code == 410
                assert replay.json() == {"error": "INVITE_ALREADY_USED"}
            after = {
                "accounts": services.database.execute(
                    "SELECT COUNT(*) FROM platform_users"
                ).fetchone()[0],
                "memberships": services.database.execute(
                    "SELECT COUNT(*) FROM workspace_members"
                ).fetchone()[0],
                "sessions": services.database.execute(
                    "SELECT COUNT(*) FROM platform_sessions"
                ).fetchone()[0],
                "acceptedAudits": services.database.execute(
                    "SELECT COUNT(*) FROM audit_events WHERE action = 'workspace.invitation_accepted'"
                ).fetchone()[0],
            }
            assert after == before
    finally:
        services.close()


def test_existing_account_acceptance_keeps_password_and_requires_matching_session(tmp_path):
    services = PlatformServices(str(tmp_path))
    try:
        super_admin, _, first_workspace = _bootstrap(services)
        first_invite = services.create_workspace_invitation(
            first_workspace["id"], super_admin.id, "existing@example.test", "member"
        )
        existing, _ = services.accept_workspace_invitation(
            first_invite["token"],
            "existing@example.test",
            "existing-password",
            "Existing user",
        )
        existing_session = services.create_auth_session(existing)
        password_before = services.database.execute(
            "SELECT password_hash FROM platform_user_credentials WHERE user_id = ?",
            (existing.id,),
        ).fetchone()[0]
        second_workspace = services.create_workspace(super_admin, "Second workspace")
        invitation = services.create_workspace_invitation(
            second_workspace["id"], super_admin.id, existing.email, "admin"
        )
        with pytest.raises(PlatformError) as missing_session:
            services.accept_workspace_invitation(
                invitation["token"], existing.email, None, None
            )
        assert missing_session.value.code == "INVITE_LOGIN_REQUIRED"

        accepted, created = services.accept_workspace_invitation(
            invitation["token"], existing.email, None, None, existing
        )
        assert accepted.id == existing.id
        assert created is False
        assert services.database.execute(
            "SELECT password_hash FROM platform_user_credentials WHERE user_id = ?",
            (existing.id,),
        ).fetchone()[0] == password_before
        assert services.member_role(second_workspace["id"], existing.id) == "admin"
        assert services.session_user(
            {"authorization": f"Bearer {existing_session['token']}"}
        ).id == existing.id
    finally:
        services.close()


def test_policy_session_revocation_and_lockout_protection(tmp_path):
    services = PlatformServices(str(tmp_path))
    try:
        super_admin, _, workspace = _bootstrap(services)
        invitation = services.create_workspace_invitation(
            workspace["id"], super_admin.id, "member@example.test", "member"
        )
        member, _ = services.accept_workspace_invitation(
            invitation["token"], "member@example.test", "member-password", "Member"
        )
        session = services.create_auth_session(member)
        assert services.require_workspace_capability(workspace["id"], member.id, "flow.edit") == "member"
        with pytest.raises(PlatformError, match="CAPABILITY_REQUIRED"):
            services.require_workspace_capability(workspace["id"], member.id, "invite.manage")

        services.update_workspace_member_role(workspace["id"], member.id, "admin", super_admin.id)
        with pytest.raises(PlatformError, match="SESSION_INVALID"):
            services.session_user({"authorization": f"Bearer {session['token']}"})

        services.remove_workspace_member(workspace["id"], super_admin.id, super_admin.id)
        with pytest.raises(PlatformError, match="LAST_WORKSPACE_ADMIN_REQUIRED"):
            services.remove_workspace_member(workspace["id"], member.id, super_admin.id)
        with pytest.raises(PlatformError, match="LAST_SUPER_ADMIN_REQUIRED"):
            services.set_account_enabled(super_admin.id, False, super_admin.id)
        assert services.account_for(super_admin.id)["globalRole"] == GLOBAL_ROLE_SUPER_ADMIN
    finally:
        services.close()


def test_handler_requires_super_admin_for_workspace_creation_and_exposes_policy_projection(tmp_path):
    services = PlatformServices(str(tmp_path))
    try:
        super_admin, super_session, workspace = _bootstrap(services)
        invitation = services.create_workspace_invitation(
            workspace["id"], super_admin.id, "member@example.test", "member"
        )
        member, _ = services.accept_workspace_invitation(
            invitation["token"], "member@example.test", "member-password", "Member"
        )
        member_session = services.create_auth_session(member)
        admin_invitation = services.create_workspace_invitation(
            workspace["id"], super_admin.id, "admin@example.test", "admin"
        )
        admin, _ = services.accept_workspace_invitation(
            admin_invitation["token"],
            "admin@example.test",
            "admin-password",
            "Workspace admin",
        )
        admin_session = services.create_auth_session(admin)
        router = create_platform_router(services)
        workspaces = _route(router, "/api/workspaces")
        with pytest.raises(PlatformError, match="SUPER_ADMIN_REQUIRED"):
            _call(workspaces, method="POST", token=member_session["token"], body={"name": "Denied"})
        response = _call(
            workspaces,
            method="POST",
            token=super_session["token"],
            body={"name": "Allowed"},
        )
        assert response.status_code == 201
        session_route = _route(router, "/api/auth/session")
        session_response = _call(session_route, method="GET", token=member_session["token"])
        payload = json.loads(session_response.body)
        assert payload["user"]["globalRole"] is None
        assert payload["workspaces"][0]["role"] == "member"
        assert "flow.edit" in payload["workspaces"][0]["capabilities"]
        assert "invite.manage" not in payload["workspaces"][0]["capabilities"]
        admin_session_response = _call(
            session_route, method="GET", token=admin_session["token"]
        )
        admin_payload = json.loads(admin_session_response.body)
        assert admin_payload["workspaces"][0]["role"] == "admin"
        assert "member.manage" in admin_payload["workspaces"][0]["capabilities"]
        assert "account.manage" not in admin_payload["workspaces"][0]["capabilities"]
        super_session_response = _call(
            session_route, method="GET", token=super_session["token"]
        )
        super_payload = json.loads(super_session_response.body)
        assert "account.manage" in super_payload["workspaces"][0]["capabilities"]
    finally:
        services.close()
