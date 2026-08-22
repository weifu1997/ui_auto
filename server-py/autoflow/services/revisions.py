"""Published revision resolution and environment binding."""
from __future__ import annotations

from typing import Any
from ..core import parse_json


class RevisionServices:
    """Published revision resolution and environment binding."""

    def published_revision_for(
        self,
        project_id: str,
        revision_id: str | None = None,
        *,
        flow_id: str | None = None,
        environment_id: str | None = None,
        allow_superseded: bool = False,
    ) -> dict[str, Any]:
        from ..http import PlatformError

        flow_context_id = flow_id or None
        if revision_id:
            statuses = (
                ("published", "superseded") if allow_superseded else ("published",)
            )
            status_filter = ",".join("?" for _ in statuses)
            row = self.database.execute(
                f"""
                SELECT id, flow_snapshot, environment_snapshot,
                       element_snapshot, dataset_snapshot, checksum, flow_id
                FROM flow_revisions
                WHERE id = ? AND project_id = ?
                  AND status IN ({status_filter})
                """,
                (revision_id, project_id, *statuses),
            ).fetchone()
            if not row:
                raise PlatformError(409, "PUBLISHED_REVISION_REQUIRED")
            revision_flow_id = (
                row[6] if isinstance(row[6], str) and row[6] else None
            )
            if revision_flow_id is None:
                snapshot_flow = parse_json(row[1], {})
                snapshot_flow_id = (
                    snapshot_flow.get("id")
                    if isinstance(snapshot_flow, dict)
                    else None
                )
                revision_flow_id = (
                    snapshot_flow_id
                    if isinstance(snapshot_flow_id, str)
                    else None
                )
            if (
                flow_context_id
                and revision_flow_id
                and flow_context_id != revision_flow_id
            ):
                raise PlatformError(409, "REVISION_FLOW_MISMATCH")
        else:
            if not flow_context_id:
                raise PlatformError(400, "FLOW_ID_REQUIRED")
            environment_filter = ""
            query_params: list[Any] = [project_id, flow_context_id]
            if environment_id:
                environment_filter = " AND environment_id = ?"
                query_params.append(environment_id)
            row = self.database.execute(
                f"""
                SELECT id, flow_snapshot, environment_snapshot,
                       element_snapshot, dataset_snapshot, checksum, flow_id
                FROM flow_revisions
                WHERE project_id = ? AND flow_id = ? AND status = 'published'
                  {environment_filter}
                ORDER BY published_at DESC, revision_number DESC, created_at DESC
                LIMIT 1
                """,
                tuple(query_params),
            ).fetchone()
            if not row:
                raise PlatformError(409, "PUBLISHED_REVISION_REQUIRED")
        return {
            "id": row[0],
            "flow_snapshot": row[1],
            "environment_snapshot": row[2],
            "element_snapshot": row[3],
            "dataset_snapshot": row[4],
            "checksum": row[5],
            "flow_id": row[6],
        }

    def require_revision_environment(
        self, revision: dict[str, Any], environment_id: str
    ) -> None:
        from ..http import PlatformError

        environment = parse_json(revision["environment_snapshot"], {})
        snapshot_id = environment.get("id") if isinstance(environment, dict) else ""
        if snapshot_id != environment_id:
            raise PlatformError(409, "REVISION_ENVIRONMENT_MISMATCH")
