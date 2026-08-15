"""Resource helpers matching server/platform-resources.ts."""

from __future__ import annotations

from typing import Any


def as_record(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    return {}


def public_resource_data(value: Any) -> dict[str, Any]:
    data = as_record(value)
    if data.get("secret") is True:
        return {**data, "value": "", "hasValue": bool(data.get("hasValue"))}
    return data
