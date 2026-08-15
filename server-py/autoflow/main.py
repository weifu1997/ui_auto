"""FastAPI application root matching server/index.ts for the Platform API."""

from __future__ import annotations

import asyncio
import os
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request, Response
from fastapi.responses import FileResponse, JSONResponse

from .core import json
from .handler import create_platform_router
from .http import PlatformError
from .services import PlatformServices
from .worker import WorkerService, create_worker_router

REPO_ROOT = Path(__file__).resolve().parents[2]


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


def create_app(services: PlatformServices | None = None) -> FastAPI:
    if services is None:
        data_directory = os.environ.get(
            "WORKER_DATA_DIRECTORY", str(REPO_ROOT / "server" / ".data")
        )
        services = PlatformServices(data_directory)
    app = FastAPI(title="AutoFlow Workbench Python Backend", docs_url=None, redoc_url=None)
    app.state.services = services
    app.add_middleware(CorsMiddleware, allowed_origins=_configured_origins())
    app.include_router(create_platform_router(services))
    worker = WorkerService(
        os.environ.get(
            "WORKER_DATA_DIRECTORY", str(REPO_ROOT / "server" / ".data")
        ),
        os.environ.get(
            "WORKER_ARTIFACT_DIRECTORY", str(REPO_ROOT / "server" / ".artifacts")
        ),
    )
    app.state.worker = worker
    app.include_router(create_worker_router(worker))

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        maintenance_task = asyncio.create_task(_maintenance_loop(services))
        try:
            yield
        finally:
            maintenance_task.cancel()
            await asyncio.gather(maintenance_task, return_exceptions=True)
            worker.close()

    @app.exception_handler(PlatformError)
    async def platform_error_handler(
        request: Request, exc: PlatformError
    ) -> JSONResponse:
        return JSONResponse(status_code=exc.status, content={"error": exc.code})

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
        services.database.execute("PRAGMA quick_check")
        return JSONResponse(content={"ready": True})

    @app.get("/api/platform/health")
    async def platform_health() -> Response:
        return Response(
            content=json({"ok": True, "service": "platform"}),
            media_type="application/json; charset=utf-8",
        )

    if (
        os.environ.get("NODE_ENV") == "production"
        or os.environ.get("AUTOFLOW_ENABLE_STATIC") == "1"
    ):
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


async def _maintenance_loop(services: PlatformServices) -> None:
    last_retention_cleanup = 0.0
    retention_event_days = max(1, int(os.environ.get("AUTOFLOW_RETENTION_EVENT_DAYS", "180")))
    retention_delivery_days = max(
        1, int(os.environ.get("AUTOFLOW_RETENTION_DELIVERY_DAYS", "90"))
    )
    while True:
        await asyncio.sleep(10)
        try:
            await asyncio.to_thread(services.process_due_schedules)
            await asyncio.to_thread(services.deliver_pending_notifications)
            from datetime import datetime, timedelta, timezone

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
                services.finalize_run_as_interrupted(
                    row[0], "MANAGED_RUN_WATCHDOG_TIMEOUT"
                )
                services.cancel_managed_run(row[0])
            if time.monotonic() - last_retention_cleanup >= 3600:
                last_retention_cleanup = time.monotonic()
                from .core import now

                event_cutoff = (
                    datetime.now(timezone.utc)
                    - timedelta(days=retention_event_days)
                ).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
                delivery_cutoff = (
                    datetime.now(timezone.utc)
                    - timedelta(days=retention_delivery_days)
                ).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
                services.database.execute(
                    "DELETE FROM platform_sessions WHERE expires_at <= ?", (now(),)
                )
                services.database.execute(
                    "DELETE FROM platform_run_events WHERE created_at <= ?",
                    (event_cutoff,),
                )
                services.database.execute(
                    "DELETE FROM flow_outputs WHERE created_at <= ?",
                    (event_cutoff,),
                )
                services.database.execute(
                    """
                    DELETE FROM deliveries
                    WHERE status IN ('delivered', 'failed') AND created_at <= ?
                    """,
                    (delivery_cutoff,),
                )
        except Exception:
            # Request handling and the next interval both retry maintenance.
            pass


app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=os.environ.get("AUTOFLOW_LISTEN_HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "8787")),
    )
