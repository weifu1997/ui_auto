"""Authentication helpers matching server/platform-auth.ts."""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
from email.utils import formatdate
from urllib.parse import quote


def _b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _b64url_decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def password_hash(password: str) -> str:
    if len(password) > 1024:
        raise ValueError("PASSWORD_TOO_LONG")
    salt = os.urandom(16)
    derived = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=16384,
        r=8,
        p=1,
        dklen=64,
        maxmem=64 * 1024 * 1024,
    )
    return f"{_b64url(salt)}:{_b64url(derived)}"


def password_matches(password: str, encoded: str) -> bool:
    salt_text, _, hash_text = encoded.partition(":")
    if not salt_text or not hash_text:
        return False
    try:
        salt = _b64url_decode(salt_text)
        expected = _b64url_decode(hash_text)
        actual = hashlib.scrypt(
            password.encode("utf-8"),
            salt=salt,
            n=16384,
            r=8,
            p=1,
            dklen=len(expected),
            maxmem=64 * 1024 * 1024,
        )
        return len(actual) == len(expected) and hmac.compare_digest(actual, expected)
    except Exception:
        return False


def _secure_cookie() -> str:
    # SEC-01：Secure 默认开启。服务部署在经批准的 HTTPS 终止之后；仅本地 HTTP 调试时
    # 通过 AUTOFLOW_COOKIE_SECURE=0 显式关闭。
    return (
        ""
        if os.environ.get("AUTOFLOW_COOKIE_SECURE") == "0"
        else "; Secure"
    )


def set_session_cookie(token: str, expires_at: str) -> str:
    expires = formatdate(
        _parse_iso(expires_at).timestamp(),
        usegmt=True,
    )
    return (
        f"autoflow_session={quote(token, safe='')}; Path=/api; HttpOnly; "
        f"SameSite=Strict; Expires={expires}{_secure_cookie()}"
    )


def clear_session_cookie() -> str:
    return f"autoflow_session=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0{_secure_cookie()}"


def _parse_iso(value: str):
    from datetime import datetime, timezone
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    return datetime.fromisoformat(value).astimezone(timezone.utc)
