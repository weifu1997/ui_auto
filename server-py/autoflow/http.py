"""HTTP helpers matching server/http-utils.ts."""

from __future__ import annotations

import json as _json
from typing import Any


JSON_CONTENT_TYPE = {"content-type": "application/json; charset=utf-8"}


def json(value: Any) -> str:
    """Compact JSON matching JavaScript JSON.stringify for revision checksums."""
    return _json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def parse_json(value: str | None, fallback: Any) -> Any:
    if not value:
        return fallback
    try:
        return _json.loads(value)
    except (TypeError, ValueError):
        return fallback


def send_json(status: int, body: Any) -> tuple[int, dict[str, str], str]:
    return status, JSON_CONTENT_TYPE, json(body)


def send_error(status: int, error: str) -> tuple[int, dict[str, str], str]:
    return send_json(status, {"error": error})


class PlatformError(Exception):
    def __init__(self, status: int, code: str):
        super().__init__(code)
        self.status = status
        self.code = code


class ErrorResponseOptions:
    def __init__(
        self,
        expose_message: bool = False,
        internal_code: str = "INTERNAL_ERROR",
    ):
        self.expose_message = expose_message
        self.internal_code = internal_code


def error_response(
    error: object,
    options: ErrorResponseOptions | dict[str, Any] | None = None,
) -> dict[str, object]:
    if isinstance(options, dict):
        opts = ErrorResponseOptions(**options)
    else:
        opts = options or ErrorResponseOptions()
    if isinstance(error, PlatformError):
        return {"status": error.status, "code": error.code}
    if opts.expose_message and isinstance(error, BaseException):
        message = str(error)
        if "NOT_FOUND" in message:
            return {"status": 404, "code": message}
        if message == "PAYLOAD_TOO_LARGE":
            return {"status": 413, "code": message}
        if message == "RUN_SECRETS_REQUIRED":
            return {"status": 409, "code": message}
        return {"status": 400, "code": message}
    return {"status": 500, "code": opts.internal_code}
