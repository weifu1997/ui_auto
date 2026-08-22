"""Secret encryption/decryption and value resolution."""
from __future__ import annotations

from typing import Any
from ..crypto import decrypt, encrypt


class SecretServices:
    """Secret encryption/decryption and value resolution."""

    def encrypt(self, value: str) -> dict[str, str]:
        encrypted = encrypt(value, self._configured_secret)
        return {
            "iv": encrypted.iv,
            "tag": encrypted.tag,
            "ciphertext": encrypted.ciphertext,
        }

    def decrypt(self, row: dict[str, str] | Any) -> str:
        return decrypt(row, self._configured_secret)

    def missing_secret_names(
        self, project_id: str, requested: list[str]
    ) -> list[str]:
        if not requested:
            return []
        placeholders = ",".join("?" for _ in requested)
        rows = self.database.execute(
            f"""
            SELECT name FROM project_secrets
            WHERE project_id = ? AND name IN ({placeholders})
            """,
            (project_id, *requested),
        ).fetchall()
        found = {row[0] for row in rows}
        return [name for name in requested if name not in found]

    def secret_values(self, project_id: str, requested: list[str]) -> dict[str, str]:
        from ..http import PlatformError

        if not requested:
            return {}
        placeholders = ",".join("?" for _ in requested)
        rows = self.database.execute(
            f"""
            SELECT name, iv, tag, ciphertext FROM project_secrets
            WHERE project_id = ? AND name IN ({placeholders})
            """,
            (project_id, *requested),
        ).fetchall()
        if len(rows) != len(requested):
            raise PlatformError(409, "RUN_SECRET_NOT_CONFIGURED")
        project = self.project_for(project_id)
        self.audit(
            project["workspace_id"],
            {"type": "system", "id": "managed-runner"},
            "secret.decrypted_for_run",
            {"type": "project", "id": project_id},
            {"names": requested},
            project_id,
        )
        return {
            row[0]: self.decrypt({"iv": row[1], "tag": row[2], "ciphertext": row[3]})
            for row in rows
        }
