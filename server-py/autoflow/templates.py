"""Template reference rewriting matching server/platform-templates.ts."""

from __future__ import annotations

from typing import Any


def rewrite_template_references(
    value: Any, ids: dict[str, str], depth: int = 0
) -> Any:
    if depth > 100:
        raise ValueError("TEMPLATE_SNAPSHOT_TOO_DEEP")
    if isinstance(value, str):
        return ids.get(value, value)
    if isinstance(value, list):
        return [
            rewrite_template_references(item, ids, depth + 1) for item in value
        ]
    if isinstance(value, dict):
        return {
            key: rewrite_template_references(item, ids, depth + 1)
            for key, item in value.items()
        }
    return value
