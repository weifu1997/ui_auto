"""Webhook trigger routes and the signed public webhook endpoint."""
from __future__ import annotations

import secrets
import time
import uuid
from fastapi import APIRouter, Request, Response
from ..core import WEBHOOK_MAX_RUNS, WEBHOOK_TIMESTAMP_TOLERANCE_MS, now, webhook_signature_matches
from ..http import PlatformError
from ..services import PlatformServices
from ._shared import (
    _send,
    _text,
)


def register(router: APIRouter, services: PlatformServices) -> None:

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
        methods=["PUT", "DELETE"],
    )
    async def webhook_trigger_detail(
        request: Request, project_id: str, trigger_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        result = services.require_project_capability(
            project_id, user.id, "automation.manage"
        )
        project = result["project"]
        if request.method == "PUT":
            body = await request.json()
            if not isinstance(body, dict):
                body = {}
            name = _text(body.get("name")).strip()[:160]
            environment_id = _text(body.get("environmentId")).strip()
            if not name or not environment_id:
                raise PlatformError(400, "WEBHOOK_TRIGGER_INPUT_INVALID")
            revision = services.published_revision_for(
                project_id, _text(body.get("revisionId")).strip() or None
            )
            services.require_revision_environment(revision, environment_id)
            dataset_version_id = (
                _text(body.get("datasetVersionId")).strip() or None
            )
            if dataset_version_id:
                services.dataset_version_for(project_id, dataset_version_id)
            cursor = services.database.execute(
                """
                UPDATE webhook_triggers
                SET revision_id = ?, environment_id = ?,
                    dataset_version_id = ?, name = ?
                WHERE id = ? AND project_id = ? AND archived_at IS NULL
                """,
                (
                    revision["id"],
                    environment_id,
                    dataset_version_id,
                    name,
                    trigger_id,
                    project_id,
                ),
            )
            if cursor.rowcount == 0:
                raise PlatformError(404, "WEBHOOK_TRIGGER_NOT_FOUND")
            services.audit(
                project["workspace_id"],
                {"type": "user", "id": user.id},
                "webhook_trigger.updated",
                {"type": "webhook_trigger", "id": trigger_id},
                {
                    "revisionId": revision["id"],
                    "environmentId": environment_id,
                    "datasetVersionId": dataset_version_id,
                },
                project_id,
            )
            return _send(
                Response(),
                200,
                {
                    "trigger": {
                        "id": trigger_id,
                        "name": name,
                        "revisionId": revision["id"],
                        "environmentId": environment_id,
                        "datasetVersionId": dataset_version_id,
                    }
                },
            )
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
            "{trigger_id}/rotate-secret"
        ),
        methods=["POST"],
    )
    async def webhook_rotate_secret(
        request: Request, project_id: str, trigger_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        result = services.require_project_capability(
            project_id, user.id, "automation.manage"
        )
        project = result["project"]
        existing = services.database.execute(
            """
            SELECT id FROM webhook_triggers
            WHERE id = ? AND project_id = ? AND archived_at IS NULL
            """,
            (trigger_id, project_id),
        ).fetchone()
        if not existing:
            raise PlatformError(404, "WEBHOOK_TRIGGER_NOT_FOUND")
        signing_secret = f"whsec_{secrets.token_urlsafe(32)}"
        encrypted = services.encrypt(signing_secret)
        services.database.execute(
            """
            UPDATE webhook_triggers
            SET signing_secret_iv = ?, signing_secret_tag = ?,
                signing_secret_ciphertext = ?
            WHERE id = ? AND project_id = ?
            """,
            (
                encrypted["iv"],
                encrypted["tag"],
                encrypted["ciphertext"],
                trigger_id,
                project_id,
            ),
        )
        services.audit(
            project["workspace_id"],
            {"type": "user", "id": user.id},
            "webhook_trigger.secret_rotated",
            {"type": "webhook_trigger", "id": trigger_id},
            {},
            project_id,
        )
        return _send(
            Response(),
            200,
            {"triggerId": trigger_id, "signingSecret": signing_secret},
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
            WHERE id = ? AND project_id = ?
            """,
            (now(), trigger_id, trigger[1]),
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
