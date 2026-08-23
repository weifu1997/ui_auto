"""Run execution, batch, and run-artifact download routes."""
from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any
from fastapi import APIRouter, Request, Response
from fastapi.responses import FileResponse
from ..core import now
from ..http import PlatformError
from ..services import PlatformServices
from ._shared import (
    _batch_run_summaries,
    _send,
    _text,
)


def register(router: APIRouter, services: PlatformServices) -> None:

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
            query = request.query_params
            try:
                page = max(1, int(query.get("page", "1") or "1"))
                page_size = min(100, max(1, int(query.get("pageSize", "20") or "20")))
            except ValueError:
                raise PlatformError(400, "PAGINATION_INVALID") from None
            conditions = ["project_id = ?"]
            params: list[Any] = [project_id]
            status = _text(query.get("status")).strip()
            flow = _text(query.get("flow")).strip()
            source = _text(query.get("source")).strip()
            from_time = _text(query.get("from")).strip()
            to_time = _text(query.get("to")).strip()
            if status:
                conditions.append("status = ?")
                params.append(status)
            if flow:
                conditions.append("json_extract(snapshot, '$.flow.name') LIKE ?")
                params.append(f"%{flow}%")
            if source == "schedule":
                conditions.append("created_by LIKE 'schedule:%'")
            elif source == "webhook":
                conditions.append("created_by LIKE 'webhook:%'")
            elif source == "manual":
                conditions.append(
                    "created_by NOT LIKE 'schedule:%'"
                    " AND created_by NOT LIKE 'webhook:%'"
                )
            if from_time:
                conditions.append("created_at >= ?")
                params.append(from_time)
            if to_time:
                conditions.append("created_at <= ?")
                params.append(to_time)
            where = " AND ".join(conditions)
            total = services.database.execute(
                f"SELECT COUNT(*) FROM platform_runs WHERE {where}",
                tuple(params),
            ).fetchone()[0]
            rows = services.database.execute(
                f"""
                SELECT id FROM platform_runs
                WHERE {where}
                ORDER BY created_at DESC LIMIT ? OFFSET ?
                """,
                (*params, page_size, (page - 1) * page_size),
            ).fetchall()
            return _send(
                Response(),
                200,
                {
                    "runs": [
                        services.run_response(services.run_by_id(row[0]))
                        for row in rows
                    ],
                    "total": total,
                    "page": page,
                    "pageSize": page_size,
                },
            )

        body = await request.json()
        if not isinstance(body, dict):
            body = {}
        dispatch_key = _text(body.get("dispatchKey")).strip()
        if len(dispatch_key) > 128:
            raise PlatformError(400, "RUN_DISPATCH_KEY_INVALID")
        queued = services.queue_published_runs(
            {
                "projectId": project_id,
                "revisionId": _text(body.get("revisionId")).strip() or None,
                "flowId": _text(body.get("flowId")).strip() or None,
                "environmentId": _text(body.get("environmentId")).strip() or None,
                "datasetVersionId": (
                    _text(body.get("datasetVersionId")).strip() or None
                ),
                "upToStepId": _text(body.get("upToStepId")).strip() or None,
                "createdBy": user.id,
                "source": "manual",
                # 客户端幂等键：同一派发意图的重复提交（超时重试/双击）按 key 去重。
                "dispatchKey": dispatch_key or None,
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
        "/api/platform/projects/{project_id}/runs/batch-delete",
        methods=["POST"],
    )
    async def platform_runs_batch_delete(
        request: Request, project_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        result = services.require_project_capability(
            project_id, user.id, "run.execute"
        )
        try:
            body = await request.json()
        except Exception:
            raise PlatformError(400, "RUN_DELETE_INPUT_INVALID") from None
        raw_run_ids = body.get("runIds") if isinstance(body, dict) else None
        if (
            not isinstance(raw_run_ids, list)
            or not raw_run_ids
            or len(raw_run_ids) > 100
            or any(not isinstance(run_id, str) or not run_id.strip() for run_id in raw_run_ids)
        ):
            raise PlatformError(400, "RUN_DELETE_INPUT_INVALID")
        run_ids = list(dict.fromkeys(run_id.strip() for run_id in raw_run_ids))
        deleted = services.delete_runs(project_id, run_ids)
        services.audit(
            result["project"]["workspace_id"],
            {"type": "user", "id": user.id},
            "run.deleted",
            {"type": "run_batch", "id": str(uuid.uuid4())},
            {"runIds": deleted["runIds"], "deletedCount": deleted["deletedCount"]},
            project_id,
        )
        return _send(Response(), 200, deleted)

    @router.api_route(
        "/api/platform/projects/{project_id}/runs/{run_id}",
        methods=["GET", "DELETE"],
    )
    async def platform_run_detail(
        request: Request, project_id: str, run_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        if request.method == "DELETE":
            result = services.require_project_capability(
                project_id, user.id, "run.execute"
            )
            deleted = services.delete_run(project_id, run_id)
            services.audit(
                result["project"]["workspace_id"],
                {"type": "user", "id": user.id},
                "run.deleted",
                {"type": "run", "id": run_id},
                {"runIds": [run_id], "deletedCount": 1},
                project_id,
            )
            return _send(Response(), 200, deleted)
        services.require_project_role(project_id, user.id)
        run = services.run_by_id(run_id, project_id)
        return _send(Response(), 200, {"run": services.run_response(run)})

    @router.api_route(
        "/api/platform/projects/{project_id}/runs/{run_id}/assertion-report",
        methods=["POST"],
    )
    async def platform_run_assertion_report(
        request: Request, project_id: str, run_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        role = services.require_project_role(project_id, user.id)
        services.run_by_id(run_id, project_id)
        run_format = _text(request.query_params.get("format")) or "json"
        if run_format not in ("json", "xlsx"):
            raise PlatformError(400, "REPORT_FORMAT_INVALID")
        report = services.build_assertion_report(run_id, run_format)
        services.audit(
            role["project"]["workspace_id"],
            {"type": "user", "id": user.id},
            "run.assertion_report_exported",
            {"type": "run", "id": run_id},
            {"format": run_format, "artifactId": report["artifact"]["id"]},
            project_id,
        )
        return _send(Response(), 201, report)

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
        run = services.run_by_id(run_id, project_id)
        if run["status"] not in ("queued", "running"):
            return _send(
                Response(),
                202,
                {"run": services.run_response(run)},
            )
        if run["status"] == "queued":
            services.database.execute(
                """
                UPDATE platform_runs
                SET cancellation_requested = 1,
                    status = 'canceled',
                    updated_at = ?
                WHERE id = ? AND project_id = ? AND status = 'queued'
                """,
                (now(), run["id"], project_id),
            )
        else:
            services.database.execute(
                """
                UPDATE platform_runs
                SET cancellation_requested = 1, updated_at = ?
                WHERE id = ? AND project_id = ? AND status = 'running'
                """,
                (now(), run["id"], project_id),
            )
        services.cancel_managed_run(run["id"])
        services.append_run_event(
            run["id"], "run.cancel_requested", {"actorId": user.id}
        )
        return _send(
            Response(),
            202,
            {
                "run": services.run_response(
                    services.run_by_id(run["id"], project_id)
                )
            },
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
        run = services.run_by_id(run_id, project_id)
        if run["status"] not in ("failed", "canceled"):
            raise PlatformError(409, "RUN_NOT_RETRYABLE")
        raw_body = await request.body()
        if raw_body:
            try:
                body = json.loads(raw_body)
            except json.JSONDecodeError:
                body = {}
        else:
            body = {}
        if not isinstance(body, dict):
            body = {}
        dispatch_key = _text(body.get("dispatchKey")).strip()
        if len(dispatch_key) > 128:
            raise PlatformError(400, "RUN_DISPATCH_KEY_INVALID")
        retried = services.retry_run_snapshot(
            project_id, run_id, user.id, dispatch_key or None
        )
        return _send(
            Response(),
            202,
            {"runIds": retried["runIds"], "runs": retried["runs"]},
        )

    @router.api_route(
        "/api/platform/projects/{project_id}/run-batches",
        methods=["GET", "POST"],
    )
    async def platform_run_batches(
        request: Request, project_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        if request.method == "GET":
            services.require_project_role(project_id, user.id)
            query = request.query_params
            try:
                page = max(1, int(query.get("page", "1") or "1"))
                page_size = min(100, max(1, int(query.get("pageSize", "20") or "20")))
            except ValueError:
                raise PlatformError(400, "PAGINATION_INVALID") from None
            status = _text(query.get("status")).strip() or None
            return _send(
                Response(),
                200,
                services.run_batches_page(project_id, page, page_size, status),
            )
        result = services.require_project_capability(
            project_id, user.id, "run.execute"
        )
        project = result["project"]
        body = await request.json()
        if not isinstance(body, dict):
            body = {}
        created = services.create_run_batch(
            {
                "projectId": project_id,
                "flowIds": body.get("flowIds"),
                "environmentId": _text(body.get("environmentId")).strip(),
                "clientRequestId": _text(body.get("clientRequestId")).strip(),
                "createdBy": user.id,
            }
        )
        batch = created["batch"]
        if not created["replayed"]:
            services.audit(
                project["workspace_id"],
                {"type": "user", "id": user.id},
                "run_batch.created",
                {"type": "run_batch", "id": batch["id"]},
                {
                    "flowIds": batch["flowIds"],
                    "runIds": [run["id"] for run in created["runs"]],
                    "environmentId": batch["environmentId"],
                    "counts": batch["counts"],
                    "retryOfBatchId": batch["retryOfBatchId"],
                },
                project_id,
            )
        return _send(
            Response(),
            200 if created["replayed"] else 202,
            {"batch": batch, "runs": _batch_run_summaries(created["runs"])},
        )

    @router.api_route(
        "/api/platform/projects/{project_id}/run-batches/{batch_id}",
        methods=["GET"],
    )
    async def platform_run_batch_detail(
        request: Request, project_id: str, batch_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        services.require_project_role(project_id, user.id)
        batch = services.run_batch_by_id(project_id, batch_id)
        return _send(
            Response(),
            200,
            {
                "batch": batch,
                "runs": _batch_run_summaries(
                    services.batch_runs(project_id, batch_id)
                ),
            },
        )

    @router.api_route(
        "/api/platform/projects/{project_id}/run-batches/{batch_id}/cancel",
        methods=["POST"],
    )
    async def platform_run_batch_cancel(
        request: Request, project_id: str, batch_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        result = services.require_project_capability(
            project_id, user.id, "run.execute"
        )
        project = result["project"]
        canceled = services.cancel_run_batch(project_id, batch_id, user.id)
        if canceled["affectedQueued"] or canceled["affectedRunning"]:
            services.audit(
                project["workspace_id"],
                {"type": "user", "id": user.id},
                "run_batch.cancel_requested",
                {"type": "run_batch", "id": batch_id},
                {
                    "affectedQueued": canceled["affectedQueued"],
                    "affectedRunning": canceled["affectedRunning"],
                },
                project_id,
            )
        return _send(
            Response(),
            202,
            {
                "batch": canceled["batch"],
                "runs": _batch_run_summaries(canceled["runs"]),
            },
        )

    @router.api_route(
        "/api/platform/projects/{project_id}/run-batches/{batch_id}/retry-failed",
        methods=["POST"],
    )
    async def platform_run_batch_retry(
        request: Request, project_id: str, batch_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        result = services.require_project_capability(
            project_id, user.id, "run.execute"
        )
        project = result["project"]
        body = await request.json()
        if not isinstance(body, dict):
            body = {}
        client_request_id = _text(body.get("clientRequestId")).strip()
        if not client_request_id:
            raise PlatformError(400, "BATCH_CLIENT_REQUEST_ID_REQUIRED")
        retried = services.retry_run_batch(
            project_id, batch_id, user.id, client_request_id
        )
        if not retried["replayed"]:
            services.audit(
                project["workspace_id"],
                {"type": "user", "id": user.id},
                "run_batch.retried",
                {"type": "run_batch", "id": retried["batch"]["id"]},
                {
                    "sourceBatchId": batch_id,
                    "newBatchId": retried["batch"]["id"],
                    "retriedFlowIds": retried["batch"]["flowIds"],
                },
                project_id,
            )
        return _send(
            Response(),
            202,
            {
                "batch": retried["batch"],
                "runs": _batch_run_summaries(retried["runs"]),
            },
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
