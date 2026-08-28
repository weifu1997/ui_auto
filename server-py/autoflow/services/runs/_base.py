"""Shared cross-mixin helpers for run services.

`redact_run_value` 被 lifecycle/report/aggregation 三个 mixin 共用，故放在 `RunServicesBase`。
"""
from __future__ import annotations

from typing import Any

class RunServicesBase:
    """Shared cross-mixin helpers for run services."""

    def redact_run_value(self, run: dict[str, Any], value: Any) -> Any:
        def failed(current: Any) -> Any:
            if isinstance(current, str):
                return "***"
            if isinstance(current, list):
                return [failed(item) for item in current]
            if isinstance(current, dict):
                return {key: failed(item) for key, item in current.items()}
            return current

        try:
            rows = self.database.execute(
                """
                SELECT name, iv, tag, ciphertext FROM project_secrets
                WHERE project_id = ?
                """,
                (run["projectId"],),
            ).fetchall()
        except Exception:
            return failed(value)

        secrets: list[str] = []
        for row in rows:
            try:
                secret = self.decrypt(
                    {"iv": row[1], "tag": row[2], "ciphertext": row[3]}
                )
            except Exception:
                continue
            if secret:
                secrets.append(secret)

        def redact(current: Any) -> Any:
            if isinstance(current, str):
                result = current
                for secret in secrets:
                    result = result.replace(secret, "***")
                return result
            if isinstance(current, list):
                return [redact(item) for item in current]
            if isinstance(current, dict):
                return {key: redact(item) for key, item in current.items()}
            return current

        return redact(value)
