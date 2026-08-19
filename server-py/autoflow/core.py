"""Pure core functions matching server/platform-core.ts."""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json as _json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from .http import PlatformError, parse_json
from .resources import as_record
from .automations import notification_host_allowed
from .auth import password_hash, password_matches  # noqa: F401
from .projects import clean_project_slug  # noqa: F401
from .revisions import revision_number  # noqa: F401
from .workspaces import role_has_capability  # noqa: F401


JSON_CONTENT_TYPE = {"content-type": "application/json; charset=utf-8"}

WEBHOOK_TIMESTAMP_TOLERANCE_MS = int(
    os.environ.get("WEBHOOK_TIMESTAMP_TOLERANCE_MS", "300000")
)
WEBHOOK_RATE_LIMIT_PER_MINUTE = int(
    os.environ.get("WEBHOOK_RATE_LIMIT_PER_MINUTE", "10")
)
WEBHOOK_MAX_RUNS = int(os.environ.get("WEBHOOK_MAX_RUNS", "100"))
NOTIFICATION_MAX_ATTEMPTS = max(
    1, int(os.environ.get("NOTIFICATION_MAX_ATTEMPTS", "5"))
)
NOTIFICATION_RETRY_BASE_MS = max(
    1000, int(os.environ.get("NOTIFICATION_RETRY_BASE_MS", "30000"))
)
ALLOW_PRIVATE_NOTIFICATION_TARGETS = (
    os.environ.get("PLATFORM_ALLOW_PRIVATE_NOTIFICATION_URLS") == "1"
)
ALLOW_INSECURE_NOTIFICATION_TARGETS = (
    os.environ.get("PLATFORM_ALLOW_INSECURE_NOTIFICATION_URLS") == "1"
)
NOTIFICATION_HOST_ALLOWLIST = [
    host.strip().lower()
    for host in os.environ.get("PLATFORM_NOTIFICATION_HOST_ALLOWLIST", "").split(",")
    if host.strip()
]


def notification_host_allowed_list(host: str, allowlist: list[str] | None = None) -> bool:
    return notification_host_allowed(
        host, NOTIFICATION_HOST_ALLOWLIST if allowlist is None else allowlist
    )


def now() -> str:
    value = datetime.now(timezone.utc)
    return value.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def json(value: Any) -> str:
    return _json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def parse(value: str | None, fallback: Any) -> Any:
    return parse_json(value, fallback)


def notification_rejection_code(value: str | None) -> int | None:
    body = parse_json(value, {})
    if not isinstance(body, dict):
        return None
    for key in ("code", "errcode"):
        code = body.get(key)
        if isinstance(code, int) and code != 0:
            return code
    return None


def authorization(headers: dict[str, str] | None) -> str | None:
    headers = headers or {}
    auth = headers.get("authorization") or headers.get("Authorization")
    if auth and auth.startswith("Bearer "):
        bearer = auth[len("Bearer "):].strip()
        if bearer and bearer != "cookie":
            return bearer
    cookie = headers.get("cookie") or headers.get("Cookie")
    if cookie:
        for part in cookie.split(";"):
            name, _, value = part.strip().partition("=")
            if name == "autoflow_session" and value:
                return _quote_decode(value)
    return None


def _quote_decode(value: str) -> str:
    from urllib.parse import unquote
    return unquote(value)


def safe_artifact_name(value: str) -> str:
    filename = Path(value).name
    cleaned = re.sub(r"[^a-zA-Z0-9._-]", "_", filename)
    return cleaned or "artifact.bin"


def failure_category(message: Any, code: Any = None) -> str:
    code_text = str(code or "").upper()
    if code_text:
        if "TIMEOUT" in code_text:
            return "timeout"
        if "ELEMENT_NOT_FOUND" in code_text or "LOCATOR" in code_text:
            return "locator"
        if "ASSERT" in code_text:
            return "assertion"
        if "NET" in code_text or "ECONN" in code_text:
            return "network"
        if "BROWSER" in code_text:
            return "browser"
        if "CANCEL" in code_text:
            return "canceled"
    value = str(message or "").upper()
    if "TIMEOUT" in value:
        return "timeout"
    if "ELEMENT_NOT_FOUND" in value or "LOCATOR" in value or "STRICT MODE" in value:
        return "locator"
    if "ASSERT" in value or "TEXT_" in value:
        return "assertion"
    if (
        "NET::" in value
        or "ERR_" in value
        or "NETWORK" in value
        or "ECONN" in value
    ):
        return "network"
    if "BROWSER" in value:
        return "browser"
    if "CANCELED" in value:
        return "canceled"
    return "other"


CRON_FIELD_BOUNDS: list[tuple[int, int]] = [
    (0, 59),
    (0, 23),
    (1, 31),
    (1, 12),
    (0, 6),
]


def assert_valid_cron_expression(expression: str) -> None:
    fields = expression.strip().split()
    if len(fields) != 5:
        raise PlatformError(400, "SCHEDULE_CRON_INVALID")
    for index, field in enumerate(fields):
        minimum, maximum = CRON_FIELD_BOUNDS[index]
        for part in field.split(","):
            if not part:
                raise PlatformError(400, "SCHEDULE_CRON_INVALID")
            range_text, separator, interval_text = part.partition("/")
            if separator:
                try:
                    interval = int(interval_text)
                except ValueError:
                    interval = -1
                if interval < 1 or interval > maximum - minimum:
                    raise PlatformError(400, "SCHEDULE_CRON_INVALID")
            if range_text == "*":
                continue
            start_text, _, end_text = range_text.partition("-")
            try:
                start = int(start_text)
                end = int(end_text) if end_text else start
            except ValueError:
                raise PlatformError(400, "SCHEDULE_CRON_INVALID")
            if (
                start < minimum
                or start > maximum
                or end < minimum
                or end > maximum
                or end < start
            ):
                raise PlatformError(400, "SCHEDULE_CRON_INVALID")


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _local_parts(value: datetime, time_zone: str) -> dict[str, int]:
    try:
        local = _as_utc(value).astimezone(ZoneInfo(time_zone))
    except Exception as exc:
        raise PlatformError(400, "SCHEDULE_TIMEZONE_INVALID") from exc
    return {
        "minute": local.minute,
        "hour": local.hour,
        "day": local.day,
        "month": local.month,
        "weekDay": (local.weekday() + 1) % 7,
    }


def cron_field_matches(
    field: str,
    value: int,
    minimum: int,
    maximum: int,
) -> bool:
    for part in field.split(","):
        range_text, _, interval_text = part.partition("/")
        try:
            interval = int(interval_text) if interval_text else 1
        except ValueError:
            interval = -1
        if interval < 1:
            return False
        if range_text == "*":
            start, end = minimum, maximum
        else:
            start_text, _, end_text = range_text.partition("-")
            try:
                start = int(start_text)
                end = int(end_text) if end_text else start
            except ValueError:
                return False
        if (
            start < minimum
            or end > maximum
            or value < start
            or value > end
            or (value - start) % interval != 0
        ):
            continue
        return True
    return False


def cron_matches(expression: str, date: datetime, time_zone: str) -> bool:
    fields = expression.strip().split()
    if len(fields) != 5:
        return False
    values = _local_parts(date, time_zone)
    day_of_month_matches = cron_field_matches(fields[2], values["day"], 1, 31)
    day_of_week_matches = cron_field_matches(fields[4], values["weekDay"], 0, 6)
    if fields[2] == "*":
        day_matches = day_of_week_matches
    elif fields[4] == "*":
        day_matches = day_of_month_matches
    else:
        day_matches = day_of_month_matches or day_of_week_matches
    return (
        cron_field_matches(fields[0], values["minute"], 0, 59)
        and cron_field_matches(fields[1], values["hour"], 0, 23)
        and day_matches
        and cron_field_matches(fields[3], values["month"], 1, 12)
    )


def next_cron_time(
    expression: str,
    time_zone: str,
    from_time: datetime | None = None,
) -> str:
    assert_valid_cron_expression(expression)
    cursor = _as_utc(from_time or datetime.now(timezone.utc))
    cursor = cursor.replace(second=0, microsecond=0) + timedelta(minutes=1)
    for _ in range(5000):
        if cron_matches(expression, cursor, time_zone):
            return cursor.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
        cursor += timedelta(minutes=1)
    raise PlatformError(400, "SCHEDULE_CRON_INVALID")


def public_flow_output_names(run: dict[str, Any]) -> set[str]:
    flow = as_record(run.get("snapshot", {}).get("flow"))
    steps = flow.get("steps")
    if not isinstance(steps, list):
        return set()
    names: set[str] = set()
    for step in steps:
        record = as_record(step)
        name = record.get("output")
        if not isinstance(name, str):
            name = record.get("storeAs")
        if (
            record.get("outputPublic") is True
            and isinstance(name, str)
            and re.match(r"^[A-Za-z_][A-Za-z0-9_.-]*$", name)
        ):
            names.add(name)
    return names


def parse_csv(content: str) -> list[list[str]]:
    rows: list[list[str]] = []
    row: list[str] = []
    cell = ""
    quoted = False
    index = 0
    while index < len(content):
        character = content[index]
        if quoted:
            if character == '"':
                if index + 1 < len(content) and content[index + 1] == '"':
                    cell += '"'
                    index += 1
                else:
                    quoted = False
            else:
                cell += character
            index += 1
            continue
        if character == '"':
            if cell:
                raise PlatformError(400, "DATASET_FILE_INVALID")
            quoted = True
        elif character == ",":
            row.append(cell)
            cell = ""
        elif character == "\n":
            row.append(cell)
            rows.append(row)
            if len(rows) > 10001:
                raise PlatformError(413, "DATASET_ROW_LIMIT_EXCEEDED")
            row = []
            cell = ""
        elif character != "\r":
            cell += character
        index += 1
    if quoted:
        raise PlatformError(400, "DATASET_FILE_INVALID")
    if cell or row:
        row.append(cell)
        rows.append(row)
        if len(rows) > 10001:
            raise PlatformError(413, "DATASET_ROW_LIMIT_EXCEEDED")
    return rows


def normalize_dataset_rows(input_rows: list[list[Any]]) -> dict[str, Any]:
    if len(input_rows) < 2:
        raise PlatformError(400, "DATASET_ROWS_REQUIRED")
    headers = [
        _js_string(value).strip().replace("\ufeff", "")
        for value in input_rows[0]
    ]
    if (
        not headers
        or len(headers) > 200
        or any(not value for value in headers)
    ):
        raise PlatformError(400, "DATASET_HEADERS_INVALID")
    canonical = [value.lower() for value in headers]
    if len(set(canonical)) != len(headers):
        raise PlatformError(400, "DATASET_HEADERS_DUPLICATE")
    rows: list[dict[str, str]] = []
    for source in input_rows[1:10001]:
        row = {
            header: _js_string(source[index] if index < len(source) else "")[:10000]
            for index, header in enumerate(headers)
        }
        if any(value for value in row.values()):
            rows.append(row)
    if not rows:
        raise PlatformError(400, "DATASET_ROWS_REQUIRED")
    if len(input_rows) > 10001:
        raise PlatformError(413, "DATASET_ROW_LIMIT_EXCEEDED")
    return {"columns": headers, "rows": rows}


def _js_string(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def public_ip_address(address: str) -> bool:
    try:
        parsed = ipaddress.ip_address(address)
    except ValueError:
        return False
    if parsed.version == 4:
        first, second = int(parsed).to_bytes(4, "big")[:2]
        return not (
            first == 0
            or first == 10
            or first == 127
            or (first == 100 and 64 <= second <= 127)
            or (first == 169 and second == 254)
            or (first == 172 and 16 <= second <= 31)
            or (first == 192 and second == 168)
            or (first == 192 and second == 0)
            or (first == 198 and second in (18, 19))
            or first >= 224
        )
    normalized = str(parsed).lower()
    return (
        normalized != "::"
        and normalized != "::1"
        and not normalized.startswith("fc")
        and not normalized.startswith("fd")
        and not normalized.startswith("fe80:")
        and not normalized.startswith("::ffff:")
    )


def webhook_signature_matches(
    secret: str,
    timestamp: str,
    body: bytes,
    signature: str,
) -> bool:
    expected = "sha256=" + hmac.new(
        secret.encode("utf-8"),
        f"{timestamp}.{body.decode('utf-8')}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(signature, expected)
