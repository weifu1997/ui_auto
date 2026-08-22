"""Dataset versions, rows, and upload parsing."""
from __future__ import annotations

import base64
import re
from typing import Any
from ..core import normalize_dataset_rows, parse_csv, parse_json, safe_artifact_name
from ._shared import (
    _read_xlsx,
)


class DatasetServices:
    """Dataset versions, rows, and upload parsing."""

    def dataset_version_for(self, project_id: str, version_id: str) -> dict[str, Any]:
        from ..http import PlatformError

        row = self.database.execute(
            """
            SELECT v.id, v.dataset_id, d.project_id, v.version_number,
                   v.columns_json, v.row_count, v.checksum, v.source_name,
                   v.created_at
            FROM dataset_versions v
            JOIN datasets d ON d.id = v.dataset_id
            WHERE v.id = ? AND d.project_id = ? AND d.archived_at IS NULL
            """,
            (version_id, project_id),
        ).fetchone()
        if not row:
            raise PlatformError(404, "DATASET_VERSION_NOT_FOUND")
        return {
            "id": row[0],
            "datasetId": row[1],
            "projectId": row[2],
            "versionNumber": row[3],
            "columns": parse_json(row[4], []),
            "rowCount": row[5],
            "checksum": row[6],
            "sourceName": row[7],
            "createdAt": row[8],
        }

    def dataset_version_response(self, row: tuple[Any, ...]) -> dict[str, Any]:
        return {
            "id": row[0],
            "datasetId": row[1],
            "projectId": row[2],
            "versionNumber": row[3],
            "columns": parse_json(row[4], []),
            "rowCount": row[5],
            "checksum": row[6],
            "sourceName": row[7],
            "createdAt": row[8],
        }

    def dataset_rows_for(self, version_id: str) -> list[dict[str, Any]]:
        rows = self.database.execute(
            """
            SELECT row_number, data_json FROM dataset_rows
            WHERE dataset_version_id = ? ORDER BY row_number ASC
            """,
            (version_id,),
        ).fetchall()
        return [
            {
                "rowNumber": row[0],
                "data": parse_json(row[1], {}),
            }
            for row in rows
        ]

    def parse_dataset_upload(
        self, file_name: str, content_base64: str
    ) -> dict[str, Any]:
        from ..http import PlatformError

        content = base64.b64decode(content_base64)
        if not content:
            raise PlatformError(400, "DATASET_FILE_EMPTY")
        if len(content) > 12_000_000:
            raise PlatformError(413, "DATASET_FILE_TOO_LARGE")
        match = re.search(r"\.([a-z0-9]+)$", file_name.lower())
        extension = match.group(1) if match else ""
        if extension not in ("csv", "xlsx"):
            raise PlatformError(400, "DATASET_FILE_TYPE_UNSUPPORTED")
        try:
            if extension == "csv":
                rows = parse_csv(content.decode("utf-8"))
            else:
                rows = _read_xlsx(content)
        except Exception as exc:
            if isinstance(exc, PlatformError):
                raise
            raise PlatformError(400, "DATASET_FILE_INVALID") from exc
        return {
            **normalize_dataset_rows(rows),
            "sourceName": safe_artifact_name(file_name),
        }
