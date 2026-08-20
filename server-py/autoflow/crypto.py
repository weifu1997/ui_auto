"""AES-256-GCM secret helpers compatible with server/platform.ts."""

from __future__ import annotations

import base64
import hashlib
import os
from dataclasses import dataclass

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


DEFAULT_PLATFORM_SECRET = "autoflow-development-key-change-before-production"


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
