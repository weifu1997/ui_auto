"""Secret encryption/decryption and value resolution."""
from __future__ import annotations

from typing import Any
from ..core import now
from ..crypto import (
    MasterKeyVersionError,
    SecretKeyring,
    ciphertext_version,
    encrypt,
)


class SecretServices:
    """Secret encryption/decryption and value resolution."""

    @property
    def _keyring(self) -> SecretKeyring:
        return self._secret_keyring

    def encrypt(self, value: str) -> dict[str, str]:
        encrypted = encrypt(value, self._configured_secret)
        # 密文带当前主密钥版本前缀，旋转后按版本精确寻 key 双读。
        return {
            "iv": encrypted.iv,
            "tag": encrypted.tag,
            "ciphertext": self._keyring.stamp(encrypted.ciphertext),
        }

    def decrypt(self, row: dict[str, str] | Any) -> str:
        from ..http import PlatformError

        try:
            return self._keyring.decrypt_stored(
                row["iv"], row["tag"], row["ciphertext"]
            )
        except MasterKeyVersionError as error:
            raise PlatformError(500, "SECRET_MASTER_KEY_VERSION_MISSING") from error

    def reencrypt_secrets_to_active_master_key(
        self, dry_run: bool = False
    ) -> dict[str, int]:
        """Rewrite every stored secret to the active master key.

        Covers project_secrets, webhook signing secrets, and notification
        channel configs — the three tables that persist ``iv/tag/ciphertext``
        tuples through :meth:`encrypt`/:meth:`decrypt`. Rows already stamped
        with the active version are left untouched. Returns per-store counts.
        """
        keyring = self._keyring
        active = keyring.active_version
        counts = {
            "projectSecrets": 0,
            "webhookSigningSecrets": 0,
            "notificationChannelConfigs": 0,
        }

        def _reencrypt(value: str) -> dict[str, str]:
            encrypted = encrypt(value, self._configured_secret)
            return {
                "iv": encrypted.iv,
                "tag": encrypted.tag,
                "ciphertext": keyring.stamp(encrypted.ciphertext),
            }

        def _stale(ciphertext: str) -> bool:
            version = ciphertext_version(ciphertext)
            return version is None or version != active

        if not dry_run:
            self.database.execute("BEGIN IMMEDIATE")
        try:
            self._reencrypt_rows(counts, active, dry_run, _stale, _reencrypt)
        except Exception:
            if not dry_run:
                self.database.execute("ROLLBACK")
            raise
        if not dry_run:
            self.database.execute("COMMIT")
        return counts

    def _reencrypt_rows(
        self,
        counts: dict[str, int],
        active: int,
        dry_run: bool,
        _stale,
        _reencrypt,
    ) -> None:
        rows = self.database.execute(
            "SELECT id, iv, tag, ciphertext FROM project_secrets"
        ).fetchall()
        for secret_id, iv, tag, ciphertext in rows:
            if not _stale(ciphertext):
                continue
            value = self.decrypt({"iv": iv, "tag": tag, "ciphertext": ciphertext})
            fresh = _reencrypt(value)
            if not dry_run:
                self.database.execute(
                    """
                    UPDATE project_secrets
                    SET iv = ?, tag = ?, ciphertext = ?, key_version = ?,
                        updated_at = ?
                    WHERE id = ?
                    """,
                    (
                        fresh["iv"],
                        fresh["tag"],
                        fresh["ciphertext"],
                        active,
                        now(),
                        secret_id,
                    ),
                )
            counts["projectSecrets"] += 1

        webhook_rows = self.database.execute(
            """
            SELECT id, signing_secret_iv, signing_secret_tag, signing_secret_ciphertext
            FROM webhook_triggers
            WHERE signing_secret_ciphertext IS NOT NULL
            """
        ).fetchall()
        for hook_id, iv, tag, ciphertext in webhook_rows:
            if not _stale(ciphertext):
                continue
            value = self.decrypt({"iv": iv, "tag": tag, "ciphertext": ciphertext})
            fresh = _reencrypt(value)
            if not dry_run:
                self.database.execute(
                    """
                    UPDATE webhook_triggers
                    SET signing_secret_iv = ?, signing_secret_tag = ?,
                        signing_secret_ciphertext = ?
                    WHERE id = ?
                    """,
                    (fresh["iv"], fresh["tag"], fresh["ciphertext"], hook_id),
                )
            counts["webhookSigningSecrets"] += 1

        channel_rows = self.database.execute(
            """
            SELECT id, config_iv, config_tag, config_ciphertext
            FROM notification_channels
            """
        ).fetchall()
        for channel_id, iv, tag, ciphertext in channel_rows:
            if not _stale(ciphertext):
                continue
            value = self.decrypt({"iv": iv, "tag": tag, "ciphertext": ciphertext})
            fresh = _reencrypt(value)
            if not dry_run:
                self.database.execute(
                    """
                    UPDATE notification_channels
                    SET config_iv = ?, config_tag = ?, config_ciphertext = ?,
                        updated_at = ?
                    WHERE id = ?
                    """,
                    (fresh["iv"], fresh["tag"], fresh["ciphertext"], now(), channel_id),
                )
            counts["notificationChannelConfigs"] += 1

        return counts

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
