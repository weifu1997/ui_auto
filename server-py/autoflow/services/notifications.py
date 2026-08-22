"""Notification targets, payload assembly, and delivery."""
from __future__ import annotations

import uuid
import ipaddress
import socket
from urllib.parse import urlsplit
from typing import Any
from ..core import json, notification_rejection_code, now, parse_json
from ..resources import as_record
from ._shared import (
    _format_notification_body,
    _iso_from_ms,
    _now_ms,
    _post_notification,
)


class NotificationServices:
    """Notification targets, payload assembly, and delivery."""

    def notification_target(self, value: str) -> dict[str, str]:
        from urllib.parse import urlsplit

        from ..core import (
            ALLOW_INSECURE_NOTIFICATION_TARGETS,
            ALLOW_PRIVATE_NOTIFICATION_TARGETS,
            NOTIFICATION_HOST_ALLOWLIST,
            notification_host_allowed_list,
            public_ip_address,
        )

        target = urlsplit(value)
        if target.username or target.password:
            raise ValueError("NOTIFICATION_URL_CREDENTIALS_FORBIDDEN")
        if target.scheme != "https" and not (
            ALLOW_INSECURE_NOTIFICATION_TARGETS and target.scheme == "http"
        ):
            raise ValueError("NOTIFICATION_URL_PROTOCOL_FORBIDDEN")
        host = (target.hostname or "").lower()
        explicitly_allowed = notification_host_allowed_list(host)
        if NOTIFICATION_HOST_ALLOWLIST and not explicitly_allowed:
            raise ValueError("NOTIFICATION_URL_HOST_NOT_ALLOWED")
        if (
            not ALLOW_PRIVATE_NOTIFICATION_TARGETS or not explicitly_allowed
        ) and (
            host == "localhost"
            or host.endswith(".localhost")
            or host.endswith(".local")
        ):
            raise ValueError("NOTIFICATION_URL_PRIVATE_HOST")
        try:
            ipaddress.ip_address(host)
            addresses = [host]
        except ValueError:
            addresses = [
                entry[4][0]
                for entry in socket.getaddrinfo(host, target.port or None)
            ]
        if (
            not ALLOW_PRIVATE_NOTIFICATION_TARGETS or not explicitly_allowed
        ) and (
            not addresses
            or any(not public_ip_address(address) for address in addresses)
        ):
            raise ValueError("NOTIFICATION_URL_PRIVATE_HOST")
        if not addresses:
            raise ValueError("NOTIFICATION_URL_HOST_UNRESOLVED")
        return {"url": value, "address": addresses[0]}

    def deliver_pending_notifications(self) -> None:
        from ..core import (
            NOTIFICATION_MAX_ATTEMPTS,
            NOTIFICATION_RETRY_BASE_MS,
        )

        stale_claim = _iso_from_ms(_now_ms() - 30_000)
        stale_rows = self.database.execute(
            """
            SELECT id, attempt_count FROM deliveries
            WHERE status = 'delivering' AND updated_at <= ?
            """,
            (stale_claim,),
        ).fetchall()
        for row in stale_rows:
            attempts = int(row[1]) + 1
            delay_ms = NOTIFICATION_RETRY_BASE_MS * 2 ** max(0, attempts - 1)
            self.database.execute(
                """
                UPDATE deliveries
                SET status = 'retrying', next_attempt_at = ?, updated_at = ?
                WHERE id = ? AND status = 'delivering'
                """,
                (_iso_from_ms(_now_ms() + delay_ms), now(), row[0]),
            )

        due_rows = self.database.execute(
            """
            SELECT d.id, d.run_id, d.channel_id, d.payload, d.attempt_count,
                   c.channel_type, c.name AS channel_name, c.workspace_id,
                   c.config_iv, c.config_tag, c.config_ciphertext
            FROM deliveries d
            JOIN notification_channels c ON c.id = d.channel_id
            WHERE d.status IN ('pending', 'retrying') AND c.enabled = 1
              AND COALESCE(d.next_attempt_at, d.created_at) <= ?
            ORDER BY d.created_at ASC LIMIT 20
            """,
            (now(),),
        ).fetchall()
        for delivery in due_rows:
            claimed = self.database.execute(
                """
                UPDATE deliveries
                SET status = 'delivering', attempt_count = attempt_count + 1,
                    updated_at = ?
                WHERE id = ? AND status IN ('pending', 'retrying')
                """,
                (now(), delivery[0]),
            )
            if claimed.rowcount != 1:
                continue
            status = "failed"
            response_code: int | None = None
            error: str | None = None
            try:
                config = parse_json(
                    self.decrypt(
                        {
                            "iv": delivery[8],
                            "tag": delivery[9],
                            "ciphertext": delivery[10],
                        }
                    ),
                    {},
                )
                endpoint = config.get("url") if isinstance(config, dict) else None
                if not isinstance(endpoint, str):
                    raise ValueError("NOTIFICATION_CONFIG_INVALID")
                target = self.notification_target(endpoint)
                headers = as_record(config.get("headers"))
                string_headers = {
                    str(key): str(value)
                    for key, value in headers.items()
                    if isinstance(value, str)
                }
                keyword = config.get("keyword")
                keyword = (
                    keyword.strip()[:200]
                    if isinstance(keyword, str) and keyword.strip()
                    else None
                )
                response = _post_notification(
                    target,
                    string_headers,
                    json(
                        _format_notification_body(
                            delivery[5], parse_json(delivery[3], {}), keyword
                        )
                    ),
                )
                response_code = response["status"]
                status = (
                    "delivered"
                    if 200 <= response_code < 300
                    else "failed"
                )
                error = None if status == "delivered" else f"HTTP_{response_code}"
                if status == "delivered" and response["body"]:
                    body_code = notification_rejection_code(response["body"])
                    if body_code is not None:
                        status = "failed"
                        error = f"NOTIFICATION_REJECTED_{body_code}"
            except Exception as exc:
                error = (
                    "NOTIFICATION_TIMEOUT"
                    if isinstance(exc, TimeoutError)
                    else str(exc)[:200]
                )
            attempts = int(delivery[4]) + 1
            retry = status == "failed" and attempts < NOTIFICATION_MAX_ATTEMPTS
            next_attempt_at = (
                _iso_from_ms(
                    _now_ms()
                    + NOTIFICATION_RETRY_BASE_MS * 2 ** max(0, attempts - 1)
                )
                if retry
                else None
            )
            self.database.execute(
                """
                UPDATE deliveries
                SET status = ?, attempt_count = ?, response_code = ?,
                    error = ?, next_attempt_at = ?,
                    delivered_at = CASE WHEN ? = 'delivered' THEN ?
                      ELSE delivered_at END,
                    updated_at = ?
                WHERE id = ? AND status = 'delivering'
                """,
                (
                    "retrying" if retry else status,
                    attempts,
                    response_code,
                    error,
                    next_attempt_at,
                    status,
                    now(),
                    now(),
                    delivery[0],
                ),
            )
            if retry:
                continue
            delivery_project = self.database.execute(
                "SELECT project_id FROM platform_runs WHERE id = ?",
                (delivery[1],),
            ).fetchone()
            delivery_action = (
                "notification.delivered"
                if status == "delivered"
                else "notification.rejected"
                if error and error.startswith("NOTIFICATION_REJECTED_")
                else "notification.failed"
            )
            self.audit(
                delivery[7],
                {"type": "system", "id": f"delivery:{delivery[0]}"},
                delivery_action,
                {"type": "notification_channel", "id": delivery[2]},
                {
                    "channelType": delivery[5],
                    "channelName": delivery[6],
                    "code": response_code,
                    "error": (error or "")[:200] or None,
                },
                delivery_project[0] if delivery_project else None,
            )

    def send_test_notification(
        self, channel_id: str, workspace_id: str | None = None
    ) -> dict[str, Any]:
        from ..http import PlatformError

        row = self.database.execute(
            """
            SELECT id, channel_type, config_iv, config_tag, config_ciphertext
            FROM notification_channels
            WHERE id = ? AND archived_at IS NULL
              AND (? IS NULL OR workspace_id = ?)
            """,
            (channel_id, workspace_id, workspace_id),
        ).fetchone()
        if not row:
            raise PlatformError(404, "NOTIFICATION_CHANNEL_NOT_FOUND")
        config = parse_json(
            self.decrypt(
                {
                    "iv": row[2],
                    "tag": row[3],
                    "ciphertext": row[4],
                }
            ),
            {},
        )
        endpoint = config.get("url") if isinstance(config, dict) else None
        if not isinstance(endpoint, str):
            raise PlatformError(400, "NOTIFICATION_CONFIG_INVALID")
        target = self.notification_target(endpoint)
        headers = as_record(config.get("headers"))
        string_headers = {
            str(key): str(value)
            for key, value in headers.items()
            if isinstance(value, str)
        }
        response = _post_notification(
            target,
            string_headers,
            json(
                {
                    "type": "test",
                    "message": "AutoFlow test notification",
                    "timestamp": now(),
                }
            ),
        )
        status = response["status"]
        error = None if 200 <= status < 300 else f"HTTP_{status}"
        if error is None and response.get("body"):
            body_code = notification_rejection_code(response["body"])
            if body_code is not None:
                error = f"NOTIFICATION_REJECTED_{body_code}"
        return {"status": status, "error": error}

    def notification_payload(
        self,
        run: dict[str, Any],
        status: str,
    ) -> dict[str, Any]:
        latest_failure = self.database.execute(
            """
            SELECT kind, data FROM platform_run_events
            WHERE run_id = ? AND (kind LIKE '%failed%' OR kind LIKE '%error%')
            ORDER BY id DESC LIMIT 1
            """,
            (run["id"],),
        ).fetchone()
        artifacts = self.database.execute(
            """
            SELECT id, name FROM platform_artifacts
            WHERE run_id = ? ORDER BY created_at ASC
            """,
            (run["id"],),
        ).fetchall()
        return {
            "runId": run["id"],
            "projectId": run["projectId"],
            "status": status,
            "environmentId": run["environmentId"],
            "revisionId": run["revisionId"],
            "agentId": run["agentId"],
            "failedStep": (
                {
                    "kind": latest_failure[0],
                    "data": self.redact_run_value(
                        run, parse_json(latest_failure[1], {})
                    ),
                }
                if latest_failure
                else None
            ),
            "artifacts": [
                {"id": row[0], "name": row[1]} for row in artifacts
            ],
            "retry": {"cancellationRequested": run["cancellationRequested"]},
            "completedAt": now(),
        }

    def queue_run_deliveries(self, run: dict[str, Any], status: str) -> None:
        if status not in ("success", "failed", "canceled"):
            return
        project = self.project_for(run["projectId"])
        subscriptions = self.database.execute(
            """
            SELECT c.id FROM notification_subscriptions s
            JOIN notification_channels c ON c.id = s.channel_id
            WHERE s.project_id = ? AND c.workspace_id = ? AND c.enabled = 1
              AND c.archived_at IS NULL
              AND ((? = 'success' AND s.on_success = 1)
                   OR (? != 'success' AND s.on_failure = 1))
            """,
            (run["projectId"], project["workspace_id"], status, status),
        ).fetchall()
        payload = json(self.notification_payload(run, status))
        for subscription in subscriptions:
            self.database.execute(
                """
                INSERT INTO deliveries (
                  id, channel_id, run_id, status, payload, next_attempt_at,
                  created_at, updated_at
                )
                SELECT ?, ?, ?, 'pending', ?, ?, ?, ?
                WHERE NOT EXISTS (
                  SELECT 1 FROM deliveries WHERE channel_id = ? AND run_id = ?
                )
                """,
                (
                    str(uuid.uuid4()),
                    subscription[0],
                    run["id"],
                    payload,
                    now(),
                    now(),
                    now(),
                    subscription[0],
                    run["id"],
                ),
            )
        self.deliver_pending_notifications()
