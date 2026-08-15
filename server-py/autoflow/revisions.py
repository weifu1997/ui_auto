"""Revision helpers matching server/platform-revisions.ts."""

from __future__ import annotations


def revision_number(rows: list[dict]) -> int:
    values = [int(row.get("revision_number", 0)) for row in rows]
    return max([0, *values]) + 1
