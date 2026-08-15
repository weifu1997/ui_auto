"""Notification allowlist helpers matching server/platform-automations.ts."""

from __future__ import annotations


def notification_host_allowed(host: str, allowlist: list[str]) -> bool:
    normalized = host.lower().rstrip(".")
    for entry in allowlist:
        if entry.startswith("*."):
            if normalized.endswith(entry[1:]) and normalized != entry[2:]:
                return True
        elif normalized == entry.rstrip("."):
            return True
    return False
