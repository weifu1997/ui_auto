"""Revision publish/promote routes."""
from __future__ import annotations

import uuid
from typing import Any
from fastapi import APIRouter, Request, Response
from ..core import json, now, parse_json
from ..http import PlatformError
from ..resources import as_record
from ..revisions import revision_number
from ..revision_snapshot import canonical_checksum
from ..services import PlatformServices
from ._shared import (
    _assert_revision_secret_safety,
    _assert_snapshot_depth,
    _send,
    _text,
)


def register(router: APIRouter, services: PlatformServices) -> None:

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
        _assert_revision_secret_safety(flow, secret_names)
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
            revision_checksum = canonical_checksum(
                flow,
                environment,
                elements,
                dataset,
                secret_names,
            )
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
                    WHERE id = ? AND project_id = ?
                    """,
                    (now(), user.id, note or None, revision_id, project_id),
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
