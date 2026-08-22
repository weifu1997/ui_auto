"""Accounts, sessions, passwords, and super-admin bootstrap."""
from __future__ import annotations

import uuid
from typing import Any
from ..core import digest, now
from ..workspaces import GLOBAL_ROLE_SUPER_ADMIN, WORKSPACE_ROLE_ADMIN, is_super_admin, normalize_workspace_role
from ._shared import (
    AuthUser,
    _iso_add_seconds,
)


class IdentityServices:
    """Accounts, sessions, passwords, and super-admin bootstrap."""

    def create_auth_session(self, user: AuthUser) -> dict[str, Any]:
        import secrets

        token = secrets.token_urlsafe(32)
        expires_at = _iso_add_seconds(12 * 60 * 60)
        self.database.execute(
            """
            INSERT INTO platform_sessions (token_hash, user_id, expires_at, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (digest(token), user.id, expires_at, now()),
        )
        return {
            "token": token,
            "expiresAt": expires_at,
            "user": {
                "id": user.id,
                "email": user.email,
                "name": user.name,
                "globalRole": user.global_role,
            },
        }

    def session_user(self, headers: dict[str, str] | None = None) -> AuthUser:
        from ..core import authorization
        from ..http import PlatformError

        token = authorization(headers)
        if not token:
            raise PlatformError(401, "AUTH_REQUIRED")
        row = self.database.execute(
            """
            SELECT u.id, u.email, u.name, u.global_role
            FROM platform_sessions s
            JOIN platform_users u ON u.id = s.user_id
            WHERE s.token_hash = ? AND s.expires_at > ? AND u.enabled = 1
            """,
            (digest(token), now()),
        ).fetchone()
        if not row:
            raise PlatformError(401, "SESSION_INVALID")
        return AuthUser(row[0], row[1], row[2], row[3])

    def global_role_for_user(self, user_id: str) -> str | None:
        row = self.database.execute(
            "SELECT global_role FROM platform_users WHERE id = ? AND enabled = 1",
            (user_id,),
        ).fetchone()
        return str(row[0]) if row and row[0] else None

    def require_super_admin(self, user_id: str) -> None:
        from ..http import PlatformError

        if not is_super_admin(self.global_role_for_user(user_id)):
            raise PlatformError(403, "SUPER_ADMIN_REQUIRED")

    def revoke_user_sessions(self, user_id: str) -> int:
        cursor = self.database.execute(
            "DELETE FROM platform_sessions WHERE user_id = ?", (user_id,)
        )
        return max(0, cursor.rowcount)

    def account_for(self, user_id: str) -> dict[str, Any]:
        from ..http import PlatformError

        row = self.database.execute(
            """
            SELECT id, email, name, enabled, global_role, created_at
            FROM platform_users WHERE id = ?
            """,
            (user_id,),
        ).fetchone()
        if not row:
            raise PlatformError(404, "ACCOUNT_NOT_FOUND")
        return {
            "id": row[0],
            "email": row[1],
            "name": row[2],
            "enabled": bool(row[3]),
            "globalRole": row[4],
            "createdAt": row[5],
        }

    def accounts(self) -> list[dict[str, Any]]:
        rows = self.database.execute(
            """
            SELECT id, email, name, enabled, global_role, created_at
            FROM platform_users ORDER BY created_at ASC, email ASC
            """
        ).fetchall()
        return [
            {
                "id": row[0],
                "email": row[1],
                "name": row[2],
                "enabled": bool(row[3]),
                "globalRole": row[4],
                "createdAt": row[5],
            }
            for row in rows
        ]

    def _workspace_ids_for_user(self, user_id: str) -> list[str]:
        return [
            str(row[0])
            for row in self.database.execute(
                "SELECT workspace_id FROM workspace_members WHERE user_id = ?",
                (user_id,),
            ).fetchall()
        ]

    def _audit_account_change(
        self,
        actor_id: str,
        action: str,
        target_user_id: str,
        detail: dict[str, Any],
        workspace_ids: list[str] | None = None,
    ) -> None:
        targets = workspace_ids or self._workspace_ids_for_user(target_user_id)
        if not targets:
            targets = self._workspace_ids_for_user(actor_id)
        if not targets:
            first_workspace = self.database.execute(
                "SELECT id FROM workspaces ORDER BY created_at ASC LIMIT 1"
            ).fetchone()
            targets = [str(first_workspace[0])] if first_workspace else []
        for workspace_id in dict.fromkeys(targets):
            self.audit(
                workspace_id,
                {"type": "user", "id": actor_id},
                action,
                {"type": "user", "id": target_user_id},
                detail,
            )

    def _assert_not_last_workspace_admin(
        self, workspace_id: str, user_id: str
    ) -> None:
        from ..http import PlatformError

        membership = self.database.execute(
            """
            SELECT m.role, u.enabled
            FROM workspace_members m
            JOIN platform_users u ON u.id = m.user_id
            WHERE m.workspace_id = ? AND m.user_id = ?
            """,
            (workspace_id, user_id),
        ).fetchone()
        if not membership or normalize_workspace_role(membership[0]) != WORKSPACE_ROLE_ADMIN:
            return
        if not bool(membership[1]):
            return
        count = self.database.execute(
            """
            SELECT COUNT(*)
            FROM workspace_members m
            JOIN platform_users u ON u.id = m.user_id
            WHERE m.workspace_id = ? AND m.role = ? AND u.enabled = 1
            """,
            (workspace_id, WORKSPACE_ROLE_ADMIN),
        ).fetchone()[0]
        if count <= 1:
            raise PlatformError(409, "LAST_WORKSPACE_ADMIN_REQUIRED")

    def _assert_not_last_super_admin(self, user_id: str) -> None:
        from ..http import PlatformError

        row = self.database.execute(
            "SELECT global_role, enabled FROM platform_users WHERE id = ?",
            (user_id,),
        ).fetchone()
        if not row or not is_super_admin(row[0]) or not bool(row[1]):
            return
        count = self.database.execute(
            """
            SELECT COUNT(*) FROM platform_users
            WHERE global_role = ? AND enabled = 1
            """,
            (GLOBAL_ROLE_SUPER_ADMIN,),
        ).fetchone()[0]
        if count <= 1:
            raise PlatformError(409, "LAST_SUPER_ADMIN_REQUIRED")

    def set_account_enabled(
        self, user_id: str, enabled: bool, actor_id: str
    ) -> dict[str, Any]:
        self.database.execute("BEGIN IMMEDIATE")
        try:
            account = self.account_for(user_id)
            if account["enabled"] == enabled:
                self.database.execute("COMMIT")
                return account
            if not enabled:
                self._assert_not_last_super_admin(user_id)
                for workspace_id in self._workspace_ids_for_user(user_id):
                    self._assert_not_last_workspace_admin(workspace_id, user_id)
            self.database.execute(
                "UPDATE platform_users SET enabled = ? WHERE id = ?",
                (1 if enabled else 0, user_id),
            )
            revoked = self.revoke_user_sessions(user_id)
            self._audit_account_change(
                actor_id,
                "account.enabled_changed",
                user_id,
                {"enabled": enabled, "revokedSessions": revoked},
            )
            result = self.account_for(user_id)
            self.database.execute("COMMIT")
            return result
        except Exception:
            self.database.execute("ROLLBACK")
            raise

    def set_account_global_role(
        self, user_id: str, global_role: str | None, actor_id: str
    ) -> dict[str, Any]:
        from ..http import PlatformError

        if global_role not in (None, GLOBAL_ROLE_SUPER_ADMIN):
            raise PlatformError(400, "GLOBAL_ROLE_INVALID")
        self.database.execute("BEGIN IMMEDIATE")
        try:
            account = self.account_for(user_id)
            if account["globalRole"] == global_role:
                self.database.execute("COMMIT")
                return account
            if global_role == GLOBAL_ROLE_SUPER_ADMIN and not account["enabled"]:
                raise PlatformError(409, "ACCOUNT_DISABLED")
            if account["globalRole"] == GLOBAL_ROLE_SUPER_ADMIN:
                self._assert_not_last_super_admin(user_id)
            self.database.execute(
                "UPDATE platform_users SET global_role = ? WHERE id = ?",
                (global_role, user_id),
            )
            revoked = self.revoke_user_sessions(user_id)
            self._audit_account_change(
                actor_id,
                "account.global_role_changed",
                user_id,
                {"globalRole": global_role, "revokedSessions": revoked},
            )
            result = self.account_for(user_id)
            self.database.execute("COMMIT")
            return result
        except Exception:
            self.database.execute("ROLLBACK")
            raise

    def issue_password_reset(self, user_id: str, actor_id: str) -> dict[str, Any]:
        import secrets

        self.database.execute("BEGIN IMMEDIATE")
        try:
            self.account_for(user_id)
            token = secrets.token_urlsafe(32)
            reset = {
                "id": str(uuid.uuid4()),
                "tokenHash": digest(token),
                "expiresAt": _iso_add_seconds(24 * 60 * 60),
                "createdAt": now(),
            }
            self.database.execute(
                """
                UPDATE password_reset_tokens SET revoked_at = ?
                WHERE user_id = ? AND consumed_at IS NULL AND revoked_at IS NULL
                  AND expires_at > ?
                """,
                (now(), user_id, now()),
            )
            self.database.execute(
                """
                INSERT INTO password_reset_tokens (
                  id, user_id, token_hash, expires_at, created_by, created_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    reset["id"],
                    user_id,
                    reset["tokenHash"],
                    reset["expiresAt"],
                    actor_id,
                    reset["createdAt"],
                ),
            )
            self._audit_account_change(
                actor_id,
                "account.password_reset_issued",
                user_id,
                {},
            )
            self.database.execute("COMMIT")
            return {"id": reset["id"], "token": token, "expiresAt": reset["expiresAt"]}
        except Exception:
            self.database.execute("ROLLBACK")
            raise

    def accept_password_reset(self, token: str, password: str) -> None:
        from ..auth import password_hash
        from ..http import PlatformError

        if not token or len(token) > 1024:
            raise PlatformError(400, "PASSWORD_RESET_TOKEN_INVALID")
        self.database.execute("BEGIN IMMEDIATE")
        try:
            reset = self.database.execute(
                """
                SELECT id, user_id, expires_at, revoked_at, consumed_at
                FROM password_reset_tokens WHERE token_hash = ?
                """,
                (digest(token),),
            ).fetchone()
            if not reset:
                raise PlatformError(404, "PASSWORD_RESET_INVALID")
            if reset[4]:
                raise PlatformError(410, "PASSWORD_RESET_ALREADY_USED")
            if reset[3]:
                raise PlatformError(410, "PASSWORD_RESET_REVOKED")
            if str(reset[2]) <= now():
                raise PlatformError(410, "PASSWORD_RESET_EXPIRED")
            if not password or len(password) < 8 or len(password) > 1024:
                raise PlatformError(400, "PASSWORD_RESET_PASSWORD_INVALID")
            account = self.account_for(reset[1])
            if not account["enabled"]:
                raise PlatformError(403, "ACCOUNT_DISABLED")
            changed_at = now()
            self.database.execute(
                """
                UPDATE platform_user_credentials
                SET password_hash = ?, updated_at = ? WHERE user_id = ?
                """,
                (password_hash(password), changed_at, reset[1]),
            )
            self.database.execute(
                "UPDATE password_reset_tokens SET consumed_at = ? WHERE id = ?",
                (changed_at, reset[0]),
            )
            revoked = self.revoke_user_sessions(reset[1])
            self._audit_account_change(
                reset[1],
                "account.password_reset_accepted",
                reset[1],
                {"revokedSessions": revoked},
            )
            self.database.execute("COMMIT")
        except Exception:
            self.database.execute("ROLLBACK")
            raise

    def bootstrap_super_admin(
        self, email: str, name: str | None, password: str | None
    ) -> AuthUser:
        from ..auth import password_hash
        from ..http import PlatformError

        email = self._validate_invitation_email(email)
        self.database.execute("BEGIN IMMEDIATE")
        try:
            existing_admin = self.database.execute(
                """
                SELECT id FROM platform_users
                WHERE global_role = ? AND enabled = 1
                """,
                (GLOBAL_ROLE_SUPER_ADMIN,),
            ).fetchone()
            if existing_admin:
                raise PlatformError(409, "SUPER_ADMIN_ALREADY_CONFIGURED")
            existing = self.database.execute(
                """
                SELECT id, email, name, global_role FROM platform_users
                WHERE email = ?
                """,
                (email,),
            ).fetchone()
            created = False
            if existing:
                credential = self.database.execute(
                    "SELECT 1 FROM platform_user_credentials WHERE user_id = ?",
                    (existing[0],),
                ).fetchone()
                if not credential:
                    if not password or len(password) < 8 or len(password) > 1024:
                        raise PlatformError(400, "BOOTSTRAP_PASSWORD_INVALID")
                    created_at = now()
                    self.database.execute(
                        """
                        INSERT INTO platform_user_credentials
                          (user_id, password_hash, created_at, updated_at)
                        VALUES (?, ?, ?, ?)
                        """,
                        (existing[0], password_hash(password), created_at, created_at),
                    )
                self.database.execute(
                    """
                    UPDATE platform_users
                    SET enabled = 1, global_role = ? WHERE id = ?
                    """,
                    (GLOBAL_ROLE_SUPER_ADMIN, existing[0]),
                )
                user = AuthUser(existing[0], existing[1], existing[2], GLOBAL_ROLE_SUPER_ADMIN)
            else:
                if not password or len(password) < 8 or len(password) > 1024:
                    raise PlatformError(400, "BOOTSTRAP_PASSWORD_INVALID")
                user = AuthUser(
                    str(uuid.uuid4()),
                    email,
                    (name or "").strip()[:100] or email.split("@", 1)[0],
                    GLOBAL_ROLE_SUPER_ADMIN,
                )
                created = True
                created_at = now()
                self.database.execute(
                    """
                    INSERT INTO platform_users (id, email, name, global_role, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (user.id, user.email, user.name, user.global_role, created_at),
                )
                self.database.execute(
                    """
                    INSERT INTO platform_user_credentials
                      (user_id, password_hash, created_at, updated_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (user.id, password_hash(password), created_at, created_at),
                )
            revoked_sessions = self.revoke_user_sessions(user.id)
            self.deployment_audit(
                {"type": "system", "id": "bootstrap"},
                "account.super_admin_bootstrapped",
                {"type": "user", "id": user.id},
                {
                    "created": created,
                    "promoted": not created,
                    "revokedSessions": revoked_sessions,
                },
            )
            self.database.execute("COMMIT")
            return user
        except Exception:
            self.database.execute("ROLLBACK")
            raise
