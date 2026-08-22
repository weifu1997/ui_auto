"""Platform API router composed from domain modules; the public surface stays create_platform_router."""
from __future__ import annotations

from fastapi import APIRouter

from ..services import PlatformServices
from . import (
    system,
    auth,
    accounts,
    workspaces,
    projects,
    templates,
    resources,
    datasets,
    schedules,
    webhooks,
    channels,
    runs,
    recordings,
    validations,
    revisions,
    secrets,
    governance,
)


def create_platform_router(services: PlatformServices) -> APIRouter:
    router = APIRouter()
    for module in (
        system,
        auth,
        accounts,
        workspaces,
        projects,
        templates,
        resources,
        datasets,
        schedules,
        webhooks,
        channels,
        runs,
        recordings,
        validations,
        revisions,
        secrets,
        governance,
    ):
        module.register(router, services)
    return router
