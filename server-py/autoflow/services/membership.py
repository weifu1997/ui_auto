"""Workspace invitations and member role lifecycle."""
from __future__ import annotations

import uuid
from typing import Any
from ..core import digest, now
from ..workspaces import WORKSPACE_ROLE_ADMIN, is_workspace_role, normalize_workspace_role
from ._shared import (
    AuthUser,
    _iso_add_seconds,
)


class MembershipServices:
    """Workspace invitations and member role lifecycle."""

    def _validate_invitation_email(self, email: str) -> str:
        from ..http import PlatformError

        normalized = email.strip().lower()
        if not normalized or "@" not in normalized or len(normalized) > 320:
            raise PlatformError(400, "INVITE_EMAIL_INVALID")
        return normalized

    def invitation_response(self, row: tuple[Any, ...]) -> dict[str, Any]:
        expires_at = str(row[5])
        state = "active"
        if row[8]:
            state = "consumed"
        elif row[7]:
            state = "revoked"
        elif expires_at <= now():
            state = "expired"
        return {
            "id": row[0],
            "workspaceId": row[1],
            "email": row[2],
            "role": normalize_workspace_role(row[3]),
            "createdBy": row[4],
            "expiresAt": expires_at,
            "createdAt": row[6],
            "revokedAt": row[7],
            "consumedAt": row[8],
            "status": state,
        }

    def workspace_invitations(self, workspace_id: str) -> list[dict[str, Any]]:
        self._workspace_exists(workspace_id)
        rows = self.database.execute(
            """
            SELECT id, workspace_id, email, role, created_by, expires_at,
                   created_at, revoked_at, consumed_at
            FROM workspace_invitations
            WHERE workspace_id = ?
            ORDER BY created_at DESC
            """,
            (workspace_id,),
        ).fetchall()
        return [self.invitation_response(row) for row in rows]

    def create_workspace_invitation(
        self,
        workspace_id: str,
        actor_id: str,
        email: str,
        role: str,
    ) -> dict[str, Any]:
        from ..http import PlatformError
        import secrets

        self._workspace_exists(workspace_id)
        email = self._validate_invitation_email(email)
        if not is_workspace_role(role):
            raise PlatformError(400, "INVITE_ROLE_INVALID")
        token = secrets.token_urlsafe(32)
        invitation = {
            "id": str(uuid.uuid4()),
            "workspaceId": workspace_id,
            "email": email,
            "role": role,
            "tokenHash": digest(token),
            "expiresAt": _iso_add_seconds(24 * 60 * 60),
            "createdAt": now(),
        }
        self.database.execute("BEGIN IMMEDIATE")
        try:
            replaced_at = now()
            replaced = self.database.execute(
                """
                SELECT id FROM workspace_invitations
                WHERE workspace_id = ? AND email = ? AND consumed_at IS NULL
                  AND revoked_at IS NULL AND expires_at > ?
                """,
                (workspace_id, email, replaced_at),
            ).fetchall()
            self.database.execute(
                """
                UPDATE workspace_invitations
                SET revoked_at = ?
                WHERE workspace_id = ? AND email = ? AND consumed_at IS NULL
                  AND revoked_at IS NULL AND expires_at > ?
                """,
                (replaced_at, workspace_id, email, replaced_at),
            )
            for previous in replaced:
                self.audit(
                    workspace_id,
                    {"type": "user", "id": actor_id},
                    "workspace.invitation_revoked",
                    {"type": "invitation", "id": str(previous[0])},
                    {"reason": "replaced"},
                )
            self.database.execute(
                """
                INSERT INTO workspace_invitations (
                  id, workspace_id, email, role, token_hash, expires_at,
                  created_by, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    invitation["id"],
                    workspace_id,
                    email,
                    role,
                    invitation["tokenHash"],
                    invitation["expiresAt"],
                    actor_id,
                    invitation["createdAt"],
                ),
            )
            self.audit(
                workspace_id,
                {"type": "user", "id": actor_id},
                "workspace.invitation_created",
                {"type": "invitation", "id": invitation["id"]},
                {"role": role},
            )
            self.database.execute("COMMIT")
        except Exception:
            self.database.execute("ROLLBACK")
            raise
        return {
            "id": invitation["id"],
            "workspaceId": workspace_id,
            "email": email,
            "role": role,
            "expiresAt": invitation["expiresAt"],
            "token": token,
        }

    def revoke_workspace_invitation(
        self, workspace_id: str, invitation_id: str, actor_id: str
    ) -> None:
        from ..http import PlatformError

        self.database.execute("BEGIN IMMEDIATE")
        try:
            row = self.database.execute(
                """
                SELECT id, consumed_at, revoked_at, expires_at
                FROM workspace_invitations WHERE id = ? AND workspace_id = ?
                """,
                (invitation_id, workspace_id),
            ).fetchone()
            if not row:
                raise PlatformError(404, "INVITE_NOT_FOUND")
            if row[1] or row[2] or str(row[3]) <= now():
                raise PlatformError(409, "INVITE_NOT_REVOCABLE")
            self.database.execute(
                "UPDATE workspace_invitations SET revoked_at = ? WHERE id = ?",
                (now(), invitation_id),
            )
            self.audit(
                workspace_id,
                {"type": "user", "id": actor_id},
                "workspace.invitation_revoked",
                {"type": "invitation", "id": invitation_id},
                {},
            )
            self.database.execute("COMMIT")
        except Exception:
            self.database.execute("ROLLBACK")
            raise

    def accept_workspace_invitation(
        self,
        token: str,
        email: str,
        password: str | None,
        name: str | None,
        current_user: AuthUser | None = None,
    ) -> tuple[AuthUser, bool]:
        from ..auth import password_hash
        from ..http import PlatformError

        if not token or len(token) > 1024:
            raise PlatformError(400, "INVITE_TOKEN_INVALID")
        self.database.execute("BEGIN IMMEDIATE")
        try:
            invite = self.database.execute(
                """
                SELECT id, workspace_id, email, role, expires_at, revoked_at, consumed_at
                FROM workspace_invitations WHERE token_hash = ?
                """,
                (digest(token),),
            ).fetchone()
            if not invite:
                raise PlatformError(404, "INVITE_INVALID")
            # The consumed state deliberately wins before every other check so
            # replays have one terminal, non-enumerating contract.
            if invite[6]:
                raise PlatformError(410, "INVITE_ALREADY_USED")
            if invite[5]:
                raise PlatformError(410, "INVITE_REVOKED")
            if str(invite[4]) <= now():
                raise PlatformError(410, "INVITE_EXPIRED")
            # Do not validate caller-controlled fields before the consumed
            # check above. A replay must preserve its single terminal result
            # even when the caller changes or omits every other field.
            email = self._validate_invitation_email(email)
            if email != invite[2]:
                raise PlatformError(403, "INVITE_EMAIL_MISMATCH")
            role = normalize_workspace_role(invite[3])
            if not is_workspace_role(role):
                raise PlatformError(409, "INVITE_ROLE_INVALID")

            existing = self.database.execute(
                """
                SELECT id, email, name, enabled, global_role
                FROM platform_users WHERE email = ?
                """,
                (email,),
            ).fetchone()
            created = False
            if existing:
                # A disabled target cannot authenticate, so checking for its
                # matching session first would make the stable disabled-account
                # terminal response unreachable through the HTTP endpoint.
                if not bool(existing[3]):
                    raise PlatformError(403, "INVITE_ACCOUNT_DISABLED")
                if not current_user or current_user.id != existing[0]:
                    raise PlatformError(409, "INVITE_LOGIN_REQUIRED")
                user = AuthUser(existing[0], existing[1], existing[2], existing[4])
            else:
                if current_user:
                    raise PlatformError(403, "INVITE_EMAIL_MISMATCH")
                if not password or len(password) < 8 or len(password) > 1024:
                    raise PlatformError(400, "INVITE_PASSWORD_INVALID")
                created = True
                user = AuthUser(
                    str(uuid.uuid4()),
                    email,
                    (name or "").strip()[:100] or email.split("@", 1)[0],
                )
                created_at = now()
                self.database.execute(
                    """
                    INSERT INTO platform_users (id, email, name, created_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (user.id, user.email, user.name, created_at),
                )
                self.database.execute(
                    """
                    INSERT INTO platform_user_credentials
                      (user_id, password_hash, created_at, updated_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (user.id, password_hash(password), created_at, created_at),
                )

            membership = self.database.execute(
                """
                SELECT 1 FROM workspace_members
                WHERE workspace_id = ? AND user_id = ?
                """,
                (invite[1], user.id),
            ).fetchone()
            if membership:
                raise PlatformError(409, "INVITE_MEMBERSHIP_EXISTS")
            self.database.execute(
                """
                INSERT INTO workspace_members (workspace_id, user_id, role)
                VALUES (?, ?, ?)
                """,
                (invite[1], user.id, role),
            )
            cursor = self.database.execute(
                """
                UPDATE workspace_invitations SET consumed_at = ?
                WHERE id = ? AND consumed_at IS NULL
                """,
                (now(), invite[0]),
            )
            if cursor.rowcount != 1:
                raise PlatformError(410, "INVITE_ALREADY_USED")
            self.audit(
                invite[1],
                {"type": "user", "id": user.id},
                "workspace.invitation_accepted",
                {"type": "invitation", "id": invite[0]},
                {"role": role, "newAccount": created},
            )
            self.database.execute("COMMIT")
            return user, created
        except Exception:
            self.database.execute("ROLLBACK")
            raise

    def update_workspace_member_role(
        self, workspace_id: str, user_id: str, role: str, actor_id: str
    ) -> dict[str, Any]:
        from ..http import PlatformError

        if not is_workspace_role(role):
            raise PlatformError(400, "WORKSPACE_ROLE_INVALID")
        self.database.execute("BEGIN IMMEDIATE")
        try:
            current = self.database.execute(
                """
                SELECT role FROM workspace_members
                WHERE workspace_id = ? AND user_id = ?
                """,
                (workspace_id, user_id),
            ).fetchone()
            if not current:
                raise PlatformError(404, "WORKSPACE_MEMBER_NOT_FOUND")
            current_role = normalize_workspace_role(current[0])
            if current_role == role:
                self.database.execute("COMMIT")
                return next(
                    item
                    for item in self.workspace_members(workspace_id)
                    if item["id"] == user_id
                )
            if current_role == WORKSPACE_ROLE_ADMIN and role != WORKSPACE_ROLE_ADMIN:
                self._assert_not_last_workspace_admin(workspace_id, user_id)
            self.database.execute(
                """
                UPDATE workspace_members SET role = ?
                WHERE workspace_id = ? AND user_id = ?
                """,
                (role, workspace_id, user_id),
            )
            revoked = self.revoke_user_sessions(user_id)
            self.audit(
                workspace_id,
                {"type": "user", "id": actor_id},
                "workspace.member_role_changed",
                {"type": "user", "id": user_id},
                {"role": role, "revokedSessions": revoked},
            )
            result = self.account_for(user_id)
            self.database.execute("COMMIT")
            return {**result, "role": role}
        except Exception:
            self.database.execute("ROLLBACK")
            raise

    def remove_workspace_member(
        self, workspace_id: str, user_id: str, actor_id: str
    ) -> None:
        from ..http import PlatformError

        self.database.execute("BEGIN IMMEDIATE")
        try:
            membership = self.database.execute(
                """
                SELECT 1 FROM workspace_members
                WHERE workspace_id = ? AND user_id = ?
                """,
                (workspace_id, user_id),
            ).fetchone()
            if not membership:
                raise PlatformError(404, "WORKSPACE_MEMBER_NOT_FOUND")
            self._assert_not_last_workspace_admin(workspace_id, user_id)
            self.database.execute(
                "DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?",
                (workspace_id, user_id),
            )
            revoked = self.revoke_user_sessions(user_id)
            self.audit(
                workspace_id,
                {"type": "user", "id": actor_id},
                "workspace.member_removed",
                {"type": "user", "id": user_id},
                {"revokedSessions": revoked},
            )
            self.database.execute("COMMIT")
        except Exception:
            self.database.execute("ROLLBACK")
            raise
