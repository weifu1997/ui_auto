"""FastAPI application root matching server/index.ts for the Platform API."""

from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse

from .core import json, now
from .handler import create_platform_router
from typing import Any

from .http import PlatformError
from .services import PlatformServices
from .transport import effective_https, require_https, trusted_proxy

REPO_ROOT = Path(__file__).resolve().parents[2]
LOGGER = logging.getLogger(__name__)
MAINTENANCE_FAILURE_CODE = "MAINTENANCE_PASS_FAILED"


@dataclass
class MaintenanceHealth:
    healthy: bool = True
    last_failure_at: str | None = None
    failure_code: str | None = None

    def payload(self) -> dict[str, bool | str | None]:
        return {
            "healthy": self.healthy,
            "lastFailureAt": self.last_failure_at,
            "failureCode": self.failure_code,
        }

    def mark_failed(self, failed_at: str) -> None:
        self.healthy = False
        self.last_failure_at = failed_at
        self.failure_code = MAINTENANCE_FAILURE_CODE

    def mark_healthy(self) -> None:
        self.healthy = True
        self.failure_code = None


@dataclass
class _MaintenanceSchedule:
    retention_audit_days: int
    retention_run_days: int
    retention_artifact_days: int
    retention_dry_run: bool
    last_retention_cleanup: float = 0.0


def _maintenance_schedule() -> _MaintenanceSchedule:
    return _MaintenanceSchedule(
        retention_audit_days=max(
            1, int(os.environ.get("AUTOFLOW_RETENTION_AUDIT_DAYS", "180"))
        ),
        retention_run_days=max(
            1, int(os.environ.get("AUTOFLOW_RETENTION_RUN_DAYS", "90"))
        ),
        retention_artifact_days=max(
            1, int(os.environ.get("AUTOFLOW_RETENTION_ARTIFACT_DAYS", "15"))
        ),
        retention_dry_run=os.environ.get("AUTOFLOW_RETENTION_DRY_RUN") == "1",
    )


def _configured_origins() -> list[str]:
    return [
        value.strip()
        for value in os.environ.get("AUTOFLOW_CORS_ORIGINS", "").split(",")
        if value.strip()
    ]


def _origin_allowed(origin: str | None, allowed_origins: list[str]) -> bool:
    if not origin:
        return True
    if origin in allowed_origins:
        return True
    if not allowed_origins and re.match(
        r"^http://(127\.0\.0\.1|localhost):\d+$", origin
    ):
        return True
    return False


def _fixture_html(pathname: str) -> str | None:
    fixtures = {
        "/__fixture/login": """<!doctype html><html><body><main><h1>Fixture login</h1><label>账号<input data-testid="login-account" data-test="login-account" /></label><label>密码<input data-testid="login-password" data-test="login-password" type="password" /></label><button data-testid="login-submit" data-test="login-submit">登录</button><p data-testid="welcome" data-test="welcome" hidden>欢迎回来</p></main><script>document.querySelector('[data-testid=login-submit]').onclick=()=>document.querySelector('[data-testid=welcome]').hidden=false</script></body></html>""",
        "/__fixture/multiple": """<!doctype html><html><body><button class="candidate">立即参与</button><button class="candidate">立即参与</button><button class="candidate">立即参与</button></body></html>""",
        "/__fixture/retry": """<!doctype html><html><body><p data-testid="retry-target" hidden>已准备就绪</p><script>setTimeout(() => { document.querySelector('[data-testid=retry-target]').hidden = false }, 1200)</script></body></html>""",
        "/__fixture/interpolation": """<!doctype html><html><body><input data-testid="project-value" data-test="project-value" /><input data-testid="environment-value" data-test="environment-value" /><button data-testid="apply" data-test="apply">应用</button><p data-testid="result" data-test="result"></p><script>document.querySelector('[data-testid=apply]').onclick=()=>document.querySelector('[data-testid=result]').textContent=document.querySelector('[data-testid=project-value]').value+'|'+document.querySelector('[data-testid=environment-value]').value</script></body></html>""",
        "/__fixture/response-output": """<!doctype html><html><body><button data-testid="fetch-output" data-test="fetch-output">Fetch output</button><script>document.querySelector('[data-testid=fetch-output]').onclick=()=>fetch('/__fixture/response-json')</script></body></html>""",
    }
    return fixtures.get(pathname)


class CorsMiddleware:
    def __init__(self, app, allowed_origins: list[str]):
        self.app = app
        self.allowed_origins = allowed_origins

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = dict(
            (key.decode("latin-1").lower(), value.decode("latin-1"))
            for key, value in scope.get("headers", [])
        )
        origin = headers.get("origin")
        if origin and not _origin_allowed(origin, self.allowed_origins):
            response = JSONResponse(
                status_code=403, content={"error": "CORS_ORIGIN_FORBIDDEN"}
            )
            await response(scope, receive, send)
            return
        if scope["method"] == "OPTIONS":
            response = Response(status_code=204)
            response.headers["access-control-allow-origin"] = origin or "*"
            response.headers["access-control-allow-credentials"] = "true"
            response.headers["vary"] = "origin"
            response.headers["access-control-allow-methods"] = (
                "GET, POST, PUT, PATCH, DELETE, OPTIONS"
            )
            response.headers["access-control-allow-headers"] = (
                "content-type, authorization"
            )
            await response(scope, receive, send)
            return

        async def send_with_cors(message):
            if message["type"] == "http.response.start":
                message["headers"] = list(message.get("headers", []))
                if origin:
                    message["headers"].append(
                        (b"access-control-allow-origin", origin.encode("latin-1"))
                    )
                    message["headers"].append(
                        (b"access-control-allow-credentials", b"true")
                    )
                    message["headers"].append((b"vary", b"origin"))
            await send(message)

        await self.app(scope, receive, send_with_cors)


class SecureTransportMiddleware:
    """Enforce approved HTTPS transport when AUTOFLOW_REQUIRE_HTTPS=1.

    The app itself is bound to loopback and terminates TLS only at an approved proxy;
    any authenticated request that arrives without HTTPS is rejected before routing.
    """

    def __init__(
        self,
        app,
        trusted_proxy: str | None,
        require_https: bool,
    ):
        self.app = app
        self.trusted_proxy = trusted_proxy
        self.require_https = require_https

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and self.require_https:
            if not effective_https(scope, self.trusted_proxy):
                response = JSONResponse(
                    status_code=426,
                    content={"error": "HTTPS_REQUIRED"},
                )
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)


def create_app(services: PlatformServices | None = None) -> FastAPI:
    if services is None:
        data_directory = os.environ.get(
            "PLATFORM_DATA_DIRECTORY", str(REPO_ROOT / "data")
        )
        services = PlatformServices(data_directory)
    maintenance_health = MaintenanceHealth()

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        maintenance_task = asyncio.create_task(
            _maintenance_loop(services, maintenance_health)
        )
        try:
            yield
        finally:
            maintenance_task.cancel()
            await asyncio.gather(maintenance_task, return_exceptions=True)
            services.close()

    app = FastAPI(
        title="AutoFlow Workbench Python Backend",
        docs_url=None,
        redoc_url=None,
        lifespan=lifespan,
    )
    app.state.services = services
    app.state.maintenance_health = maintenance_health
    app.add_middleware(CorsMiddleware, allowed_origins=_configured_origins())
    app.add_middleware(
        SecureTransportMiddleware,
        trusted_proxy=trusted_proxy(),
        require_https=require_https(),
    )
    app.include_router(create_platform_router(services))

    @app.exception_handler(PlatformError)
    async def platform_error_handler(
        request: Request, exc: PlatformError
    ) -> JSONResponse:
        content: dict[str, Any] = {"error": exc.code}
        if exc.detail:
            content.update(exc.detail)
        return JSONResponse(status_code=exc.status, content=content)

    @app.exception_handler(Exception)
    async def internal_error_handler(request: Request, exc: Exception) -> JSONResponse:
        return JSONResponse(status_code=500, content={"error": "INTERNAL_ERROR"})

    @app.get("/health")
    async def health() -> JSONResponse:
        return JSONResponse(content={"ok": True, "queue": "online"})

    @app.get("/__fixture/response-json")
    async def response_json() -> JSONResponse:
        return JSONResponse(content={"order": {"id": "response-order-1"}})

    @app.get("/__fixture/{path:path}")
    async def fixture(path: str) -> Response:
        fixture_html = _fixture_html(f"/__fixture/{path}")
        if fixture_html is None:
            raise PlatformError(404, "NOT_FOUND")
        return Response(
            content=fixture_html,
            media_type="text/html; charset=utf-8",
        )

    @app.get("/ready")
    async def ready() -> JSONResponse:
        maintenance = maintenance_health.payload()
        try:
            check = services.database.execute("PRAGMA quick_check").fetchone()
        except Exception:
            return JSONResponse(
                status_code=503,
                content={"ready": False, "maintenance": maintenance},
            )
        database_ready = bool(check) and str(check[0]).lower() == "ok"
        return JSONResponse(
            status_code=200 if database_ready else 503,
            content={"ready": database_ready, "maintenance": maintenance},
        )

    @app.get("/metrics")
    async def metrics() -> JSONResponse:
        maintenance = maintenance_health.payload()
        try:
            check = services.database.execute("PRAGMA quick_check").fetchone()
        except Exception:
            database_ready = False
        else:
            database_ready = bool(check) and str(check[0]).lower() == "ok"
        payload = services.metrics()
        payload["ready"] = database_ready
        payload["maintenance"] = maintenance
        return JSONResponse(content=payload)

    @app.get("/api/platform/health")
    async def platform_health() -> Response:
        return Response(
            content=json({"ok": True, "service": "platform"}),
            media_type="application/json; charset=utf-8",
        )

    @app.api_route(
        "/api/{path:path}",
        methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        include_in_schema=False,
    )
    async def unsupported_api(path: str) -> None:
        raise HTTPException(status_code=404)

    if os.environ.get("NODE_ENV") == "production":
        static_directory = Path(
            os.environ.get("AUTOFLOW_STATIC_DIRECTORY", "dist")
        ).resolve()

        @app.get("/{path:path}", include_in_schema=False)
        async def serve_static(path: str) -> FileResponse:
            requested = path or "index.html"
            candidate = (static_directory / requested).resolve()
            if not str(candidate).startswith(str(static_directory) + os.sep):
                candidate = static_directory / "index.html"
            if not candidate.is_file():
                candidate = static_directory / "index.html"
            content_types = {
                ".html": "text/html; charset=utf-8",
                ".js": "text/javascript; charset=utf-8",
                ".css": "text/css; charset=utf-8",
                ".svg": "image/svg+xml",
                ".png": "image/png",
                ".ico": "image/x-icon",
            }
            media_type = content_types.get(
                candidate.suffix.lower(), "application/octet-stream"
            )
            return FileResponse(
                candidate,
                media_type=media_type,
                headers={
                    "cache-control": (
                        "no-cache"
                        if candidate.name == "index.html"
                        else "public, max-age=31536000, immutable"
                    )
                },
            )

    return app


def _maintenance_pass(services: PlatformServices, schedule: _MaintenanceSchedule) -> None:
    services.process_due_schedules()
    services.deliver_pending_notifications()
    services.recording_coordinator.sweep_expired()
    watchdog_cutoff = (
        datetime.now(timezone.utc) - timedelta(minutes=30)
    ).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    stuck = services.database.execute(
        """
        SELECT id FROM platform_runs
        WHERE executor_type = 'managed' AND status = 'running'
          AND updated_at <= ?
        """,
        (watchdog_cutoff,),
    ).fetchall()
    for row in stuck:
        services.finalize_run_as_interrupted(row[0], "MANAGED_RUN_WATCHDOG_TIMEOUT")
        services.cancel_managed_run(row[0])
    current_time = time.monotonic()
    if current_time - schedule.last_retention_cleanup < 3600:
        return
    summary = services.retention_cleanup(
        audit_days=schedule.retention_audit_days,
        run_days=schedule.retention_run_days,
        artifact_days=schedule.retention_artifact_days,
        dry_run=schedule.retention_dry_run,
    )
    if any(summary.values()):
        LOGGER.info(
            json(
                {
                    "event": "retention.pass",
                    "dryRun": schedule.retention_dry_run,
                    "summary": summary,
                }
            )
        )
    schedule.last_retention_cleanup = current_time


async def _run_maintenance_pass(
    services: PlatformServices, schedule: _MaintenanceSchedule
) -> None:
    await asyncio.to_thread(_maintenance_pass, services, schedule)


async def _maintenance_loop(
    services: PlatformServices,
    maintenance_health: MaintenanceHealth | None = None,
    *,
    interval_seconds: float = 10,
    max_passes: int | None = None,
) -> None:
    maintenance_health = maintenance_health or MaintenanceHealth()
    schedule = _maintenance_schedule()
    completed_passes = 0
    while True:
        await asyncio.sleep(interval_seconds)
        try:
            await _run_maintenance_pass(services, schedule)
        except Exception:
            failed_at = now()
            maintenance_health.mark_failed(failed_at)
            LOGGER.error(
                json(
                    {
                        "event": "maintenance.failed",
                        "failureAt": failed_at,
                        "failureCode": MAINTENANCE_FAILURE_CODE,
                    }
                )
            )
        else:
            maintenance_health.mark_healthy()
        completed_passes += 1
        if max_passes is not None and completed_passes >= max_passes:
            return


app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=os.environ.get("AUTOFLOW_LISTEN_HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "8787")),
    )
