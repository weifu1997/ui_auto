"""FastAPI router matching server/platform-handler.ts."""

from __future__ import annotations

import secrets
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request, Response
from fastapi.responses import FileResponse

from .auth import clear_session_cookie, password_hash, password_matches, set_session_cookie
from .core import (
    WEBHOOK_MAX_RUNS,
    WEBHOOK_RATE_LIMIT_PER_MINUTE,
    WEBHOOK_TIMESTAMP_TOLERANCE_MS,
    authorization,
    clean_project_slug,
    digest,
    json,
    next_cron_time,
    now,
    parse_json,
    webhook_signature_matches,
)
from .http import PlatformError
from .resources import as_record, public_resource_data
from .revisions import revision_number
from .services import PlatformServices
from .templates import rewrite_template_references


RESOURCE_CAPABILITIES = {
    "flows": "flow.edit",
    "elements": "element.manage",
    "variables": "variable.manage",
    "environments": "environment.manage",
}


def _send(response: Response, status_code: int, body: Any) -> Response:
    return Response(
        content=json(body),
        status_code=status_code,
        media_type="application/json; charset=utf-8",
    )


def _text(value: Any) -> str:
    return "" if value is None else str(value)


def _assert_snapshot_depth(value: Any, limit: int = 100, current: int = 0) -> None:
    if current > limit:
        raise PlatformError(400, "SNAPSHOT_TOO_DEEP")
    if isinstance(value, list):
        for item in value:
            _assert_snapshot_depth(item, limit, current + 1)
    elif isinstance(value, dict):
        for item in value.values():
            _assert_snapshot_depth(item, limit, current + 1)


def create_platform_router(services: PlatformServices) -> APIRouter:
    router = APIRouter()

    @router.api_route("/api/platform/health", methods=["GET"])
    def platform_health() -> Response:
        return _send(Response(), 200, {"ok": True, "service": "platform"})

    @router.api_route("/api/auth/register", methods=["POST"])
    async def register(request: Request) -> Response:
        body = await request.json()
        if not isinstance(body, dict):
            body = {}
        email = _text(body.get("email")).strip().lower()
        password = _text(body.get("password")).strip()
        if (
            not email
            or "@" not in email
            or not password
            or len(password) < 8
            or len(password) > 1024
        ):
            raise PlatformError(400, "REGISTER_INPUT_INVALID")
        existing = services.database.execute(
            """
            SELECT user_id FROM platform_user_credentials
            WHERE user_id IN (SELECT id FROM platform_users WHERE email = ?)
            """,
            (email,),
        ).fetchone()
        if existing:
            raise PlatformError(409, "EMAIL_ALREADY_REGISTERED")
        user = {
            "id": str(uuid.uuid4()),
            "email": email,
            "name": _text(body.get("name")).strip()[:100] or email.split("@")[0],
        }
        services.database.execute("BEGIN IMMEDIATE")
        try:
            services.database.execute(
                """
                INSERT INTO platform_users (id, email, name, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (user["id"], user["email"], user["name"], now()),
            )
            created = now()
            services.database.execute(
                """
                INSERT INTO platform_user_credentials
                  (user_id, password_hash, created_at, updated_at)
                VALUES (?, ?, ?, ?)
                """,
                (user["id"], password_hash(password), created, created),
            )
            from .services import AuthUser

            workspace = services.create_workspace(
                AuthUser(user["id"], user["email"], user["name"]),
                f"{user['name']}'s workspace",
            )
            services.audit(
                workspace["id"],
                {"type": "user", "id": user["id"]},
                "auth.registered",
                {"type": "user", "id": user["id"]},
                {"email": email, "ip": _client_ip(request)},
            )
            services.database.execute("COMMIT")
        except Exception:
            services.database.execute("ROLLBACK")
            raise
        session = services.create_auth_session(
            AuthUser(user["id"], user["email"], user["name"])
        )
        response = _send(Response(), 201, session)
        response.headers["set-cookie"] = set_session_cookie(
            session["token"], session["expiresAt"]
        )
        return response

    @router.api_route("/api/auth/login", methods=["POST"])
    async def login(request: Request) -> Response:
        body = await request.json()
        if not isinstance(body, dict):
            body = {}
        email = _text(body.get("email")).strip().lower()
        password = _text(body.get("password"))
        if not email or "@" not in email or not password:
            raise PlatformError(400, "LOGIN_INPUT_INVALID")
        user_row = services.database.execute(
            """
            SELECT id, email, name FROM platform_users
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
        from .services import AuthUser

        user = AuthUser(user_row[0], user_row[1], user_row[2])
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
                "user": {"id": user.id, "email": user.email, "name": user.name},
                "workspaces": services.workspaces_for_user(user.id),
            },
        )

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
        return _send(
            Response(),
            201,
            {"workspace": services.create_workspace(user, _text(body.get("name")))},
        )

    @router.api_route("/api/workspaces/{workspace_id}/projects", methods=["GET", "POST"])
    async def workspace_projects(request: Request, workspace_id: str) -> Response:
        user = services.session_user(dict(request.headers))
        services.require_workspace_role(workspace_id, user.id)
        if request.method == "GET":
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
        except Exception:
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

    @router.api_route("/api/platform/projects/{project_id}", methods=["GET", "PATCH"])
    async def project_base(request: Request, project_id: str) -> Response:
        user = services.session_user(dict(request.headers))
        if request.method == "GET":
            result = services.require_project_role(project_id, user.id)
        else:
            result = services.require_project_capability(
                project_id, user.id, "project.edit"
            )
        project = result["project"]
        if request.method == "GET":
            return _send(
                Response(), 200, {"project": services.project_response(project)}
            )
        body = await request.json()
        if not isinstance(body, dict):
            body = {}
        name = _text(body.get("name")).strip()[:160] or project["name"]
        description = (
            project["description"]
            if body.get("description") is None
            else _text(body.get("description")).strip()[:1000]
        )
        archived_at = (
            now()
            if body.get("archived") is True
            else None
            if body.get("archived") is False
            else project["archived_at"]
        )
        if body.get("archived") is True:
            services.database.execute(
                """
                UPDATE schedules SET enabled = 0, updated_at = ?
                WHERE project_id = ? AND enabled = 1
                """,
                (now(), project_id),
            )
            services.database.execute(
                """
                UPDATE webhook_triggers SET enabled = 0
                WHERE project_id = ? AND enabled = 1
                """,
                (project_id,),
            )
        services.database.execute(
            """
            UPDATE platform_projects
            SET name = ?, description = ?, archived_at = ?, updated_at = ?
            WHERE id = ?
            """,
            (name, description, archived_at, now(), project_id),
        )
        services.audit(
            project["workspace_id"],
            {"type": "user", "id": user.id},
            "project.updated",
            {"type": "project", "id": project_id},
            {"archived": body.get("archived")},
            project_id,
        )
        return _send(
            Response(),
            200,
            {"project": services.project_response(services.project_for(project_id))},
        )

    @router.api_route(
        "/api/platform/projects/{project_id}/document", methods=["GET", "PUT"]
    )
    async def project_document(request: Request, project_id: str) -> Response:
        user = services.session_user(dict(request.headers))
        if request.method == "GET":
            result = services.require_project_role(project_id, user.id)
        else:
            result = services.require_project_capability(
                project_id, user.id, "dataset.manage"
            )
        project = result["project"]
        if request.method == "GET":
            return _send(Response(), 200, services.document_for(project_id))
        body = await request.json()
        if not isinstance(body, dict) or not isinstance(body.get("data"), dict):
            raise PlatformError(400, "DOCUMENT_REQUIRED")
        data = body["data"]
        for key, capability in RESOURCE_CAPABILITIES.items():
            if key in data:
                services.require_project_capability(project_id, user.id, capability)
        result = services.put_document(
            project_id, data, body.get("expectedVersion")
        )
        services.database.execute(
            "UPDATE platform_projects SET updated_at = ? WHERE id = ?",
            (now(), project_id),
        )
        services.audit(
            project["workspace_id"],
            {"type": "user", "id": user.id},
            "project.document_saved",
            {"type": "project", "id": project_id},
            {"version": result["version"]},
            project_id,
        )
        return _send(Response(), 200, result)

    @router.api_route("/api/platform/templates", methods=["GET", "POST"])
    async def templates(request: Request) -> Response:
        user = services.session_user(dict(request.headers))
        workspace_id = request.query_params.get("workspaceId", "")
        services.require_workspace_role(
            workspace_id, user.id, request.method == "POST"
        )
        if request.method == "GET":
            q = request.query_params.get("q", "").strip()[:100]
            search = f"%{q}%"
            category = request.query_params.get("category")
            query = """
                SELECT t.id, t.name, t.description, t.category,
                       t.source_project_id, t.source_revision_id,
                       t.created_by, t.created_at, t.updated_at,
                       CASE WHEN f.user_id IS NULL THEN 0 ELSE 1 END favorite
                FROM internal_templates t
                LEFT JOIN template_favorites f
                  ON f.template_id = t.id AND f.user_id = ?
                WHERE t.workspace_id = ? AND t.deleted_at IS NULL
                  AND (t.name LIKE ? OR t.description LIKE ?)
            """
            params: list[Any] = [user.id, workspace_id, search, search]
            if category:
                query += " AND t.category = ?"
                params.append(category)
            query += " ORDER BY favorite DESC, t.updated_at DESC"
            rows = services.database.execute(query, tuple(params)).fetchall()
            return _send(
                Response(),
                200,
                {
                    "templates": [
                        {
                            "id": row[0],
                            "name": row[1],
                            "description": row[2],
                            "category": row[3],
                            "sourceProjectId": row[4],
                            "sourceRevisionId": row[5],
                            "createdBy": row[6],
                            "createdAt": row[7],
                            "updatedAt": row[8],
                            "favorite": bool(row[9]),
                        }
                        for row in rows
                    ]
                },
            )

        body = await request.json()
        if not isinstance(body, dict):
            body = {}
        project_id = _text(body.get("projectId")).strip()
        revision_id = _text(body.get("revisionId")).strip()
        result = services.require_project_capability(
            project_id, user.id, "release.publish"
        )
        project = result["project"]
        name = _text(body.get("name")).strip()
        if project["workspace_id"] != workspace_id or not name:
            raise PlatformError(400, "TEMPLATE_INPUT_INVALID")
        revision = services.database.execute(
            """
            SELECT id, status, flow_snapshot, environment_snapshot,
                   element_snapshot
            FROM flow_revisions WHERE id = ? AND project_id = ?
            """,
            (revision_id, project_id),
        ).fetchone()
        if not revision or revision[1] != "published":
            raise PlatformError(409, "PUBLISHED_REVISION_REQUIRED")
        variables = services.database.execute(
            """
            SELECT data FROM project_resources
            WHERE project_id = ? AND resource_type = 'variables'
              AND archived_at IS NULL
            """,
            (project_id,),
        ).fetchall()
        snapshot = {
            "flow": parse_json(revision[2], {}),
            "environments": [parse_json(revision[3], {})],
            "elements": parse_json(revision[4], []),
            "variables": [
                public_resource_data(parse_json(row[0], {})) for row in variables
            ],
        }
        template_id = str(uuid.uuid4())
        created_at = now()
        services.database.execute(
            """
            INSERT INTO internal_templates (
              id, workspace_id, source_project_id, source_revision_id, name,
              description, category, snapshot, created_by, created_at,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                template_id,
                workspace_id,
                project_id,
                revision[0],
                name[:160],
                _text(body.get("description")).strip()[:1000],
                _text(body.get("category")).strip()[:80] or "通用",
                json(snapshot),
                user.id,
                created_at,
                created_at,
            ),
        )
        services.audit(
            workspace_id,
            {"type": "user", "id": user.id},
            "template.published",
            {"type": "template", "id": template_id},
            {"sourceRevisionId": revision[0]},
            project_id,
        )
        return _send(
            Response(),
            201,
            {
                "template": {
                    "id": template_id,
                    "name": name,
                    "description": _text(body.get("description")).strip(),
                    "category": _text(body.get("category")).strip() or "通用",
                    "favorite": False,
                    "createdAt": created_at,
                    "updatedAt": created_at,
                }
            },
        )

    @router.api_route(
        "/api/platform/templates/{template_id}", methods=["GET", "PATCH", "DELETE"]
    )
    async def template_detail(
        request: Request, template_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        template = services.database.execute(
            """
            SELECT id, workspace_id, name, description, category, snapshot,
                   created_by, source_project_id, source_revision_id,
                   created_at, updated_at
            FROM internal_templates WHERE id = ? AND deleted_at IS NULL
            """,
            (template_id,),
        ).fetchone()
        if not template:
            raise PlatformError(404, "TEMPLATE_NOT_FOUND")
        services.require_workspace_role(template[1], user.id)
        if request.method == "GET":
            return _send(
                Response(),
                200,
                {
                    "template": {
                        "id": template[0],
                        "name": template[2],
                        "description": template[3],
                        "category": template[4],
                        "snapshot": parse_json(template[5], {}),
                        "sourceProjectId": template[7],
                        "sourceRevisionId": template[8],
                        "createdBy": template[6],
                        "createdAt": template[9],
                        "updatedAt": template[10],
                    }
                },
            )
        if template[6] != user.id:
            services.require_workspace_role(template[1], user.id, True)
        if request.method == "DELETE":
            services.database.execute(
                """
                UPDATE internal_templates SET deleted_at = ?, updated_at = ?
                WHERE id = ?
                """,
                (now(), now(), template_id),
            )
            services.audit(
                template[1],
                {"type": "user", "id": user.id},
                "template.deleted",
                {"type": "template", "id": template_id},
            )
            return _send(Response(), 200, {"templateId": template_id, "deleted": True})

        body = await request.json()
        if not isinstance(body, dict):
            body = {}
        name = _text(body.get("name")).strip()[:160]
        if not name:
            raise PlatformError(400, "TEMPLATE_NAME_REQUIRED")
        description = _text(body.get("description")).strip()[:1000]
        category = _text(body.get("category")).strip()[:80] or "通用"
        updated_at = now()
        services.database.execute(
            """
            UPDATE internal_templates
            SET name = ?, description = ?, category = ?, updated_at = ?
            WHERE id = ?
            """,
            (name, description, category, updated_at, template_id),
        )
        services.audit(
            template[1],
            {"type": "user", "id": user.id},
            "template.updated",
            {"type": "template", "id": template_id},
            {"name": name, "category": category},
        )
        return _send(
            Response(),
            200,
            {
                "template": {
                    "id": template_id,
                    "name": name,
                    "description": description,
                    "category": category,
                    "sourceProjectId": template[7],
                    "sourceRevisionId": template[8],
                    "createdBy": template[6],
                    "createdAt": template[9],
                    "updatedAt": updated_at,
                }
            },
        )

    @router.api_route(
        "/api/platform/templates/{template_id}/favorite",
        methods=["POST", "DELETE"],
    )
    async def template_favorite(
        request: Request, template_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        template = services.database.execute(
            """
            SELECT workspace_id FROM internal_templates
            WHERE id = ? AND deleted_at IS NULL
            """,
            (template_id,),
        ).fetchone()
        if not template:
            raise PlatformError(404, "TEMPLATE_NOT_FOUND")
        services.require_workspace_role(template[0], user.id)
        if request.method == "POST":
            services.database.execute(
                """
                INSERT OR IGNORE INTO template_favorites (
                  template_id, user_id, created_at
                ) VALUES (?, ?, ?)
                """,
                (template_id, user.id, now()),
            )
        else:
            services.database.execute(
                """
                DELETE FROM template_favorites
                WHERE template_id = ? AND user_id = ?
                """,
                (template_id, user.id),
            )
        return _send(
            Response(),
            200,
            {"templateId": template_id, "favorite": request.method == "POST"},
        )

    @router.api_route(
        "/api/platform/templates/{template_id}/apply", methods=["POST"]
    )
    async def template_apply(request: Request, template_id: str) -> Response:
        user = services.session_user(dict(request.headers))
        template = services.database.execute(
            """
            SELECT id, workspace_id, snapshot FROM internal_templates
            WHERE id = ? AND deleted_at IS NULL
            """,
            (template_id,),
        ).fetchone()
        if not template:
            raise PlatformError(404, "TEMPLATE_NOT_FOUND")
        body = await request.json()
        if not isinstance(body, dict):
            body = {}
        project_id = _text(body.get("projectId")).strip()
        result = services.require_project_capability(
            project_id, user.id, "flow.edit"
        )
        project = result["project"]
        if project["workspace_id"] != template[1]:
            raise PlatformError(403, "TEMPLATE_WORKSPACE_MISMATCH")
        snapshot = parse_json(template[2], {})
        if not isinstance(snapshot, dict):
            snapshot = {}
        collections = {
            "flows": [as_record(snapshot.get("flow"))],
            "elements": [
                as_record(item)
                for item in snapshot.get("elements", [])
                if isinstance(item, dict)
            ],
            "variables": [
                as_record(item)
                for item in snapshot.get("variables", [])
                if isinstance(item, dict)
            ],
            "environments": [
                as_record(item)
                for item in snapshot.get("environments", [])
                if isinstance(item, dict)
            ],
        }
        ids: dict[str, str] = {}
        for resources in collections.values():
            for resource in resources:
                if isinstance(resource.get("id"), str):
                    ids[resource["id"]] = str(uuid.uuid4())
        created: dict[str, list[str]] = {}
        services.database.execute("BEGIN IMMEDIATE")
        try:
            for resource_type, resources in collections.items():
                created[resource_type] = []
                for source in resources:
                    old_id = (
                        source.get("id")
                        if isinstance(source.get("id"), str)
                        else str(uuid.uuid4())
                    )
                    resource_id = ids.get(old_id, str(uuid.uuid4()))
                    rewritten = public_resource_data(
                        rewrite_template_references({**source, "id": resource_id}, ids)
                    )
                    services.database.execute(
                        """
                        INSERT INTO project_resources (
                          project_id, resource_type, resource_id, data, version,
                          updated_at, updated_by
                        ) VALUES (?, ?, ?, ?, 1, ?, ?)
                        """,
                        (
                            project_id,
                            resource_type,
                            resource_id,
                            json(rewritten),
                            now(),
                            user.id,
                        ),
                    )
                    created[resource_type].append(resource_id)
            services.database.execute("COMMIT")
        except Exception:
            services.database.execute("ROLLBACK")
            raise
        services.audit(
            template[1],
            {"type": "user", "id": user.id},
            "template.applied",
            {"type": "template", "id": template_id},
            {"targetProjectId": project_id, "created": created},
            project_id,
        )
        return _send(
            Response(), 201, {"templateId": template_id, "projectId": project_id, "created": created}
        )

    @router.api_route(
        "/api/platform/projects/{project_id}/resources/{resource_type}",
        methods=["GET", "POST"],
    )
    async def resource_collection(
        request: Request, project_id: str, resource_type: str
    ) -> Response:
        if resource_type not in RESOURCE_CAPABILITIES:
            raise PlatformError(404, "RESOURCE_NOT_FOUND")
        user = services.session_user(dict(request.headers))
        capability = RESOURCE_CAPABILITIES[resource_type]
        if request.method == "GET":
            result = services.require_project_role(project_id, user.id)
        else:
            result = services.require_project_capability(
                project_id, user.id, capability
            )
        project = result["project"]
        if request.method == "GET":
            include_archived = request.query_params.get("archived") == "1"
            query = """
                SELECT resource_id, data, version, archived_at, updated_at, updated_by
                FROM project_resources
                WHERE project_id = ? AND resource_type = ?
            """
            if not include_archived:
                query += " AND archived_at IS NULL"
            query += " ORDER BY updated_at DESC"
            rows = services.database.execute(
                query, (project_id, resource_type)
            ).fetchall()
            resources = [
                {
                    "id": row[0],
                    "data": public_resource_data(parse_json(row[1], {})),
                    "version": row[2],
                    "archivedAt": row[3],
                    "updatedAt": row[4],
                    "updatedBy": row[5],
                }
                for row in rows
            ]
            return _send(Response(), 200, {"resources": resources})

        body = await request.json()
        if not isinstance(body, dict):
            body = {}
        raw_data = body.get("data")
        if not isinstance(raw_data, dict):
            raw_data = {}
        if (
            raw_data.get("secret") is True
            and isinstance(raw_data.get("value"), str)
            and raw_data["value"].strip() != ""
        ):
            raise PlatformError(400, "SECRET_VALUE_NOT_PERSISTED")
        data = public_resource_data(raw_data)
        resource_id = _text(body.get("id")).strip()
        if not resource_id and isinstance(data.get("id"), str):
            resource_id = data["id"].strip()
        if not resource_id:
            resource_id = str(uuid.uuid4())
        if len(resource_id) > 240:
            raise PlatformError(400, "RESOURCE_ID_INVALID")
        timestamp = now()
        try:
            services.database.execute(
                """
                INSERT INTO project_resources (
                  project_id, resource_type, resource_id, data, version,
                  updated_at, updated_by
                ) VALUES (?, ?, ?, ?, 1, ?, ?)
                """,
                (
                    project_id,
                    resource_type,
                    resource_id,
                    json({**data, "id": resource_id}),
                    timestamp,
                    user.id,
                ),
            )
        except Exception:
            raise PlatformError(409, "RESOURCE_ALREADY_EXISTS")
        services.audit(
            project["workspace_id"],
            {"type": "user", "id": user.id},
            f"{resource_type}.created",
            {"type": resource_type, "id": resource_id},
            {},
            project_id,
        )
        return _send(
            Response(),
            201,
            {
                "resource": {
                    "id": resource_id,
                    "data": {**data, "id": resource_id},
                    "version": 1,
                    "archivedAt": None,
                    "updatedAt": timestamp,
                    "updatedBy": user.id,
                }
            },
        )

    @router.api_route(
        "/api/platform/projects/{project_id}/resources/{resource_type}/{resource_id}",
        methods=["GET", "PUT", "PATCH", "DELETE"],
    )
    async def resource_detail(
        request: Request,
        project_id: str,
        resource_type: str,
        resource_id: str,
    ) -> Response:
        if resource_type not in RESOURCE_CAPABILITIES:
            raise PlatformError(404, "RESOURCE_NOT_FOUND")
        user = services.session_user(dict(request.headers))
        capability = RESOURCE_CAPABILITIES[resource_type]
        if request.method == "GET":
            result = services.require_project_role(project_id, user.id)
        else:
            result = services.require_project_capability(
                project_id, user.id, capability
            )
        project = result["project"]
        current = services.database.execute(
            """
            SELECT data, version, archived_at, updated_at, updated_by
            FROM project_resources
            WHERE project_id = ? AND resource_type = ? AND resource_id = ?
            """,
            (project_id, resource_type, resource_id),
        ).fetchone()
        if not current:
            raise PlatformError(404, "RESOURCE_NOT_FOUND")
        if request.method == "GET":
            return _send(
                Response(),
                200,
                {
                    "resource": {
                        "id": resource_id,
                        "data": public_resource_data(parse_json(current[0], {})),
                        "version": current[1],
                        "archivedAt": current[2],
                        "updatedAt": current[3],
                        "updatedBy": current[4],
                    }
                },
            )
        if request.method == "PUT" or request.method == "PATCH":
            body = await request.json()
            if not isinstance(body, dict) or not isinstance(
                body.get("expectedVersion"), int
            ):
                raise PlatformError(400, "EXPECTED_VERSION_REQUIRED")
            expected_version = body["expectedVersion"]
            previous = parse_json(current[0], {})
            if request.method == "PATCH":
                patch = body.get("data")
                merged = {
                    **previous,
                    **(patch if isinstance(patch, dict) else {}),
                    "id": resource_id,
                }
            else:
                raw = body.get("data")
                merged = {
                    **(raw if isinstance(raw, dict) else {}),
                    "id": resource_id,
                }
            if (
                merged.get("secret") is True
                and isinstance(merged.get("value"), str)
                and merged["value"].strip() != ""
            ):
                raise PlatformError(400, "SECRET_VALUE_NOT_PERSISTED")
            data = public_resource_data(merged)
            timestamp = now()
            archived_at = (
                timestamp
                if body.get("archived") is True
                else None
                if body.get("archived") is False
                else current[2]
            )
            cursor = services.database.execute(
                """
                UPDATE project_resources
                SET data = ?, version = version + 1, archived_at = ?,
                    updated_at = ?, updated_by = ?
                WHERE project_id = ? AND resource_type = ? AND resource_id = ?
                  AND version = ?
                """,
                (
                    json(data),
                    archived_at,
                    timestamp,
                    user.id,
                    project_id,
                    resource_type,
                    resource_id,
                    expected_version,
                ),
            )
            if cursor.rowcount == 0:
                raise PlatformError(409, "RESOURCE_VERSION_CONFLICT")
            version = expected_version + 1
            services.audit(
                project["workspace_id"],
                {"type": "user", "id": user.id},
                f"{resource_type}.updated",
                {"type": resource_type, "id": resource_id},
                {"version": version, "archived": body.get("archived")},
                project_id,
            )
            return _send(
                Response(),
                200,
                {
                    "resource": {
                        "id": resource_id,
                        "data": data,
                        "version": version,
                        "archivedAt": archived_at,
                        "updatedAt": timestamp,
                        "updatedBy": user.id,
                    }
                },
            )

        expected_text = request.query_params.get("expectedVersion")
        try:
            expected_version = int(expected_text)
        except (TypeError, ValueError):
            raise PlatformError(400, "EXPECTED_VERSION_REQUIRED")
        timestamp = now()
        cursor = services.database.execute(
            """
            UPDATE project_resources
            SET archived_at = ?, version = version + 1, updated_at = ?, updated_by = ?
            WHERE project_id = ? AND resource_type = ? AND resource_id = ?
              AND version = ?
            """,
            (
                timestamp,
                timestamp,
                user.id,
                project_id,
                resource_type,
                resource_id,
                expected_version,
            ),
        )
        if cursor.rowcount == 0:
            raise PlatformError(409, "RESOURCE_VERSION_CONFLICT")
        services.audit(
            project["workspace_id"],
            {"type": "user", "id": user.id},
            f"{resource_type}.archived",
            {"type": resource_type, "id": resource_id},
            {},
            project_id,
        )
        return _send(
            Response(),
            200,
            {"id": resource_id, "archived": True, "version": expected_version + 1},
        )

    @router.api_route(
        "/api/platform/projects/{project_id}/settings", methods=["GET", "PUT"]
    )
    async def project_settings(request: Request, project_id: str) -> Response:
        user = services.session_user(dict(request.headers))
        if request.method == "GET":
            result = services.require_project_role(project_id, user.id)
        else:
            result = services.require_project_capability(
                project_id, user.id, "project.edit"
            )
        project = result["project"]
        current = services.database.execute(
            """
            SELECT data, version, updated_at, updated_by FROM project_settings
            WHERE project_id = ?
            """,
            (project_id,),
        ).fetchone()
        if request.method == "GET":
            return _send(
                Response(),
                200,
                {
                    "settings": {
                        "data": parse_json(current[0] if current else None, {}),
                        "version": current[1] if current else 0,
                        "updatedAt": current[2] if current else None,
                        "updatedBy": current[3] if current else None,
                    }
                },
            )

        body = await request.json()
        if not isinstance(body, dict):
            body = {}
        expected_version = body.get("expectedVersion")
        current_version = current[1] if current else 0
        if not isinstance(expected_version, int) or expected_version != current_version:
            raise PlatformError(409, "RESOURCE_VERSION_CONFLICT")
        data = as_record(body.get("data"))
        version = expected_version + 1
        timestamp = now()
        services.database.execute(
            """
            INSERT INTO project_settings (
              project_id, data, version, updated_at, updated_by
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(project_id) DO UPDATE SET
              data = excluded.data,
              version = excluded.version,
              updated_at = excluded.updated_at,
              updated_by = excluded.updated_by
            """,
            (project_id, json(data), version, timestamp, user.id),
        )
        services.audit(
            project["workspace_id"],
            {"type": "user", "id": user.id},
            "project.settings_updated",
            {"type": "project", "id": project_id},
            {"version": version},
            project_id,
        )
        return _send(
            Response(),
            200,
            {
                "settings": {
                    "data": data,
                    "version": version,
                    "updatedAt": timestamp,
                    "updatedBy": user.id,
                }
            },
        )

    @router.api_route(
        "/api/platform/projects/{project_id}/datasets", methods=["GET", "POST"]
    )
    async def datasets(request: Request, project_id: str) -> Response:
        user = services.session_user(dict(request.headers))
        if request.method == "GET":
            result = services.require_project_role(project_id, user.id)
        else:
            result = services.require_project_capability(
                project_id, user.id, "dataset.manage"
            )
        project = result["project"]
        if request.method == "GET":
            rows = services.database.execute(
                """
                SELECT d.id, d.name, d.description, d.created_at, d.updated_at,
                       v.id AS version_id, v.version_number, v.columns_json,
                       v.row_count, v.checksum, v.source_name,
                       v.created_at AS version_created_at
                FROM datasets d
                LEFT JOIN dataset_versions v ON v.id = (
                  SELECT id FROM dataset_versions
                  WHERE dataset_id = d.id ORDER BY version_number DESC LIMIT 1
                )
                WHERE d.project_id = ? AND d.archived_at IS NULL
                ORDER BY d.updated_at DESC
                """,
                (project_id,),
            ).fetchall()
            dataset_items = []
            for row in rows:
                item = {
                    "id": row[0],
                    "name": row[1],
                    "description": row[2],
                    "createdAt": row[3],
                    "updatedAt": row[4],
                }
                if row[5]:
                    item["latestVersion"] = {
                        "id": row[5],
                        "datasetId": row[0],
                        "projectId": project_id,
                        "versionNumber": row[6],
                        "columns": parse_json(row[7], []),
                        "rowCount": row[8],
                        "checksum": row[9],
                        "sourceName": row[10],
                        "createdAt": row[11],
                    }
                dataset_items.append(item)
            return _send(Response(), 200, {"datasets": dataset_items})

        body = await request.json()
        if not isinstance(body, dict):
            body = {}
        name = _text(body.get("name")).strip()[:160]
        if not name or not body.get("fileName") or not body.get("contentBase64"):
            raise PlatformError(400, "DATASET_IMPORT_INPUT_INVALID")
        parsed = services.parse_dataset_upload(
            _text(body.get("fileName")), _text(body.get("contentBase64"))
        )
        dataset_id = str(uuid.uuid4())
        created_at = now()
        services.database.execute("BEGIN IMMEDIATE")
        try:
            services.database.execute(
                """
                INSERT INTO datasets (
                  id, project_id, name, description, created_by, created_at,
                  updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    dataset_id,
                    project_id,
                    name,
                    _text(body.get("description")).strip()[:1000],
                    user.id,
                    created_at,
                    created_at,
                ),
            )
            version_id = str(uuid.uuid4())
            version_number = 1
            version_checksum = digest(
                json({"columns": parsed["columns"], "rows": parsed["rows"]})
            )
            services.database.execute(
                """
                INSERT INTO dataset_versions (
                  id, dataset_id, version_number, columns_json, row_count,
                  checksum, source_name, created_by, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    version_id,
                    dataset_id,
                    version_number,
                    json(parsed["columns"]),
                    len(parsed["rows"]),
                    version_checksum,
                    parsed["sourceName"],
                    user.id,
                    created_at,
                ),
            )
            for index, row in enumerate(parsed["rows"]):
                services.database.execute(
                    """
                    INSERT INTO dataset_rows (
                      id, dataset_version_id, row_number, data_json
                    ) VALUES (?, ?, ?, ?)
                    """,
                    (str(uuid.uuid4()), version_id, index + 1, json(row)),
                )
            services.database.execute("COMMIT")
        except Exception as exc:
            services.database.execute("ROLLBACK")
            if isinstance(exc, PlatformError):
                raise
            raise PlatformError(409, "DATASET_NAME_EXISTS") from exc
        services.audit(
            project["workspace_id"],
            {"type": "user", "id": user.id},
            "dataset.imported",
            {"type": "dataset", "id": dataset_id},
            {
                "versionId": version_id,
                "rows": len(parsed["rows"]),
                "sourceName": parsed["sourceName"],
            },
            project_id,
        )
        return _send(
            Response(),
            201,
            {
                "dataset": {
                    "id": dataset_id,
                    "name": name,
                    "description": _text(body.get("description")).strip(),
                    "createdAt": created_at,
                },
                "version": services.dataset_version_for(project_id, version_id),
            },
        )

    @router.api_route(
        "/api/platform/projects/{project_id}/datasets/{dataset_id}",
        methods=["DELETE"],
    )
    async def dataset_detail(
        request: Request, project_id: str, dataset_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        result = services.require_project_capability(
            project_id, user.id, "dataset.manage"
        )
        project = result["project"]
        cursor = services.database.execute(
            """
            UPDATE datasets SET archived_at = ?, updated_at = ?
            WHERE id = ? AND project_id = ? AND archived_at IS NULL
            """,
            (now(), now(), dataset_id, project_id),
        )
        if cursor.rowcount == 0:
            raise PlatformError(404, "DATASET_NOT_FOUND")
        services.audit(
            project["workspace_id"],
            {"type": "user", "id": user.id},
            "dataset.archived",
            {"type": "dataset", "id": dataset_id},
            {},
            project_id,
        )
        return _send(Response(), 200, {"datasetId": dataset_id, "archived": True})

    @router.api_route(
        "/api/platform/projects/{project_id}/datasets/{dataset_id}/versions",
        methods=["GET", "POST"],
    )
    async def dataset_versions(
        request: Request, project_id: str, dataset_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        if request.method == "GET":
            result = services.require_project_role(project_id, user.id)
        else:
            result = services.require_project_capability(
                project_id, user.id, "dataset.manage"
            )
        project = result["project"]
        dataset = services.database.execute(
            """
            SELECT id, name FROM datasets
            WHERE id = ? AND project_id = ? AND archived_at IS NULL
            """,
            (dataset_id, project_id),
        ).fetchone()
        if not dataset:
            raise PlatformError(404, "DATASET_NOT_FOUND")
        if request.method == "GET":
            rows = services.database.execute(
                """
                SELECT v.id, v.dataset_id, d.project_id, v.version_number,
                       v.columns_json, v.row_count, v.checksum, v.source_name,
                       v.created_at
                FROM dataset_versions v
                JOIN datasets d ON d.id = v.dataset_id
                WHERE v.dataset_id = ? ORDER BY v.version_number DESC
                """,
                (dataset_id,),
            ).fetchall()
            return _send(
                Response(),
                200,
                {
                    "versions": [
                        services.dataset_version_response(row) for row in rows
                    ]
                },
            )

        body = await request.json()
        if not isinstance(body, dict):
            body = {}
        if not body.get("fileName") or not body.get("contentBase64"):
            raise PlatformError(400, "DATASET_IMPORT_INPUT_INVALID")
        parsed = services.parse_dataset_upload(
            _text(body.get("fileName")), _text(body.get("contentBase64"))
        )
        services.database.execute("BEGIN IMMEDIATE")
        try:
            latest = services.database.execute(
                "SELECT MAX(version_number) FROM dataset_versions WHERE dataset_id = ?",
                (dataset_id,),
            ).fetchone()
            version_number = int(latest[0] or 0) + 1
            version_id = str(uuid.uuid4())
            version_checksum = digest(
                json({"columns": parsed["columns"], "rows": parsed["rows"]})
            )
            services.database.execute(
                """
                INSERT INTO dataset_versions (
                  id, dataset_id, version_number, columns_json, row_count,
                  checksum, source_name, created_by, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    version_id,
                    dataset_id,
                    version_number,
                    json(parsed["columns"]),
                    len(parsed["rows"]),
                    version_checksum,
                    parsed["sourceName"],
                    user.id,
                    now(),
                ),
            )
            for index, row in enumerate(parsed["rows"]):
                services.database.execute(
                    """
                    INSERT INTO dataset_rows (
                      id, dataset_version_id, row_number, data_json
                    ) VALUES (?, ?, ?, ?)
                    """,
                    (str(uuid.uuid4()), version_id, index + 1, json(row)),
                )
            services.database.execute("COMMIT")
        except Exception:
            services.database.execute("ROLLBACK")
            raise
        services.database.execute(
            "UPDATE datasets SET updated_at = ? WHERE id = ?", (now(), dataset_id)
        )
        services.audit(
            project["workspace_id"],
            {"type": "user", "id": user.id},
            "dataset.version_imported",
            {"type": "dataset_version", "id": version_id},
            {
                "datasetId": dataset_id,
                "version": version_number,
                "rows": len(parsed["rows"]),
            },
            project_id,
        )
        return _send(
            Response(),
            201,
            {"version": services.dataset_version_for(project_id, version_id)},
        )

    @router.api_route(
        "/api/platform/projects/{project_id}/dataset-versions/{version_id}",
        methods=["GET"],
    )
    async def dataset_version_detail(
        request: Request, project_id: str, version_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        version = services.dataset_version_for(project_id, version_id)
        services.require_project_role(project_id, user.id)
        rows = services.dataset_rows_for(version["id"])
        return _send(
            Response(),
            200,
            {
                "version": version,
                "rows": rows[:100],
                "truncated": version["rowCount"] > 100,
            },
        )

    @router.api_route(
        "/api/platform/projects/{project_id}/schedules", methods=["GET", "POST"]
    )
    async def schedules(request: Request, project_id: str) -> Response:
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
                SELECT id, revision_id, environment_id, dataset_version_id,
                       name, cron_expression, timezone, enabled, last_run_at,
                       next_run_at, created_at, updated_at
                FROM schedules
                WHERE project_id = ? AND archived_at IS NULL
                ORDER BY created_at DESC
                """,
                (project_id,),
            ).fetchall()
            return _send(
                Response(),
                200,
                {
                    "schedules": [
                        {
                            "id": row[0],
                            "revisionId": row[1],
                            "environmentId": row[2],
                            "datasetVersionId": row[3],
                            "name": row[4],
                            "cron": row[5],
                            "timezone": row[6],
                            "enabled": bool(row[7]),
                            "lastRunAt": row[8],
                            "nextRunAt": row[9],
                            "createdAt": row[10],
                            "updatedAt": row[11],
                        }
                        for row in rows
                    ]
                },
            )

        body = await request.json()
        if not isinstance(body, dict):
            body = {}
        name = _text(body.get("name")).strip()[:160]
        cron = _text(body.get("cron")).strip()
        timezone = _text(body.get("timezone")).strip() or "Asia/Shanghai"
        if not name or not cron or not body.get("environmentId"):
            raise PlatformError(400, "SCHEDULE_INPUT_INVALID")
        revision = services.published_revision_for(
            project_id, _text(body.get("revisionId")).strip() or None
        )
        services.require_revision_environment(
            revision, _text(body.get("environmentId")).strip()
        )
        dataset_version_id = _text(body.get("datasetVersionId")).strip() or None
        if dataset_version_id:
            services.dataset_version_for(project_id, dataset_version_id)
        schedule_id = str(uuid.uuid4())
        next_run_at = next_cron_time(cron, timezone)
        created_at = now()
        services.database.execute(
            """
            INSERT INTO schedules (
              id, project_id, revision_id, environment_id, dataset_version_id,
              name, cron_expression, timezone, enabled, next_run_at,
              created_by, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
            """,
            (
                schedule_id,
                project_id,
                revision["id"],
                _text(body.get("environmentId")).strip(),
                dataset_version_id,
                name,
                cron,
                timezone,
                next_run_at,
                user.id,
                created_at,
                created_at,
            ),
        )
        services.audit(
            project["workspace_id"],
            {"type": "user", "id": user.id},
            "schedule.created",
            {"type": "schedule", "id": schedule_id},
            {
                "revisionId": revision["id"],
                "environmentId": _text(body.get("environmentId")).strip(),
                "datasetVersionId": dataset_version_id,
                "cron": cron,
                "timezone": timezone,
            },
            project_id,
        )
        return _send(
            Response(),
            201,
            {
                "schedule": {
                    "id": schedule_id,
                    "name": name,
                    "revisionId": revision["id"],
                    "environmentId": _text(body.get("environmentId")).strip(),
                    "datasetVersionId": dataset_version_id,
                    "cron": cron,
                    "timezone": timezone,
                    "enabled": True,
                    "nextRunAt": next_run_at,
                }
            },
        )

    @router.api_route(
        "/api/platform/projects/{project_id}/schedules/{schedule_id}",
        methods=["DELETE"],
    )
    async def schedule_detail(
        request: Request, project_id: str, schedule_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        result = services.require_project_capability(
            project_id, user.id, "automation.manage"
        )
        project = result["project"]
        cursor = services.database.execute(
            """
            UPDATE schedules SET archived_at = ?, enabled = 0, updated_at = ?
            WHERE id = ? AND project_id = ? AND archived_at IS NULL
            """,
            (now(), now(), schedule_id, project_id),
        )
        if cursor.rowcount == 0:
            raise PlatformError(404, "SCHEDULE_NOT_FOUND")
        services.audit(
            project["workspace_id"],
            {"type": "user", "id": user.id},
            "schedule.archived",
            {"type": "schedule", "id": schedule_id},
            {},
            project_id,
        )
        return _send(Response(), 200, {"scheduleId": schedule_id, "archived": True})

    @router.api_route(
        "/api/platform/projects/{project_id}/schedules/{schedule_id}/{action}",
        methods=["POST"],
    )
    async def schedule_action(
        request: Request, project_id: str, schedule_id: str, action: str
    ) -> Response:
        if action not in ("enable", "disable", "run"):
            raise PlatformError(404, "NOT_FOUND")
        user = services.session_user(dict(request.headers))
        result = services.require_project_capability(
            project_id, user.id, "automation.manage"
        )
        project = result["project"]
        schedule = services.database.execute(
            """
            SELECT id, revision_id, environment_id, dataset_version_id
            FROM schedules WHERE id = ? AND project_id = ? AND archived_at IS NULL
            """,
            (schedule_id, project_id),
        ).fetchone()
        if not schedule:
            raise PlatformError(404, "SCHEDULE_NOT_FOUND")
        if action == "run":
            queued = services.queue_published_runs(
                {
                    "projectId": project_id,
                    "revisionId": schedule[1],
                    "environmentId": schedule[2],
                    "datasetVersionId": schedule[3],
                    "createdBy": f"schedule:{schedule_id}",
                    "source": "schedule",
                }
            )
            services.database.execute(
                """
                UPDATE schedules SET last_run_at = ?, updated_at = ? WHERE id = ?
                """,
                (now(), now(), schedule_id),
            )
            services.audit(
                project["workspace_id"],
                {"type": "user", "id": user.id},
                "schedule.run_requested",
                {"type": "schedule", "id": schedule_id},
                {"runIds": queued["runIds"]},
                project_id,
            )
            return _send(Response(), 202, {"runIds": queued["runIds"]})

        enabled = 1 if action == "enable" else 0
        services.database.execute(
            """
            UPDATE schedules SET enabled = ?, updated_at = ? WHERE id = ?
            """,
            (enabled, now(), schedule_id),
        )
        services.audit(
            project["workspace_id"],
            {"type": "user", "id": user.id},
            "schedule.enabled" if action == "enable" else "schedule.disabled",
            {"type": "schedule", "id": schedule_id},
            {},
            project_id,
        )
        return _send(
            Response(),
            200,
            {"scheduleId": schedule_id, "enabled": action == "enable"},
        )

    @router.api_route(
        "/api/platform/projects/{project_id}/webhook-triggers",
        methods=["GET", "POST"],
    )
    async def webhook_triggers(request: Request, project_id: str) -> Response:
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
                SELECT id, revision_id, environment_id, dataset_version_id,
                       name, enabled, created_at, last_triggered_at
                FROM webhook_triggers
                WHERE project_id = ? AND archived_at IS NULL
                ORDER BY created_at DESC
                """,
                (project_id,),
            ).fetchall()
            return _send(
                Response(),
                200,
                {
                    "triggers": [
                        {
                            "id": row[0],
                            "revisionId": row[1],
                            "environmentId": row[2],
                            "datasetVersionId": row[3],
                            "name": row[4],
                            "enabled": bool(row[5]),
                            "createdAt": row[6],
                            "lastTriggeredAt": row[7],
                        }
                        for row in rows
                    ]
                },
            )

        body = await request.json()
        if not isinstance(body, dict):
            body = {}
        name = _text(body.get("name")).strip()[:160]
        if not name or not body.get("environmentId"):
            raise PlatformError(400, "WEBHOOK_TRIGGER_INPUT_INVALID")
        revision = services.published_revision_for(
            project_id, _text(body.get("revisionId")).strip() or None
        )
        services.require_revision_environment(
            revision, _text(body.get("environmentId")).strip()
        )
        dataset_version_id = _text(body.get("datasetVersionId")).strip() or None
        if dataset_version_id:
            services.dataset_version_for(project_id, dataset_version_id)
        signing_secret = f"whsec_{secrets.token_urlsafe(32)}"
        encrypted = services.encrypt(signing_secret)
        trigger_id = str(uuid.uuid4())
        created_at = now()
        services.database.execute(
            """
            INSERT INTO webhook_triggers (
              id, project_id, revision_id, environment_id, dataset_version_id,
              name, signing_secret_iv, signing_secret_tag,
              signing_secret_ciphertext, enabled, created_by, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
            """,
            (
                trigger_id,
                project_id,
                revision["id"],
                _text(body.get("environmentId")).strip(),
                dataset_version_id,
                name,
                encrypted["iv"],
                encrypted["tag"],
                encrypted["ciphertext"],
                user.id,
                created_at,
            ),
        )
        services.audit(
            project["workspace_id"],
            {"type": "user", "id": user.id},
            "webhook_trigger.created",
            {"type": "webhook_trigger", "id": trigger_id},
            {
                "revisionId": revision["id"],
                "environmentId": _text(body.get("environmentId")).strip(),
            },
            project_id,
        )
        return _send(
            Response(),
            201,
            {
                "trigger": {
                    "id": trigger_id,
                    "name": name,
                    "revisionId": revision["id"],
                    "environmentId": _text(body.get("environmentId")).strip(),
                    "datasetVersionId": dataset_version_id,
                    "enabled": True,
                    "createdAt": created_at,
                },
                "triggerUrl": f"/api/platform/webhooks/{trigger_id}",
                "signingSecret": signing_secret,
            },
        )

    @router.api_route(
        "/api/platform/projects/{project_id}/webhook-triggers/{trigger_id}",
        methods=["DELETE"],
    )
    async def webhook_trigger_detail(
        request: Request, project_id: str, trigger_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        result = services.require_project_capability(
            project_id, user.id, "automation.manage"
        )
        project = result["project"]
        cursor = services.database.execute(
            """
            UPDATE webhook_triggers SET archived_at = ?, enabled = 0
            WHERE id = ? AND project_id = ? AND archived_at IS NULL
            """,
            (now(), trigger_id, project_id),
        )
        if cursor.rowcount == 0:
            raise PlatformError(404, "WEBHOOK_TRIGGER_NOT_FOUND")
        services.audit(
            project["workspace_id"],
            {"type": "user", "id": user.id},
            "webhook_trigger.archived",
            {"type": "webhook_trigger", "id": trigger_id},
            {},
            project_id,
        )
        return _send(
            Response(), 200, {"triggerId": trigger_id, "archived": True}
        )

    @router.api_route(
        (
            "/api/platform/projects/{project_id}/webhook-triggers/"
            "{trigger_id}/{action}"
        ),
        methods=["POST"],
    )
    async def webhook_trigger_action(
        request: Request, project_id: str, trigger_id: str, action: str
    ) -> Response:
        if action not in ("enable", "disable"):
            raise PlatformError(404, "NOT_FOUND")
        user = services.session_user(dict(request.headers))
        result = services.require_project_capability(
            project_id, user.id, "automation.manage"
        )
        project = result["project"]
        enabled = 1 if action == "enable" else 0
        cursor = services.database.execute(
            """
            UPDATE webhook_triggers SET enabled = ?
            WHERE id = ? AND project_id = ?
            """,
            (enabled, trigger_id, project_id),
        )
        if cursor.rowcount == 0:
            raise PlatformError(404, "WEBHOOK_TRIGGER_NOT_FOUND")
        services.audit(
            project["workspace_id"],
            {"type": "user", "id": user.id},
            "webhook_trigger.enabled"
            if action == "enable"
            else "webhook_trigger.disabled",
            {"type": "webhook_trigger", "id": trigger_id},
            {},
            project_id,
        )
        return _send(
            Response(),
            200,
            {"triggerId": trigger_id, "enabled": action == "enable"},
        )

    @router.api_route("/api/platform/webhooks/{trigger_id}", methods=["POST"])
    async def public_webhook(request: Request, trigger_id: str) -> Response:
        headers = request.headers
        timestamp = headers.get("x-autoflow-timestamp", "")
        signature = headers.get("x-autoflow-signature", "")
        delivery_id = headers.get("x-autoflow-delivery-id", "")
        if (
            not timestamp
            or not signature
            or not delivery_id
            or not timestamp.isdigit()
            or len(timestamp) not in (10, 13)
            or len(delivery_id) > 160
        ):
            raise PlatformError(401, "WEBHOOK_SIGNATURE_REQUIRED")
        timestamp_ms = (
            int(timestamp) * 1000 if len(timestamp) == 10 else int(timestamp)
        )
        if (
            not timestamp_ms
            or abs(time.time() * 1000 - timestamp_ms)
            > WEBHOOK_TIMESTAMP_TOLERANCE_MS
        ):
            raise PlatformError(401, "WEBHOOK_TIMESTAMP_INVALID")
        body = await request.body()
        if len(body) > 1_000_000:
            raise PlatformError(413, "PAYLOAD_TOO_LARGE")
        trigger = services.database.execute(
            """
            SELECT id, project_id, revision_id, environment_id,
                   dataset_version_id, enabled, signing_secret_iv,
                   signing_secret_tag, signing_secret_ciphertext
            FROM webhook_triggers
            WHERE id = ? AND archived_at IS NULL
              AND project_id NOT IN (
                SELECT id FROM platform_projects WHERE archived_at IS NOT NULL
              )
            """,
            (trigger_id,),
        ).fetchone()
        if not trigger or not trigger[5]:
            raise PlatformError(404, "WEBHOOK_TRIGGER_NOT_FOUND")
        if not trigger[6] or not trigger[7] or not trigger[8]:
            raise PlatformError(409, "WEBHOOK_SIGNING_SECRET_REQUIRED")
        secret = services.decrypt(
            {
                "iv": trigger[6],
                "tag": trigger[7],
                "ciphertext": trigger[8],
            }
        )
        if not webhook_signature_matches(secret, timestamp, body, signature):
            raise PlatformError(401, "WEBHOOK_SIGNATURE_INVALID")
        if not services.allow_webhook_request(trigger_id):
            raise PlatformError(429, "WEBHOOK_RATE_LIMITED")
        cursor = services.database.execute(
            """
            INSERT OR IGNORE INTO webhook_deliveries (
              trigger_id, delivery_id, received_at
            ) VALUES (?, ?, ?)
            """,
            (trigger_id, delivery_id, now()),
        )
        if cursor.rowcount == 0:
            return _send(
                Response(),
                202,
                {"accepted": True, "duplicate": True, "runIds": []},
            )
        try:
            queued = services.queue_published_runs(
                {
                    "projectId": trigger[1],
                    "revisionId": trigger[2],
                    "environmentId": trigger[3],
                    "datasetVersionId": trigger[4],
                    "createdBy": f"webhook:{trigger_id}",
                    "source": "webhook",
                    "maxRuns": WEBHOOK_MAX_RUNS,
                }
            )
        except Exception:
            services.database.execute(
                """
                DELETE FROM webhook_deliveries
                WHERE trigger_id = ? AND delivery_id = ?
                """,
                (trigger_id, delivery_id),
            )
            raise
        services.database.execute(
            """
            UPDATE webhook_triggers SET last_triggered_at = ?
            WHERE id = ?
            """,
            (now(), trigger_id),
        )
        project = services.project_for(trigger[1])
        services.audit(
            project["workspace_id"],
            {"type": "system", "id": f"webhook:{trigger_id}"},
            "webhook.triggered",
            {"type": "webhook_trigger", "id": trigger_id},
            {"runIds": queued["runIds"]},
            trigger[1],
        )
        return _send(
            Response(), 202, {"accepted": True, "runIds": queued["runIds"]}
        )

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
        except Exception:
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
        methods=["DELETE"],
    )
    async def notification_channel_detail(
        request: Request, workspace_id: str, channel_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        services.require_workspace_capability(
            workspace_id, user.id, "automation.manage"
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
                WHERE s.project_id = ? AND c.archived_at IS NULL
                ORDER BY c.name
                """,
                (project_id,),
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
        rows = services.database.execute(
            """
            SELECT d.id, d.run_id, d.status, d.attempt_count, d.response_code,
                   d.error, d.created_at, d.delivered_at, c.name, c.channel_type
            FROM deliveries d
            JOIN platform_runs r ON r.id = d.run_id
            JOIN notification_channels c ON c.id = d.channel_id
            WHERE r.project_id = ?
            ORDER BY d.created_at DESC LIMIT 200
            """,
            (project_id,),
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
                ]
            },
        )

    @router.api_route(
        "/api/platform/projects/{project_id}/runs", methods=["GET", "POST"]
    )
    async def platform_runs(request: Request, project_id: str) -> Response:
        user = services.session_user(dict(request.headers))
        if request.method == "GET":
            result = services.require_project_role(project_id, user.id)
        else:
            result = services.require_project_capability(
                project_id, user.id, "run.execute"
            )
        project = result["project"]
        if request.method == "GET":
            rows = services.database.execute(
                """
                SELECT id FROM platform_runs WHERE project_id = ?
                ORDER BY created_at DESC LIMIT 200
                """,
                (project_id,),
            ).fetchall()
            return _send(
                Response(),
                200,
                {
                    "runs": [
                        services.run_response(services.run_by_id(row[0]))
                        for row in rows
                    ]
                },
            )

        body = await request.json()
        if not isinstance(body, dict):
            body = {}
        queued = services.queue_published_runs(
            {
                "projectId": project_id,
                "revisionId": _text(body.get("revisionId")).strip() or None,
                "environmentId": _text(body.get("environmentId")).strip() or None,
                "datasetVersionId": (
                    _text(body.get("datasetVersionId")).strip() or None
                ),
                "upToStepId": _text(body.get("upToStepId")).strip() or None,
                "createdBy": user.id,
                "source": "manual",
            }
        )
        runs = [
            services.run_response(services.run_by_id(run_id))
            for run_id in queued["runIds"]
        ]
        services.audit(
            project["workspace_id"],
            {"type": "user", "id": user.id},
            "run.created",
            {"type": "run_batch", "id": queued["runIds"][0] if queued["runIds"] else str(uuid.uuid4())},
            {
                "revisionId": queued["revision"]["id"],
                "environmentId": queued["environmentId"],
                "datasetVersionId": queued["datasetVersionId"],
                "runIds": queued["runIds"],
            },
            project_id,
        )
        return _send(
            Response(),
            202,
            {
                "run": runs[0] if runs else None,
                "runs": runs,
                "runIds": queued["runIds"],
            },
        )

    @router.api_route(
        "/api/platform/projects/{project_id}/runs/{run_id}",
        methods=["GET"],
    )
    async def platform_run_detail(
        request: Request, project_id: str, run_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        services.require_project_role(project_id, user.id)
        run = services.run_by_id(run_id)
        if run["projectId"] != project_id:
            raise PlatformError(404, "RUN_NOT_FOUND")
        return _send(Response(), 200, {"run": services.run_response(run)})

    @router.api_route(
        "/api/platform/projects/{project_id}/runs/{run_id}/cancel",
        methods=["POST"],
    )
    async def platform_run_cancel(
        request: Request, project_id: str, run_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        result = services.require_project_capability(
            project_id, user.id, "run.execute"
        )
        project = result["project"]
        run = services.run_by_id(run_id)
        if run["projectId"] != project_id:
            raise PlatformError(404, "RUN_NOT_FOUND")
        services.database.execute(
            """
            UPDATE platform_runs
            SET cancellation_requested = 1,
                status = CASE WHEN status = 'queued' THEN 'canceled' ELSE status END,
                updated_at = ?
            WHERE id = ?
            """,
            (now(), run["id"]),
        )
        services.cancel_managed_run(run["id"])
        services.append_run_event(
            run["id"], "run.cancel_requested", {"actorId": user.id}
        )
        return _send(
            Response(),
            202,
            {"run": services.run_response(services.run_by_id(run["id"]))},
        )

    @router.api_route(
        "/api/platform/projects/{project_id}/runs/{run_id}/retry",
        methods=["POST"],
    )
    async def platform_run_retry(
        request: Request, project_id: str, run_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        services.require_project_capability(project_id, user.id, "run.execute")
        run = services.run_by_id(run_id)
        if run["projectId"] != project_id:
            raise PlatformError(404, "RUN_NOT_FOUND")
        if run["status"] not in ("failed", "canceled"):
            raise PlatformError(409, "RUN_NOT_RETRYABLE")
        queued = services.queue_published_runs(
            {
                "projectId": project_id,
                "revisionId": run["revisionId"],
                "environmentId": run["environmentId"],
                "createdBy": user.id,
                "source": "manual",
            }
        )
        new_run_id = queued["runIds"][0]
        services.database.execute(
            "UPDATE platform_runs SET retry_of_run_id = ? WHERE id = ?",
            (run["id"], new_run_id),
        )
        services.append_run_event(
            new_run_id, "run.retried", {"priorRunId": run["id"], "actorId": user.id}
        )
        runs = [
            services.run_response(services.run_by_id(run_id))
            for run_id in queued["runIds"]
        ]
        return _send(
            Response(),
            202,
            {"runIds": queued["runIds"], "runs": runs},
        )

    @router.api_route(
        "/api/platform/projects/{project_id}/element-validations",
        methods=["POST"],
    )
    async def element_validations(request: Request, project_id: str) -> Response:
        user = services.session_user(dict(request.headers))
        result = services.require_project_capability(
            project_id, user.id, "run.execute"
        )
        project = result["project"]
        body = await request.json()
        if not isinstance(body, dict):
            body = {}
        environment_id = _text(body.get("environmentId")).strip()
        element = body.get("element")
        if not environment_id or not isinstance(element, dict):
            raise PlatformError(400, "ELEMENT_VALIDATION_INPUT_INVALID")
        validation = services.create_element_validation(
            project_id, environment_id, element, user.id
        )
        services.audit(
            project["workspace_id"],
            {"type": "user", "id": user.id},
            "element.validation_started",
            {"type": "element_validation", "id": validation["id"]},
            {
                "environmentId": environment_id,
                "elementId": element.get("id"),
            },
            project_id,
        )
        return _send(Response(), 202, {"validation": validation})

    @router.api_route(
        "/api/platform/projects/{project_id}/element-validations/{validation_id}",
        methods=["GET"],
    )
    async def element_validation_detail(
        request: Request, project_id: str, validation_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        services.require_project_role(project_id, user.id)
        validation = services.element_validation_by_id(validation_id)
        if validation["projectId"] != project_id:
            raise PlatformError(404, "ELEMENT_VALIDATION_NOT_FOUND")
        return _send(Response(), 200, {"validation": validation})

    @router.api_route(
        "/api/platform/validation-artifacts/{artifact_id}", methods=["GET"]
    )
    async def validation_artifact(
        request: Request, artifact_id: str
    ) -> FileResponse:
        user = services.session_user(dict(request.headers))
        artifact = services.database.execute(
            """
            SELECT id, name, content_type, path, project_id
            FROM element_validation_artifacts WHERE id = ?
            """,
            (artifact_id,),
        ).fetchone()
        if not artifact:
            raise PlatformError(404, "ARTIFACT_NOT_FOUND")
        services.require_project_role(artifact[4], user.id)
        path = Path(artifact[3])
        if not path.is_file():
            raise PlatformError(404, "ARTIFACT_FILE_MISSING")
        return FileResponse(
            path,
            media_type=artifact[2],
            filename=artifact[1],
        )

    @router.api_route("/api/platform/artifacts/{artifact_id}", methods=["GET"])
    async def platform_artifact(
        request: Request, artifact_id: str
    ) -> FileResponse:
        user = services.session_user(dict(request.headers))
        artifact = services.database.execute(
            """
            SELECT a.id, a.name, a.content_type, a.path, a.project_id
            FROM platform_artifacts a WHERE a.id = ?
            """,
            (artifact_id,),
        ).fetchone()
        if not artifact:
            raise PlatformError(404, "ARTIFACT_NOT_FOUND")
        services.require_project_role(artifact[4], user.id)
        path = Path(artifact[3])
        if not path.is_file():
            raise PlatformError(404, "ARTIFACT_FILE_MISSING")
        return FileResponse(
            path,
            media_type=artifact[2],
            filename=artifact[1],
        )

    @router.api_route(
        "/api/platform/projects/{project_id}/revisions", methods=["GET", "POST"]
    )
    async def revisions(request: Request, project_id: str) -> Response:
        user = services.session_user(dict(request.headers))
        if request.method == "GET":
            services.require_project_role(project_id, user.id)
        else:
            services.require_project_capability(project_id, user.id, "flow.edit")
        project = services.project_for(project_id)
        if request.method == "GET":
            rows = services.database.execute(
                """
                SELECT id, flow_id, flow_name, environment_id, revision_number,
                       status, checksum, created_by, created_at, published_at,
                       flow_snapshot
                FROM flow_revisions WHERE project_id = ?
                ORDER BY revision_number DESC
                """,
                (project_id,),
            ).fetchall()
            revisions_response = []
            for row in rows:
                flow = parse_json(row[10], {})
                steps = flow.get("steps") if isinstance(flow, dict) else []
                if not isinstance(steps, list):
                    steps = []
                revisions_response.append(
                    {
                        "id": row[0],
                        "flowId": (
                            row[1]
                            if row[1]
                            else flow.get("id")
                            if isinstance(flow, dict)
                            else None
                        ),
                        "flowName": (
                            row[2]
                            if row[2]
                            else flow.get("name")
                            if isinstance(flow, dict)
                            else None
                        ),
                        "revisionNumber": row[4],
                        "status": row[5],
                        "checksum": row[6],
                        "createdBy": row[7],
                        "createdAt": row[8],
                        "publishedAt": row[9],
                        "environmentId": row[3] or None,
                        "stepCount": len(steps),
                    }
                )
            return _send(Response(), 200, {"revisions": revisions_response})

        body = await request.json()
        if not isinstance(body, dict):
            body = {}

        def resource(resource_type: str, resource_id: str) -> dict[str, Any] | None:
            row = services.database.execute(
                """
                SELECT data FROM project_resources
                WHERE project_id = ? AND resource_type = ? AND resource_id = ?
                  AND archived_at IS NULL
                """,
                (project_id, resource_type, resource_id),
            ).fetchone()
            if not row:
                return None
            value = parse_json(row[0], {})
            return value if isinstance(value, dict) else None

        requested_flow_id = _text(body.get("flowId")).strip()
        flow_body = body.get("flow")
        if not requested_flow_id and isinstance(flow_body, dict):
            requested_flow_id = _text(flow_body.get("id")).strip()
        requested_environment_id = _text(body.get("environmentId")).strip()
        environment_body = body.get("environment")
        if not requested_environment_id and isinstance(environment_body, dict):
            requested_environment_id = _text(environment_body.get("id")).strip()
        flow = (
            as_record(flow_body)
            if isinstance(flow_body, dict)
            else resource("flows", requested_flow_id)
            if requested_flow_id
            else None
        )
        environment = (
            as_record(environment_body)
            if isinstance(environment_body, dict)
            else resource("environments", requested_environment_id)
            if requested_environment_id
            else None
        )
        if not flow or not environment:
            raise PlatformError(400, "REVISION_SNAPSHOT_INCOMPLETE")
        resource_elements = services.database.execute(
            """
            SELECT data FROM project_resources
            WHERE project_id = ? AND resource_type = 'elements'
              AND archived_at IS NULL ORDER BY updated_at
            """,
            (project_id,),
        ).fetchall()
        elements = body.get("elements")
        if not isinstance(elements, list):
            elements = [parse_json(row[0], {}) for row in resource_elements]
        services.require_chromium_environment(environment)
        flow_id = _text(flow.get("id")).strip()
        if not flow_id:
            raise PlatformError(400, "FLOW_ID_REQUIRED")
        flow_name = _text(flow.get("name")).strip()[:240]
        environment_id = _text(environment.get("id")).strip()
        if not environment_id:
            raise PlatformError(400, "REVISION_ENVIRONMENT_REQUIRED")
        secret_names = body.get("secretNames")
        secret_names = (
            [value for value in secret_names if isinstance(value, str)]
            if isinstance(secret_names, list)
            else []
        )
        dataset_version = (
            services.dataset_version_for(project_id, body["datasetVersionId"])
            if isinstance(body.get("datasetVersionId"), str)
            and body["datasetVersionId"]
            else None
        )
        dataset = (
            {
                "datasetId": dataset_version["datasetId"],
                "versionId": dataset_version["id"],
                "versionNumber": dataset_version["versionNumber"],
                "checksum": dataset_version["checksum"],
                "columns": dataset_version["columns"],
                "rowCount": dataset_version["rowCount"],
            }
            if dataset_version
            else body.get("dataset")
            if "dataset" in body
            else None
        )
        _assert_snapshot_depth(flow)
        _assert_snapshot_depth(environment)
        _assert_snapshot_depth(elements)
        _assert_snapshot_depth(dataset)
        flow_snapshot: dict[str, Any] = {**flow, "secretNames": secret_names}
        flow_step_count = (
            len(flow_snapshot["steps"]) if isinstance(flow_snapshot.get("steps"), list) else 0
        )
        snapshot = {
            "flow": flow_snapshot,
            "environment": environment,
            "elements": elements,
            "dataset": dataset,
            "secretNames": secret_names,
        }

        services.database.execute("BEGIN IMMEDIATE")
        try:
            rows = services.database.execute(
                "SELECT revision_number FROM flow_revisions WHERE project_id = ?",
                (project_id,),
            ).fetchall()
            revision_number_value = revision_number(
                [{"revision_number": row[0]} for row in rows]
            )
            revision_id = str(uuid.uuid4())
            revision_checksum = digest(json(snapshot))
            created_at = now()
            latest = services.database.execute(
                """
                SELECT id, revision_number, created_at, checksum
                FROM flow_revisions
                WHERE project_id = ? AND flow_id = ? AND environment_id = ?
                  AND status = 'published'
                ORDER BY published_at DESC LIMIT 1
                """,
                (project_id, flow_id, environment_id),
            ).fetchone()
            if latest and latest[3] == revision_checksum:
                services.database.execute("COMMIT")
                return _send(
                    Response(),
                    200,
                    {
                        "revision": {
                            "id": latest[0],
                            "flowId": flow_id,
                            "flowName": flow_name or None,
                            "environmentId": environment_id,
                            "stepCount": flow_step_count,
                            "revisionNumber": latest[1],
                            "status": "published",
                            "checksum": revision_checksum,
                            "createdAt": latest[2],
                        }
                    },
                )
            services.database.execute(
                """
                UPDATE flow_revisions SET status = 'superseded'
                WHERE project_id = ? AND flow_id = ? AND environment_id = ?
                  AND status = 'published'
                """,
                (project_id, flow_id, environment_id),
            )
            services.database.execute(
                """
                INSERT INTO flow_revisions (
                  id, project_id, flow_id, flow_name, environment_id,
                  revision_number, status, flow_snapshot, environment_snapshot,
                  element_snapshot, dataset_snapshot, checksum, created_by,
                  created_at, published_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'published', ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    revision_id,
                    project_id,
                    flow_id,
                    flow_name or None,
                    environment_id,
                    revision_number_value,
                    json(flow_snapshot),
                    json(environment),
                    json(elements),
                    json(dataset),
                    revision_checksum,
                    user.id,
                    created_at,
                    created_at,
                ),
            )
            services.database.execute("COMMIT")
        except Exception:
            services.database.execute("ROLLBACK")
            raise
        services.audit(
            project["workspace_id"],
            {"type": "user", "id": user.id},
            "flow_revision.created",
            {"type": "flow_revision", "id": revision_id},
            {"revisionNumber": revision_number_value},
            project_id,
        )
        return _send(
            Response(),
            201,
            {
                "revision": {
                    "id": revision_id,
                    "flowId": flow_id,
                    "flowName": flow_name or None,
                    "environmentId": environment_id,
                    "stepCount": flow_step_count,
                    "revisionNumber": revision_number_value,
                    "status": "published",
                    "checksum": revision_checksum,
                    "createdAt": created_at,
                }
            },
        )

    @router.api_route(
        "/api/platform/projects/{project_id}/revisions/{revision_id}/{action}",
        methods=["POST"],
    )
    async def revision_action(
        request: Request, project_id: str, revision_id: str, action: str
    ) -> Response:
        if action not in ("publish", "rollback"):
            raise PlatformError(404, "NOT_FOUND")
        user = services.session_user(dict(request.headers))
        result = services.require_project_capability(
            project_id, user.id, "release.publish"
        )
        project = result["project"]
        revision = services.database.execute(
            """
            SELECT id, status, flow_id, flow_name, environment_id,
                   flow_snapshot, environment_snapshot, element_snapshot,
                   dataset_snapshot, checksum
            FROM flow_revisions WHERE id = ? AND project_id = ?
            """,
            (revision_id, project_id),
        ).fetchone()
        if not revision:
            raise PlatformError(404, "REVISION_NOT_FOUND")
        if not revision[2] or not revision[4]:
            raise PlatformError(409, "REVISION_SCOPE_REQUIRED")
        body = await request.json()
        if not isinstance(body, dict):
            body = {}
        note = _text(body.get("note")).strip()[:2000]
        status = revision[1]
        if action == "publish":
            services.database.execute("BEGIN IMMEDIATE")
            try:
                services.database.execute(
                    """
                    UPDATE flow_revisions SET status = 'superseded'
                    WHERE project_id = ? AND flow_id = ? AND environment_id = ?
                      AND status = 'published'
                    """,
                    (project_id, revision[2], revision[4]),
                )
                services.database.execute(
                    """
                    UPDATE flow_revisions
                    SET status = 'published', published_at = ?,
                        reviewed_by = ?, review_note = ?
                    WHERE id = ?
                    """,
                    (now(), user.id, note or None, revision_id),
                )
                services.database.execute("COMMIT")
            except Exception:
                services.database.execute("ROLLBACK")
                raise
            services.audit(
                project["workspace_id"],
                {"type": "user", "id": user.id},
                "flow_revision.review_bypassed"
                if status == "draft"
                else "flow_revision.published",
                {"type": "flow_revision", "id": revision_id},
                {"note": note},
                project_id,
            )
            return _send(
                Response(), 200, {"revisionId": revision_id, "status": "published", "action": action}
            )

        rows = services.database.execute(
            "SELECT revision_number FROM flow_revisions WHERE project_id = ?",
            (project_id,),
        ).fetchall()
        rollback_id = str(uuid.uuid4())
        created_at = now()
        services.database.execute("BEGIN IMMEDIATE")
        try:
            services.database.execute(
                """
                UPDATE flow_revisions SET status = 'superseded'
                WHERE project_id = ? AND flow_id = ? AND environment_id = ?
                  AND status = 'published'
                """,
                (project_id, revision[2], revision[4]),
            )
            services.database.execute(
                """
                INSERT INTO flow_revisions (
                  id, project_id, flow_id, flow_name, environment_id,
                  revision_number, status, flow_snapshot, environment_snapshot,
                  element_snapshot, dataset_snapshot, checksum, created_by,
                  created_at, published_at, submitted_at, reviewed_by,
                  review_note
                ) VALUES (?, ?, ?, ?, ?, ?, 'published', ?, ?, ?, ?, ?, ?, ?, ?,
                          ?, ?, ?)
                """,
                (
                    rollback_id,
                    project_id,
                    revision[2],
                    revision[3] or None,
                    revision[4],
                    revision_number([{"revision_number": row[0]} for row in rows]),
                    revision[5],
                    revision[6],
                    revision[7],
                    revision[8],
                    revision[9],
                    user.id,
                    created_at,
                    created_at,
                    created_at,
                    user.id,
                    note or f"Rollback to {revision_id}",
                ),
            )
            services.database.execute("COMMIT")
        except Exception:
            services.database.execute("ROLLBACK")
            raise
        services.audit(
            project["workspace_id"],
            {"type": "user", "id": user.id},
            "flow_revision.rolled_back",
            {"type": "flow_revision", "id": rollback_id},
            {"sourceRevisionId": revision_id, "note": note},
            project_id,
        )
        return _send(
            Response(),
            201,
            {
                "revisionId": rollback_id,
                "sourceRevisionId": revision_id,
                "status": "published",
                "action": action,
            },
        )

    @router.api_route(
        "/api/platform/projects/{project_id}/secrets", methods=["GET", "POST"]
    )
    async def project_secrets(request: Request, project_id: str) -> Response:
        user = services.session_user(dict(request.headers))
        if request.method == "GET":
            services.require_project_role(project_id, user.id)
        else:
            services.require_project_capability(project_id, user.id, "secret.manage")
        if request.method == "GET":
            rows = services.database.execute(
                """
                SELECT id, name, key_version, created_at, updated_at
                FROM project_secrets WHERE project_id = ? ORDER BY name
                """,
                (project_id,),
            ).fetchall()
            return _send(
                Response(),
                200,
                {
                    "secrets": [
                        {
                            "id": row[0],
                            "name": row[1],
                            "keyVersion": row[2],
                            "createdAt": row[3],
                            "updatedAt": row[4],
                        }
                        for row in rows
                    ]
                },
            )

        body = await request.json()
        if not isinstance(body, dict):
            body = {}
        name = _text(body.get("name")).strip()
        value = body.get("value")
        if not name or not isinstance(value, str) or not value:
            raise PlatformError(400, "SECRET_INPUT_INVALID")
        encrypted = services.encrypt(value)
        existing = services.database.execute(
            """
            SELECT id, key_version, created_at FROM project_secrets
            WHERE project_id = ? AND name = ?
            """,
            (project_id, name),
        ).fetchone()
        secret_id = existing[0] if existing else str(uuid.uuid4())
        key_version = (int(existing[1]) if existing else 0) + 1
        project = services.project_for(project_id)
        services.database.execute(
            """
            INSERT INTO project_secrets (
              id, project_id, name, key_version, iv, tag, ciphertext,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(project_id, name) DO UPDATE SET
              key_version = excluded.key_version,
              iv = excluded.iv,
              tag = excluded.tag,
              ciphertext = excluded.ciphertext,
              updated_at = excluded.updated_at
            """,
            (
                secret_id,
                project_id,
                name,
                key_version,
                encrypted["iv"],
                encrypted["tag"],
                encrypted["ciphertext"],
                existing[2] if existing else now(),
                now(),
            ),
        )
        services.audit(
            project["workspace_id"],
            {"type": "user", "id": user.id},
            "secret.rotated",
            {"type": "secret", "id": secret_id},
            {"name": name, "keyVersion": key_version},
            project_id,
        )
        return _send(
            Response(),
            201,
            {"secret": {"id": secret_id, "name": name, "keyVersion": key_version}},
        )

    @router.api_route(
        "/api/platform/projects/{project_id}/audit-events", methods=["GET"]
    )
    async def audit_events(request: Request, project_id: str) -> Response:
        user = services.session_user(dict(request.headers))
        result = services.require_project_role(project_id, user.id)
        project = result["project"]
        params = request.query_params
        try:
            page = max(1, int(params.get("page", "1")))
        except (TypeError, ValueError):
            page = 1
        try:
            page_size = min(100, max(1, int(params.get("pageSize", "20"))))
        except (TypeError, ValueError):
            page_size = 20
        action = params.get("action", "").strip()
        actor_id = params.get("actorId", "").strip()
        actor_type = params.get("actorType", "").strip()
        from_value = params.get("from", "").strip()
        to_value = params.get("to", "").strip()
        q = params.get("q", "").strip()
        conditions = [
            "(project_id = ? OR (project_id IS NULL AND workspace_id = ?))"
        ]
        sql_params: list[Any] = [project_id, project["workspace_id"]]
        if action:
            conditions.append("action LIKE ?")
            sql_params.append(f"{action}%")
        if actor_id:
            conditions.append("actor_id = ?")
            sql_params.append(actor_id)
        if actor_type:
            conditions.append("actor_type = ?")
            sql_params.append(actor_type)
        if from_value:
            conditions.append("created_at >= ?")
            sql_params.append(from_value)
        if to_value:
            conditions.append("created_at <= ?")
            sql_params.append(to_value)
        if q:
            like = f"%{q}%"
            conditions.append(
                "(action LIKE ? OR target_type LIKE ? OR target_id LIKE ? OR detail LIKE ?)"
            )
            sql_params.extend([like, like, like, like])
        where = " AND ".join(conditions)
        total = services.database.execute(
            f"SELECT COUNT(*) FROM audit_events WHERE {where}", tuple(sql_params)
        ).fetchone()[0]
        rows = services.database.execute(
            f"""
            SELECT id, actor_type, actor_id, action, target_type, target_id,
                   detail, created_at
            FROM audit_events
            WHERE {where}
            ORDER BY created_at DESC LIMIT ? OFFSET ?
            """,
            tuple([*sql_params, page_size, (page - 1) * page_size]),
        ).fetchall()
        return _send(
            Response(),
            200,
            {
                "events": [
                    {
                        "id": row[0],
                        "actorType": row[1],
                        "actorId": row[2],
                        "action": row[3],
                        "targetType": row[4],
                        "targetId": row[5],
                        "detail": parse_json(row[6], {}),
                        "createdAt": row[7],
                    }
                    for row in rows
                ],
                "total": total,
                "page": page,
                "pageSize": page_size,
            },
        )

    @router.api_route(
        "/api/platform/projects/{project_id}/analytics", methods=["GET"]
    )
    async def analytics(request: Request, project_id: str) -> Response:
        user = services.session_user(dict(request.headers))
        services.require_project_role(project_id, user.id)
        params = request.query_params
        try:
            window_days = int(params.get("window", ""))
        except (TypeError, ValueError):
            window_days = 0
        try:
            limit = int(params.get("limit", ""))
        except (TypeError, ValueError):
            limit = 0
        period = "week" if params.get("period") == "week" else "day"
        raw_category = params.get("categoryBy")
        category_by = (
            raw_category
            if raw_category in ("code", "step")
            else "message"
        )
        return _send(
            Response(),
            200,
            {
                "analytics": services.project_analytics(
                    project_id,
                    {
                        "windowDays": (
                            min(365, max(1, window_days))
                            if window_days > 0
                            else None
                        ),
                        "from": params.get("from", "").strip() or None,
                        "to": params.get("to", "").strip() or None,
                        "period": period,
                        "limit": max(1, limit) if limit > 0 else None,
                        "categoryBy": category_by,
                    },
                )
            },
        )

    return router


def _client_ip(request: Request) -> str:
    if request.client:
        return request.client.host or "unknown"
    return "unknown"
