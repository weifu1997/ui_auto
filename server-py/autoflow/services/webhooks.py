"""Webhook rate limiting."""
from __future__ import annotations

from ._shared import (
    _now_ms,
)


class WebhookServices:
    """Webhook rate limiting."""

    def allow_webhook_request(self, trigger_id: str) -> bool:
        from ..core import WEBHOOK_RATE_LIMIT_PER_MINUTE

        cutoff = _now_ms() - 60_000
        requests = [
            value for value in self.webhook_requests.get(trigger_id, []) if value > cutoff
        ]
        if len(requests) >= WEBHOOK_RATE_LIMIT_PER_MINUTE:
            return False
        requests.append(_now_ms())
        self.webhook_requests[trigger_id] = requests
        return True
