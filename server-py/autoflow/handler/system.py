"""Liveness probe route."""
from __future__ import annotations

from fastapi import APIRouter, Response
from ..services import PlatformServices
from ._shared import (
    _send,
)


def register(router: APIRouter, services: PlatformServices) -> None:

    @router.api_route("/api/platform/health", methods=["GET"])
    def platform_health() -> Response:
        return _send(Response(), 200, {"ok": True, "service": "platform"})
