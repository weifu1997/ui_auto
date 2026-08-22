"""Workspace/project resolution, RBAC checks, and documents."""
from __future__ import annotations

import uuid
from typing import Any
from ..core import json, now, parse_json
from ..migrations import migrate_project_document_resources
from ..workspaces import GLOBAL_ROLE_SUPER_ADMIN, WORKSPACE_ROLE_ADMIN, capabilities_for_role, is_super_admin, is_workspace_role, normalize_workspace_role, role_has_capability
from ._shared import (
    AuthUser,
)


class WorkspaceServices:
    """Workspace/project resolution, RBAC checks, and documents."""

    def create_workspace(self, user: AuthUser, name: str) -> dict[str, Any]:
        workspace = {
            "id": str(uuid.uuid4()),
            "name": name.strip()[:120] or "My workspace",
            "createdAt": now(),
        }
        self.database.execute(
            "INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)",
            (workspace["id"], workspace["name"], workspace["createdAt"]),
        )
        self.database.execute(
            """
            INSERT INTO workspace_members (workspace_id, user_id, role)
            VALUES (?, ?, ?)
            """,
            (workspace["id"], user.id, WORKSPACE_ROLE_ADMIN),
        )
        self.audit(
            workspace["id"],
            {"type": "user", "id": user.id},
            "workspace.created",
            {"type": "workspace", "id": workspace["id"]},
            {"name": workspace["name"]},
        )
        return workspace

    def workspaces_for_user(self, user_id: str) -> list[dict[str, Any]]:
        global_role = self.global_role_for_user(user_id)
        if is_super_admin(global_role):
            rows = self.database.execute(
                "SELECT id, name, created_at FROM workspaces ORDER BY created_at ASC"
            ).fetchall()
            return [
                {
                    "id": row[0],
                    "name": row[1],
                    "createdAt": row[2],
                    "role": GLOBAL_ROLE_SUPER_ADMIN,
                    "capabilities": capabilities_for_role(
                        GLOBAL_ROLE_SUPER_ADMIN, global_role
                    ),
                }
                for row in rows
            ]
        rows = self.database.execute(
            """
            SELECT w.id, w.name, w.created_at, m.role
            FROM workspaces w
            JOIN workspace_members m ON m.workspace_id = w.id
            WHERE m.user_id = ?
            ORDER BY w.created_at ASC
            """,
            (user_id,),
        ).fetchall()
        return [
            {
                "id": row[0],
                "name": row[1],
                "createdAt": row[2],
                "role": normalize_workspace_role(row[3]),
                "capabilities": capabilities_for_role(str(row[3]), global_role),
            }
            for row in rows
            if is_workspace_role(normalize_workspace_role(row[3]))
        ]

    def _workspace_exists(self, workspace_id: str) -> None:
        from ..http import PlatformError

        row = self.database.execute(
            "SELECT id FROM workspaces WHERE id = ?", (workspace_id,)
        ).fetchone()
        if not row:
            raise PlatformError(404, "WORKSPACE_NOT_FOUND")

    def member_role(self, workspace_id: str, user_id: str) -> str:
        from ..http import PlatformError

        row = self.database.execute(
            """
            SELECT role FROM workspace_members
            WHERE workspace_id = ? AND user_id = ?
            """,
            (workspace_id, user_id),
        ).fetchone()
        role = normalize_workspace_role(str(row[0])) if row else ""
        if not is_workspace_role(role):
            raise PlatformError(403, "WORKSPACE_ACCESS_DENIED")
        return role

    def effective_workspace_role(self, workspace_id: str, user_id: str) -> str:
        self._workspace_exists(workspace_id)
        global_role = self.global_role_for_user(user_id)
        if is_super_admin(global_role):
            membership = self.database.execute(
                """
                SELECT role FROM workspace_members
                WHERE workspace_id = ? AND user_id = ?
                """,
                (workspace_id, user_id),
            ).fetchone()
            if not membership:
                self.audit(
                    workspace_id,
                    {"type": "user", "id": user_id},
                    "super_admin.workspace_accessed",
                    {"type": "workspace", "id": workspace_id},
                    {},
                )
            return GLOBAL_ROLE_SUPER_ADMIN
        return self.member_role(workspace_id, user_id)

    def require_workspace_role(
        self, workspace_id: str, user_id: str, admin: bool = False
    ) -> str:
        from ..http import PlatformError

        role = self.effective_workspace_role(workspace_id, user_id)
        if admin and not role_has_capability(role, "workspace.manage"):
            raise PlatformError(403, "CAPABILITY_REQUIRED")
        return role

    def require_workspace_capability(
        self, workspace_id: str, user_id: str, capability: str
    ) -> str:
        from ..http import PlatformError

        role = self.effective_workspace_role(workspace_id, user_id)
        if not role_has_capability(role, capability):
            raise PlatformError(403, "CAPABILITY_REQUIRED")
        return role

    def project_for(self, project_id: str) -> dict[str, Any]:
        from ..http import PlatformError

        row = self.database.execute(
            """
            SELECT id, workspace_id, source_project_id, slug, name, description,
                   archived_at, created_at, updated_at
            FROM platform_projects WHERE id = ?
            """,
            (project_id,),
        ).fetchone()
        if not row:
            raise PlatformError(404, "PROJECT_NOT_FOUND")
        return {
            "id": row[0],
            "workspace_id": row[1],
            "source_project_id": row[2],
            "slug": row[3],
            "name": row[4],
            "description": row[5],
            "archived_at": row[6],
            "created_at": row[7],
            "updated_at": row[8],
        }

    def project_response(self, project: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": project["id"],
            "workspaceId": project["workspace_id"],
            "sourceProjectId": project.get("source_project_id") or None,
            "slug": project["slug"],
            "name": project["name"],
            "description": project["description"],
            "archivedAt": project.get("archived_at"),
            "createdAt": project.get("created_at"),
            "updatedAt": project.get("updated_at"),
        }

    def require_project_role(
        self, project_id: str, user_id: str, write: bool = False
    ) -> dict[str, Any]:
        project = self.project_for(project_id)
        if write:
            role = self.require_workspace_capability(
                project["workspace_id"], user_id, "project.manage"
            )
        else:
            role = self.require_workspace_role(project["workspace_id"], user_id)
        return {"project": project, "role": role}

    def require_project_admin(self, project_id: str, user_id: str) -> dict[str, Any]:
        return self.require_project_role(project_id, user_id, True)

    def require_project_capability(
        self, project_id: str, user_id: str, capability: str
    ) -> dict[str, Any]:
        project = self.project_for(project_id)
        role = self.require_workspace_capability(
            project["workspace_id"], user_id, capability
        )
        return {"project": project, "role": role}

    def workspace_members(self, workspace_id: str) -> list[dict[str, Any]]:
        self._workspace_exists(workspace_id)
        rows = self.database.execute(
            """
            SELECT u.id, u.email, u.name, u.enabled, u.global_role, m.role,
                   u.created_at
            FROM workspace_members m
            JOIN platform_users u ON u.id = m.user_id
            WHERE m.workspace_id = ?
            ORDER BY m.role ASC, u.email ASC
            """,
            (workspace_id,),
        ).fetchall()
        return [
            {
                "id": row[0],
                "email": row[1],
                "name": row[2],
                "enabled": bool(row[3]),
                "globalRole": row[4],
                "role": normalize_workspace_role(row[5]),
                "createdAt": row[6],
            }
            for row in rows
            if is_workspace_role(normalize_workspace_role(row[5]))
        ]

    def document_for(self, project_id: str) -> dict[str, Any]:
        row = self.database.execute(
            """
            SELECT data, version, updated_at FROM project_documents
            WHERE project_id = ?
            """,
            (project_id,),
        ).fetchone()
        if row:
            return {
                "data": parse_json(row[0], {}),
                "version": row[1],
                "updatedAt": row[2],
            }
        return {"data": {}, "version": 0, "updatedAt": None}

    def put_document(
        self,
        project_id: str,
        data: dict[str, Any],
        expected_version: int | None = None,
    ) -> dict[str, Any]:
        from ..http import PlatformError

        current = self.document_for(project_id)
        if expected_version is not None and expected_version != current["version"]:
            raise PlatformError(409, "DOCUMENT_VERSION_CONFLICT")
        version = current["version"] + 1
        self.database.execute(
            """
            INSERT INTO project_documents (project_id, data, version, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(project_id) DO UPDATE SET
              data = excluded.data,
              version = excluded.version,
              updated_at = excluded.updated_at
            """,
            (project_id, json(data), version, now()),
        )
        migrate_project_document_resources(self.database, project_id, data)
        return {"version": version, "data": data}
