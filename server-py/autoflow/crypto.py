"""AES-256-GCM secret helpers compatible with server/platform.ts.

Key rotation (P2-2): a single master key made every stored secret unreadable
the moment an operator rotated it, with no "old key" path. Ciphertext now
carries an explicit ``v<version>.`` marker so a keyring can select the right
key to decrypt; markerless rows are legacy data from the pre-versioning era and
are resolved as version 1 (see :class:`SecretKeyring`).
"""

from __future__ import annotations

import base64
import hashlib
import os
import re
from dataclasses import dataclass

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

DEFAULT_PLATFORM_SECRET = "autoflow-development-key-change-before-production"

# Ciphertext is stored as "v<version>.<base64>". "." is not in the base64
# alphabet, so a real markerless ciphertext can never collide with a marker.
_VERSIONED_CIPHERTEXT = re.compile(r"^v([0-9]+)\.([A-Za-z0-9+/=]+)$")


class MasterKeyVersionError(ValueError):
    """A ciphertext references a master-key version this deployment lacks."""


def ciphertext_version(ciphertext: str) -> int | None:
    """Return the version marker on ``ciphertext``, or None for legacy rows."""
    match = _VERSIONED_CIPHERTEXT.match(ciphertext)
    return int(match.group(1)) if match else None


def unstamp_ciphertext(ciphertext: str) -> tuple[int | None, str]:
    """Split a stored ciphertext into ``(version, raw_base64)``.

    Legacy (markerless) rows yield ``(None, ciphertext)``.
    """
    match = _VERSIONED_CIPHERTEXT.match(ciphertext)
    if match:
        return int(match.group(1)), match.group(2)
    return None, ciphertext


def key_material(secret: str | None = None) -> bytes:
    return hashlib.sha256((secret or DEFAULT_PLATFORM_SECRET).encode("utf-8")).digest()


@dataclass(frozen=True)
class EncryptedValue:
    iv: str
    tag: str
    ciphertext: str


def encrypt(value: str, secret: str | None = None) -> EncryptedValue:
    iv = os.urandom(12)
    ciphertext_with_tag = AESGCM(key_material(secret)).encrypt(iv, value.encode("utf-8"), None)
    ciphertext = ciphertext_with_tag[:-16]
    tag = ciphertext_with_tag[-16:]
    return EncryptedValue(
        iv=base64.b64encode(iv).decode("ascii"),
        tag=base64.b64encode(tag).decode("ascii"),
        ciphertext=base64.b64encode(ciphertext).decode("ascii"),
    )


def decrypt(row: EncryptedValue | dict, secret: str | None = None) -> str:
    if isinstance(row, EncryptedValue):
        iv_text, tag_text, ciphertext_text = row.iv, row.tag, row.ciphertext
    else:
        iv_text, tag_text, ciphertext_text = row["iv"], row["tag"], row["ciphertext"]
    iv = base64.b64decode(iv_text)
    tag = base64.b64decode(tag_text)
    ciphertext = base64.b64decode(ciphertext_text)
    decrypted = AESGCM(key_material(secret)).decrypt(
        iv, ciphertext + tag, None
    )
    return decrypted.decode("utf-8")


def encrypt_bytes(value: bytes, secret: str | None = None) -> EncryptedValue:
    iv = os.urandom(12)
    ciphertext_with_tag = AESGCM(key_material(secret)).encrypt(iv, value, None)
    ciphertext = ciphertext_with_tag[:-16]
    tag = ciphertext_with_tag[-16:]
    return EncryptedValue(
        iv=base64.b64encode(iv).decode("ascii"),
        tag=base64.b64encode(tag).decode("ascii"),
        ciphertext=base64.b64encode(ciphertext).decode("ascii"),
    )


def decrypt_bytes(row: EncryptedValue | dict, secret: str | None = None) -> bytes:
    if isinstance(row, EncryptedValue):
        iv_text, tag_text, ciphertext_text = row.iv, row.tag, row.ciphertext
    else:
        iv_text, tag_text, ciphertext_text = row["iv"], row["tag"], row["ciphertext"]
    iv = base64.b64decode(iv_text)
    tag = base64.b64decode(tag_text)
    ciphertext = base64.b64decode(ciphertext_text)
    return AESGCM(key_material(secret)).decrypt(iv, ciphertext + tag, None)


class SecretKeyring:
    """Versioned master-key selection plus stamped-ciphertext IO.

    The active secret (``PLATFORM_SECRET_KEY``) has a stable ``active_version``
    (``PLATFORM_SECRET_KEY_VERSION``, default 1). ``retired`` maps every *other*
    version to the older key that may still need to decrypt rows. Resolution is
    exact — no trial decryption: a ciphertext stamped ``v<version>.`` uses that
    version's key; a markerless row is legacy data resolved as version 1.

    After a re-encryption pass rewrites rows onto the active key, the operator
    can drop the retired entries without breaking anything: the active version
    never drifts when ``retired`` shrinks.
    """

    def __init__(
        self,
        active_secret: str,
        *,
        retired: dict[int, str] | None = None,
        active_version: int = 1,
    ) -> None:
        self.active_secret = active_secret
        self.active_version = int(active_version)
        self.retired: dict[int, str] = dict(retired or {})

    def stamp(self, ciphertext_b64: str) -> str:
        return f"v{self.active_version}.{ciphertext_b64}"

    def secret_for(self, version: int | None) -> str:
        effective = 1 if version is None else version
        if effective == self.active_version:
            return self.active_secret
        secret = self.retired.get(effective)
        if secret is None:
            raise MasterKeyVersionError(
                f"ciphertext references master-key version {effective}, but only "
                f"version {self.active_version} (active) is configured; add it to "
                "PLATFORM_SECRET_KEY_VERSIONS or re-encrypt with "
                "scripts/ops/reencrypt-secrets.py"
            )
        return secret

    def decrypt_stored(self, iv_b64: str, tag_b64: str, ciphertext_b64: str) -> str:
        version, raw = unstamp_ciphertext(ciphertext_b64)
        return decrypt(
            {"iv": iv_b64, "tag": tag_b64, "ciphertext": raw},
            self.secret_for(version),
        )
