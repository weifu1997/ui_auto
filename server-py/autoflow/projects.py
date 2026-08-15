"""Project helpers matching server/platform-projects.ts."""

from __future__ import annotations

import re


def clean_project_slug(value: str) -> str:
    cleaned = re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")
    return cleaned or "project"
