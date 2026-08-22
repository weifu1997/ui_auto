"""Workspace and project creation routes, including local-storage import."""
from __future__ import annotations

import sqlite3
import uuid
from fastapi import APIRouter, Request, Response
from ..core import clean_project_slug, json, now, parse_json
from ..http import PlatformError
from ..resources import as_record
from ..services import PlatformServices
from ._shared import (
    _send,
    _text,
)


def register(router: APIRouter, services: PlatformServices) -> None:

    @router.api_route("/api/workspaces", methods=["GET", "POST"])
    async def workspaces(request: Request) -> Response:
        user = services.session_user(dict(request.headers))
        if request.method == "GET":
            return _send(
                Response(),
                200,
                {"workspaces": services.workspaces_for_user(user.id)},
            )
        body = await request.json()
        if not isinstance(body, dict) or not _text(body.get("name")).strip():
            raise PlatformError(400, "WORKSPACE_NAME_REQUIRED")
        services.require_super_admin(user.id)
        return _send(
            Response(),
            201,
            {"workspace": services.create_workspace(user, _text(body.get("name")))},
        )

    @router.api_route("/api/workspaces/{workspace_id}/projects", methods=["GET", "POST"])
    async def workspace_projects(request: Request, workspace_id: str) -> Response:
        user = services.session_user(dict(request.headers))
        if request.method == "GET":
            services.require_workspace_role(workspace_id, user.id)
            archived_only = request.query_params.get("archived") == "1"
            query = """
                SELECT id, workspace_id, source_project_id, slug, name, description,
                       archived_at, created_at, updated_at
                FROM platform_projects
                WHERE workspace_id = ?
            """
            if archived_only:
                query += " AND archived_at IS NOT NULL"
            else:
                query += " AND archived_at IS NULL"
            query += " ORDER BY updated_at DESC"
            rows = services.database.execute(query, (workspace_id,)).fetchall()
            projects = [
                services.project_response(
                    {
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
                )
                for row in rows
            ]
            return _send(Response(), 200, {"projects": projects})

        services.require_workspace_capability(workspace_id, user.id, "project.manage")
        body = await request.json()
        if not isinstance(body, dict) or not _text(body.get("name")).strip():
            raise PlatformError(400, "PROJECT_NAME_REQUIRED")
        project = {
            "id": str(uuid.uuid4()),
            "workspace_id": workspace_id,
            "slug": clean_project_slug(
                _text(body.get("slug") or body.get("name"))
            ),
            "name": _text(body.get("name")).strip()[:160],
            "description": _text(body.get("description")).strip()[:1000],
            "created_at": now(),
        }
        try:
            services.database.execute(
                """
                INSERT INTO platform_projects (
                  id, workspace_id, slug, name, description, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    project["id"],
                    project["workspace_id"],
                    project["slug"],
                    project["name"],
                    project["description"],
                    project["created_at"],
                    project["created_at"],
                ),
            )
        except sqlite3.IntegrityError:
            raise PlatformError(409, "PROJECT_SLUG_EXISTS")
        services.put_document(project["id"], {})
        services.audit(
            workspace_id,
            {"type": "user", "id": user.id},
            "project.created",
            {"type": "project", "id": project["id"]},
            {"name": project["name"]},
            project["id"],
        )
        return _send(Response(), 201, {"project": services.project_response(project)})

    @router.api_route(
        "/api/workspaces/{workspace_id}/imports/local-storage", methods=["POST"]
    )
    async def local_storage_import(
        request: Request, workspace_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        services.require_workspace_role(workspace_id, user.id, True)
        body = await request.json()
        if not isinstance(body, dict):
            body = {}
        source_id = _text(body.get("sourceId")).strip()
        if not source_id:
            raise PlatformError(400, "IMPORT_SOURCE_ID_REQUIRED")
        existing = services.database.execute(
            """
            SELECT result FROM platform_imports
            WHERE workspace_id = ? AND source_id = ?
            """,
            (workspace_id, source_id),
        ).fetchone()
        existing_projects = parse_json(existing[0] if existing else None, {})
        existing_map = {
            item["sourceProjectId"]: item["projectId"]
            for item in existing_projects.get("projects", [])
            if isinstance(item, dict)
            and isinstance(item.get("sourceProjectId"), str)
            and isinstance(item.get("projectId"), str)
        }
        source = as_record(body.get("data"))
        projects = source.get("projects", [])
        if not isinstance(projects, list):
            projects = []
        imported_projects: list[dict[str, str]] = []
        created_projects = 0
        services.database.execute("BEGIN IMMEDIATE")
        try:
            for raw_project in projects:
                source_project = as_record(raw_project)
                name = _text(source_project.get("name")).strip()
                source_project_id = _text(source_project.get("id")).strip() or str(
                    uuid.uuid4()
                )
                if not name:
                    continue
                project_id = existing_map.get(source_project_id)
                if project_id:
                    current = services.database.execute(
                        """
                        SELECT id FROM platform_projects
                        WHERE id = ? AND workspace_id = ?
                        """,
                        (project_id, workspace_id),
                    ).fetchone()
                    if not current:
                        project_id = None
                if not project_id:
                    existing_source = services.database.execute(
                        """
                        SELECT id FROM platform_projects
                        WHERE workspace_id = ? AND source_project_id = ?
                        """,
                        (workspace_id, source_project_id),
                    ).fetchone()
                    project_id = existing_source[0] if existing_source else None
                if not project_id:
                    project_id = str(uuid.uuid4())
                    slug = clean_project_slug(f"{name}-{source_project_id[:6]}")
                    suffix = 2
                    while services.database.execute(
                        """
                        SELECT id FROM platform_projects
                        WHERE workspace_id = ? AND slug = ?
                        """,
                        (workspace_id, slug),
                    ).fetchone():
                        slug = f"{clean_project_slug(name)}-{suffix}"
                        suffix += 1
                    created_at = now()
                    services.database.execute(
                        """
                        INSERT INTO platform_projects (
                          id, workspace_id, source_project_id, slug, name,
                          description, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            project_id,
                            workspace_id,
                            source_project_id,
                            slug,
                            name[:160],
                            _text(source_project.get("description")).strip()[:1000],
                            created_at,
                            created_at,
                        ),
                    )
                    created_projects += 1
                else:
                    services.database.execute(
                        """
                        UPDATE platform_projects
                        SET source_project_id = COALESCE(source_project_id, ?),
                            archived_at = NULL, updated_at = ?
                        WHERE id = ? AND workspace_id = ?
                        """,
                        (source_project_id, now(), project_id, workspace_id),
                    )
                flows_by_project = as_record(source.get("flowsByProject"))
                elements_by_project = as_record(source.get("elementsByProject"))
                variables_by_project = as_record(source.get("variablesByProject"))
                environments_by_project = as_record(
                    source.get("environmentsByProject")
                )
                active_environment_by_project = as_record(
                    source.get("activeEnvironmentByProject")
                )
                members_by_project = as_record(source.get("membersByProject"))
                data = {
                    "sourceProjectId": source_project_id,
                    "flows": flows_by_project.get(source_project_id, []),
                    "elements": elements_by_project.get(source_project_id, []),
                    "variables": variables_by_project.get(source_project_id, []),
                    "environments": environments_by_project.get(
                        source_project_id, []
                    ),
                    "activeEnvironmentId": active_environment_by_project.get(
                        source_project_id, ""
                    ),
                    "members": members_by_project.get(source_project_id, []),
                }
                document = services.document_for(project_id)
                if document["version"] == 0:
                    services.put_document(project_id, data)
                elif not isinstance(document["data"].get("sourceProjectId"), str):
                    services.put_document(
                        project_id,
                        {**document["data"], "sourceProjectId": source_project_id},
                        document["version"],
                    )
                imported_projects.append(
                    {"sourceProjectId": source_project_id, "projectId": project_id}
                )
            result = {"projects": imported_projects}
            services.database.execute(
                """
                INSERT INTO platform_imports (
                  id, workspace_id, source_id, imported_at, result
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(workspace_id, source_id) DO UPDATE SET
                  imported_at = excluded.imported_at,
                  result = excluded.result
                """,
                (str(uuid.uuid4()), workspace_id, source_id, now(), json(result)),
            )
            services.database.execute("COMMIT")
        except Exception:
            services.database.execute("ROLLBACK")
            raise
        services.audit(
            workspace_id,
            {"type": "user", "id": user.id},
            "workspace.local_storage_imported",
            {"type": "import", "id": source_id},
            {"count": len(imported_projects)},
        )
        return _send(
            Response(),
            201 if created_projects > 0 else 200,
            {"imported": created_projects > 0, **result},
        )
