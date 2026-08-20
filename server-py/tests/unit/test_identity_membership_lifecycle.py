"""HTTP and lifecycle coverage for the Phase 1 local-account boundary."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from autoflow.auth import password_matches
from autoflow.http import PlatformError
from autoflow.main import create_app
from autoflow.services import AuthUser, PlatformServices
from autoflow.workspaces import GLOBAL_ROLE_SUPER_ADMIN


def _authorization(token: str) -> dict[str, str]:
    return {"authorization": f"Bearer {token}"}


def _bootstrap(services: PlatformServices) -> tuple[AuthUser, str, dict[str, str]]:
    super_admin = services.bootstrap_super_admin(
        "super@example.test", "Super Admin", "bootstrap-password"
    )
    workspace = services.create_workspace(super_admin, "Primary workspace")
    return super_admin, services.create_auth_session(super_admin)["token"], workspace


def _accept_new_member(
    services: PlatformServices,
    workspace_id: str,
    actor_id: str,
    email: str,
    role: str = "member",
) -> AuthUser:
    invitation = services.create_workspace_invitation(
        workspace_id, actor_id, email, role
    )
    user, created = services.accept_workspace_invitation(
        invitation["token"], email, "member-password", "Member"
    )
    assert created is True
    return user


def test_http_role_matrix_keeps_member_edits_and_blocks_administration(tmp_path):
    services = PlatformServices(str(tmp_path))
    super_admin, super_token, workspace = _bootstrap(services)
    member = _accept_new_member(
        services, workspace["id"], super_admin.id, "member@example.test"
    )
    member_token = services.create_auth_session(member)["token"]
    admin = _accept_new_member(
        services, workspace["id"], super_admin.id, "admin@example.test", "admin"
    )
    admin_token = services.create_auth_session(admin)["token"]
    other_workspace = services.create_workspace(super_admin, "Other workspace")

    # Test the public API boundary, not just hidden UI controls. The TestClient
    # context also exercises the real FastAPI lifespan used in production.
    with TestClient(create_app(services), raise_server_exceptions=False) as client:
        project_response = client.post(
            f"/api/workspaces/{workspace['id']}/projects",
            headers=_authorization(super_token),
            json={"name": "Role matrix project"},
        )
        assert project_response.status_code == 201
        project_id = project_response.json()["project"]["id"]

        members = client.get(
            f"/api/workspaces/{workspace['id']}/members",
            headers=_authorization(member_token),
        )
        assert members.status_code == 403
        assert members.json() == {"error": "CAPABILITY_REQUIRED"}

        invitation = client.post(
            f"/api/workspaces/{workspace['id']}/invitations",
            headers=_authorization(member_token),
            json={"email": "denied@example.test", "role": "member"},
        )
        assert invitation.status_code == 403
        assert invitation.json() == {"error": "CAPABILITY_REQUIRED"}

        workspace_create = client.post(
            "/api/workspaces",
            headers=_authorization(member_token),
            json={"name": "Denied workspace"},
        )
        assert workspace_create.status_code == 403
        assert workspace_create.json() == {"error": "SUPER_ADMIN_REQUIRED"}

        project_create = client.post(
            f"/api/workspaces/{workspace['id']}/projects",
            headers=_authorization(member_token),
            json={"name": "Denied project"},
        )
        assert project_create.status_code == 403
        assert project_create.json() == {"error": "CAPABILITY_REQUIRED"}

        flow_create = client.post(
            f"/api/platform/projects/{project_id}/resources/flows",
            headers=_authorization(member_token),
            json={"id": "member-flow", "data": {"name": "Member flow"}},
        )
        assert flow_create.status_code == 201
        assert flow_create.json()["resource"]["updatedBy"] == member.id

        secret_create = client.post(
            f"/api/platform/projects/{project_id}/secrets",
            headers=_authorization(member_token),
            json={"name": "not-allowed", "value": "not-a-real-secret"},
        )
        assert secret_create.status_code == 403
        assert secret_create.json() == {"error": "CAPABILITY_REQUIRED"}

        # A member can take a run action. The missing run is intentionally a
        # 404 rather than a capability failure, proving the permission check
        # has admitted the request before run lookup.
        retry = client.post(
            f"/api/platform/projects/{project_id}/runs/missing-run/retry",
            headers=_authorization(member_token),
        )
        assert retry.status_code == 404
        assert retry.json() == {"error": "RUN_NOT_FOUND"}

        admin_members = client.get(
            f"/api/workspaces/{workspace['id']}/members",
            headers=_authorization(admin_token),
        )
        assert admin_members.status_code == 200
        assert {item["id"] for item in admin_members.json()["members"]} >= {
            super_admin.id,
            member.id,
            admin.id,
        }

        cross_workspace = client.get(
            f"/api/workspaces/{other_workspace['id']}/projects",
            headers=_authorization(member_token),
        )
        assert cross_workspace.status_code == 403
        assert cross_workspace.json() == {"error": "WORKSPACE_ACCESS_DENIED"}


def test_invitation_revoke_expiry_and_password_reset_revoke_sessions(tmp_path):
    services = PlatformServices(str(tmp_path))
    try:
        super_admin, _, workspace = _bootstrap(services)
        revoked = services.create_workspace_invitation(
            workspace["id"], super_admin.id, "revoked@example.test", "member"
        )
        services.revoke_workspace_invitation(
            workspace["id"], revoked["id"], super_admin.id
        )
        with pytest.raises(PlatformError) as revoked_error:
            services.accept_workspace_invitation(
                revoked["token"], "revoked@example.test", "member-password", "Revoked"
            )
        assert (revoked_error.value.status, revoked_error.value.code) == (
            410,
            "INVITE_REVOKED",
        )

        expired = services.create_workspace_invitation(
            workspace["id"], super_admin.id, "expired@example.test", "member"
        )
        services.database.execute(
            "UPDATE workspace_invitations SET expires_at = ? WHERE id = ?",
            ("2000-01-01T00:00:00.000Z", expired["id"]),
        )
        assert next(
            item
            for item in services.workspace_invitations(workspace["id"])
            if item["id"] == expired["id"]
        )["status"] == "expired"
        with pytest.raises(PlatformError) as expired_error:
            services.accept_workspace_invitation(
                expired["token"], "expired@example.test", "member-password", "Expired"
            )
        assert (expired_error.value.status, expired_error.value.code) == (
            410,
            "INVITE_EXPIRED",
        )

        member = _accept_new_member(
            services, workspace["id"], super_admin.id, "reset@example.test"
        )
        old_session = services.create_auth_session(member)["token"]
        reset = services.issue_password_reset(member.id, super_admin.id)
        stored_digest = services.database.execute(
            "SELECT token_hash FROM password_reset_tokens WHERE id = ?", (reset["id"],)
        ).fetchone()[0]
        assert stored_digest != reset["token"]
        assert reset["token"] not in stored_digest

        services.accept_password_reset(reset["token"], "replacement-password")
        with pytest.raises(PlatformError) as old_session_error:
            services.session_user(_authorization(old_session))
        assert old_session_error.value.code == "SESSION_INVALID"
        password_hash = services.database.execute(
            "SELECT password_hash FROM platform_user_credentials WHERE user_id = ?",
            (member.id,),
        ).fetchone()[0]
        assert password_matches("replacement-password", password_hash)
        with pytest.raises(PlatformError) as reset_replay:
            services.accept_password_reset(reset["token"], "another-password")
        assert (reset_replay.value.status, reset_replay.value.code) == (
            410,
            "PASSWORD_RESET_ALREADY_USED",
        )
        # Terminal token state wins even if a replay changes the password
        # input, just as it does for invitation replays.
        with pytest.raises(PlatformError) as malformed_reset_replay:
            services.accept_password_reset(reset["token"], "")
        assert (
            malformed_reset_replay.value.status,
            malformed_reset_replay.value.code,
        ) == (410, "PASSWORD_RESET_ALREADY_USED")

        audit_details = [
            json.loads(row[0])
            for row in services.database.execute(
                "SELECT detail FROM audit_events WHERE action LIKE 'account.password_reset_%'"
            ).fetchall()
        ]
        assert audit_details
        serialized = json.dumps(audit_details)
        for sensitive in (reset["token"], "replacement-password", member.email):
            assert sensitive not in serialized
    finally:
        services.close()


def test_membership_removal_and_account_disable_revoke_sessions_without_cross_workspace_loss(
    tmp_path,
):
    services = PlatformServices(str(tmp_path))
    try:
        super_admin, _, first_workspace = _bootstrap(services)
        member = _accept_new_member(
            services, first_workspace["id"], super_admin.id, "member@example.test"
        )
        second_workspace = services.create_workspace(super_admin, "Second workspace")
        second_invitation = services.create_workspace_invitation(
            second_workspace["id"], super_admin.id, member.email, "member"
        )
        accepted, created = services.accept_workspace_invitation(
            second_invitation["token"], member.email, None, None, member
        )
        assert accepted.id == member.id
        assert created is False

        removed_session = services.create_auth_session(member)["token"]
        services.remove_workspace_member(first_workspace["id"], member.id, super_admin.id)
        with pytest.raises(PlatformError, match="SESSION_INVALID"):
            services.session_user(_authorization(removed_session))
        assert services.member_role(second_workspace["id"], member.id) == "member"
        assert services.database.execute(
            "SELECT COUNT(*) FROM audit_events WHERE action = 'workspace.member_removed'"
        ).fetchone() == (1,)

        active_session = services.create_auth_session(member)["token"]
        services.set_account_enabled(member.id, False, super_admin.id)
        with pytest.raises(PlatformError, match="SESSION_INVALID"):
            services.session_user(_authorization(active_session))
        assert services.member_role(second_workspace["id"], member.id) == "member"
        services.set_account_enabled(member.id, True, super_admin.id)
    finally:
        services.close()


def test_disabled_invited_account_has_a_stable_http_error_and_login_is_not_cached(
    tmp_path,
):
    services = PlatformServices(str(tmp_path))
    try:
        super_admin, _, first_workspace = _bootstrap(services)
        member = _accept_new_member(
            services, first_workspace["id"], super_admin.id, "disabled@example.test"
        )
        second_workspace = services.create_workspace(super_admin, "Second workspace")
        invitation = services.create_workspace_invitation(
            second_workspace["id"], super_admin.id, member.email, "member"
        )
        services.set_account_enabled(member.id, False, super_admin.id)

        with TestClient(create_app(services), raise_server_exceptions=False) as client:
            login = client.post(
                "/api/auth/login",
                json={"email": super_admin.email, "password": "bootstrap-password"},
            )
            assert login.status_code == 200
            assert login.headers["cache-control"] == "no-store"

            response = client.post(
                "/api/auth/invitations/accept",
                json={"token": invitation["token"], "email": member.email},
            )
            assert response.status_code == 403
            assert response.json() == {"error": "INVITE_ACCOUNT_DISABLED"}
    finally:
        services.close()


def test_first_super_admin_bootstrap_cli_reads_password_from_stdin(tmp_path):
    data_directory = tmp_path / "platform-data"
    server_root = Path(__file__).resolve().parents[2]
    command = [
        sys.executable,
        "-m",
        "autoflow.bootstrap_super_admin",
        "--email",
        "operator@example.test",
        "--data-directory",
        str(data_directory),
        "--password-stdin",
    ]
    first = subprocess.run(
        command,
        cwd=server_root,
        input="stdin-only-password\n",
        text=True,
        capture_output=True,
        check=False,
    )
    assert first.returncode == 0
    assert "stdin-only-password" not in first.stdout
    assert "stdin-only-password" not in first.stderr

    services = PlatformServices(str(data_directory))
    try:
        account = services.account_for(
            services.database.execute(
                "SELECT id FROM platform_users WHERE email = ?", ("operator@example.test",)
            ).fetchone()[0]
        )
        assert account["globalRole"] == GLOBAL_ROLE_SUPER_ADMIN
        assert account["enabled"] is True
    finally:
        services.close()

    second = subprocess.run(
        command,
        cwd=server_root,
        input="another-stdin-password\n",
        text=True,
        capture_output=True,
        check=False,
    )
    assert second.returncode == 2
    assert second.stderr.strip() == "SUPER_ADMIN_ALREADY_CONFIGURED"
