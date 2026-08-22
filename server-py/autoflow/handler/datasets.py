"""Dataset and dataset-version routes."""
from __future__ import annotations

import sqlite3
import uuid
from fastapi import APIRouter, Request, Response
from ..core import digest, json, now, parse_json
from ..http import PlatformError
from ..services import PlatformServices
from ._shared import (
    _send,
    _text,
)


def register(router: APIRouter, services: PlatformServices) -> None:

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
            if isinstance(exc, sqlite3.IntegrityError):
                raise PlatformError(409, "DATASET_NAME_EXISTS") from exc
            raise
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
            "UPDATE datasets SET updated_at = ? WHERE id = ? AND project_id = ?",
            (now(), dataset_id, project_id),
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
        services.require_project_role(project_id, user.id)
        version = services.dataset_version_for(project_id, version_id)
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
