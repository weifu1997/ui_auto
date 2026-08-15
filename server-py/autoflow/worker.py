"""Local Worker API/SSE matching the legacy worker routes in server/index.ts."""

from __future__ import annotations

import asyncio
import concurrent.futures
import json as _json
import os
import queue
import re
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlsplit

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, Response, StreamingResponse

from .core import json, now, safe_artifact_name
from .http import PlatformError
from .managed_runner import ManagedRunner
from .picker import (
    build_picker_candidates,
    picker_candidate_locator,
    picker_injection_script,
    preview_picker_candidate,
)
from .runner import execute_browser_run, execute_element_validation


def _project_or_throw(project_id: str) -> dict[str, str]:
    if not re.match(r"^[a-z0-9][a-z0-9-]{0,79}$", project_id, re.IGNORECASE):
        raise PlatformError(404, "PROJECT_NOT_FOUND")
    return {"id": project_id}


def _redact_request(request: dict[str, Any]) -> dict[str, Any]:
    secret_keys = set(request.get("secretKeys") or [])
    variables = request.get("variables") or {}
    return {
        **request,
        "variables": {
            key: "***" if key in secret_keys else value
            for key, value in variables.items()
        },
    }


def _format_sse(event: dict[str, Any]) -> str:
    return (
        f"id: {event['id']}\n"
        f"event: {event['kind']}\n"
        f"data: {json(event)}\n\n"
    )


def _parse_json(value: str | None, fallback: Any) -> Any:
    if value is None:
        return fallback
    try:
        return _json.loads(value)
    except (TypeError, ValueError):
        return fallback


class WorkerService:
    def __init__(self, data_directory: str, artifact_directory: str):
        self.data_directory = Path(data_directory)
        self.artifact_directory = Path(artifact_directory)
        self.data_directory.mkdir(parents=True, exist_ok=True)
        self.artifact_directory.mkdir(parents=True, exist_ok=True)
        self.database = sqlite3.connect(
            self.data_directory / "autoflow.sqlite", check_same_thread=False
        )
        self.database.isolation_level = None
        self._init_database()
        self.tasks: dict[str, dict[str, Any]] = {}
        self.artifacts: dict[str, dict[str, Any]] = {}
        self.picker_sessions: dict[str, dict[str, Any]] = {}
        self.picker_pending: dict[str, dict[str, Any]] = {}
        self.picker_idle_ms = 15 * 60_000
        self.picker_max_ms = 2 * 60 * 60_000
        self._condition = threading.Condition()
        self._restore_persisted_tasks()
        self.picker_queue: queue.Queue[
            tuple[concurrent.futures.Future, Any, tuple, tuple | None] | None
        ] = queue.Queue()
        self._picker_thread = threading.Thread(
            target=self._picker_worker, daemon=True, name="autoflow-picker"
        )
        self._picker_thread.start()
        self._picker_screenshot_interval_ms = 5_000
        self._last_picker_screenshot_ms = 0.0
        self._last_picker_expiry_ms = 0.0
        self._housekeeping_stop = threading.Event()
        self._housekeeping_thread = threading.Thread(
            target=self._picker_housekeeping,
            daemon=True,
            name="autoflow-picker-housekeeping",
        )
        self._housekeeping_thread.start()
        self.managed_runner = ManagedRunner(self.artifact_directory)

    def close(self) -> None:
        self._housekeeping_stop.set()
        self._housekeeping_thread.join(timeout=10)
        self.managed_runner.stop()
        end_futures = [
            self.submit_picker(self.end_local_picker_session, session)
            for session in list(self.picker_sessions.values())
        ]
        for future in end_futures:
            future.result(timeout=10)
        self.picker_queue.put(None)
        self._picker_thread.join(timeout=10)
        self.database.close()

    def _restore_persisted_tasks(self) -> None:
        artifact_rows = self.database.execute(
            """
            SELECT id, project_id, path, content_type, name
            FROM worker_artifacts
            """
        ).fetchall()
        for artifact_id, project_id, path, content_type, name in artifact_rows:
            self.artifacts[artifact_id] = {
                "id": artifact_id,
                "projectId": project_id,
                "path": path,
                "contentType": content_type,
                "name": name,
            }

        task_rows = self.database.execute(
            """
            SELECT id, project_id, type, status, created_at, artifact_ids,
                   result, request, summary, browser_state
            FROM worker_tasks
            ORDER BY created_at
            """
        ).fetchall()
        for (
            task_id,
            project_id,
            task_type,
            status,
            created_at,
            artifact_ids_raw,
            result_raw,
            request_raw,
            summary_raw,
            browser_state,
        ) in task_rows:
            event_rows = self.database.execute(
                """
                SELECT event_id, kind, occurred_at, data
                FROM worker_events
                WHERE task_id = ?
                ORDER BY event_id
                """,
                (task_id,),
            ).fetchall()
            events = []
            next_event_id = 1
            for event_id, kind, occurred_at, data_raw in event_rows:
                events.append(
                    {
                        "id": event_id,
                        "kind": kind,
                        "at": occurred_at,
                        "data": _parse_json(data_raw, {}),
                    }
                )
                next_event_id = max(next_event_id, event_id + 1)
            request = _parse_json(request_raw, None)
            task = {
                "id": task_id,
                "projectId": project_id,
                "type": task_type,
                "status": status,
                "createdAt": created_at,
                "events": events,
                "nextEventId": next_event_id,
                "artifactIds": _parse_json(artifact_ids_raw, []),
                "result": _parse_json(result_raw, None),
                "request": request,
                "executionRequest": request,
                "summary": _parse_json(summary_raw, None),
                "sensitive": bool((request or {}).get("secretKeys")),
                "browserState": browser_state or "closed",
            }
            self.tasks[task_id] = task
            if task["status"] in ("queued", "running"):
                result = task.get("result")
                if not isinstance(result, dict):
                    result = {}
                result["error"] = "WORKER_RESTARTED"
                result["completedSteps"] = int(result.get("completedSteps", 0) or 0)
                task["result"] = result
                task["status"] = "failed"
                task["browserState"] = "closed"
                self._publish(
                    task,
                    "status",
                    {"status": "failed", "error": "WORKER_RESTARTED"},
                )

    def _init_database(self) -> None:
        self.database.executescript(
            """
            CREATE TABLE IF NOT EXISTS worker_tasks (
              id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL,
              type TEXT NOT NULL,
              status TEXT NOT NULL,
              created_at TEXT NOT NULL,
              artifact_ids TEXT NOT NULL,
              result TEXT,
              request TEXT,
              summary TEXT,
              browser_state TEXT NOT NULL DEFAULT 'queued',
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS worker_events (
              task_id TEXT NOT NULL,
              event_id INTEGER NOT NULL,
              kind TEXT NOT NULL,
              occurred_at TEXT NOT NULL,
              data TEXT NOT NULL,
              PRIMARY KEY (task_id, event_id)
            );
            CREATE TABLE IF NOT EXISTS worker_artifacts (
              id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL,
              path TEXT NOT NULL,
              content_type TEXT NOT NULL,
              name TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS worker_tasks_project_created
              ON worker_tasks (project_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS worker_events_task
              ON worker_events (task_id, event_id);
            """
        )

    def create_task(
        self,
        project_id: str,
        task_type: str,
        request: dict[str, Any],
    ) -> dict[str, Any]:
        _project_or_throw(project_id)
        task_id = f"{'run' if task_type == 'run' else 'validation'}_{uuid.uuid4()}"
        task = {
            "id": task_id,
            "projectId": project_id,
            "type": task_type,
            "status": "queued",
            "createdAt": now(),
            "events": [],
            "nextEventId": 1,
            "artifactIds": [],
            "result": None,
            "request": _redact_request(request),
            "executionRequest": request,
            "sensitive": bool(request.get("secretKeys")),
            "summary": self._summarize_run(request) if task_type == "run" else None,
            "browserState": "queued",
        }
        self.tasks[task_id] = task
        self._publish(task, "status", {"status": "queued"})
        return task

    def _summarize_run(self, request: dict[str, Any]) -> dict[str, Any]:
        flow = request.get("flow") or {}
        steps = flow.get("steps") or []
        environment = request.get("environment") or {}
        up_to_step_id = request.get("upToStepId")
        up_to_index = next(
            (
                index
                for index, step in enumerate(steps)
                if isinstance(step, dict) and step.get("id") == up_to_step_id
            ),
            -1,
        )
        summary = {
            "flowName": flow.get("name", ""),
            "environmentName": environment.get("name", ""),
            "totalSteps": up_to_index + 1 if up_to_index >= 0 else len(steps),
        }
        if up_to_step_id:
            summary["upToStepId"] = up_to_step_id
        return summary

    def _persist_task(self, task: dict[str, Any]) -> None:
        self.database.execute(
            """
            INSERT INTO worker_tasks (
              id, project_id, type, status, created_at, artifact_ids, result,
              request, summary, browser_state, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              status = excluded.status,
              artifact_ids = excluded.artifact_ids,
              result = excluded.result,
              request = excluded.request,
              summary = excluded.summary,
              browser_state = excluded.browser_state,
              updated_at = excluded.updated_at
            """,
            (
                task["id"],
                task["projectId"],
                task["type"],
                task["status"],
                task["createdAt"],
                _json.dumps(task["artifactIds"], separators=(",", ":")),
                _json.dumps(task["result"], separators=(",", ":"))
                if task["result"] is not None
                else None,
                _json.dumps(task["request"], separators=(",", ":"))
                if task.get("request") is not None
                else None,
                _json.dumps(task["summary"], separators=(",", ":"))
                if task.get("summary") is not None
                else None,
                task["browserState"],
                now(),
            ),
        )

    def _publish(
        self,
        task: dict[str, Any],
        kind: str,
        data: dict[str, Any],
    ) -> dict[str, Any]:
        event = {
            "id": task["nextEventId"],
            "kind": kind,
            "at": now(),
            "data": data,
        }
        task["nextEventId"] += 1
        task["events"].append(event)
        if len(task["events"]) > 250:
            task["events"] = task["events"][-250:]
        self.database.execute(
            """
            INSERT OR REPLACE INTO worker_events (
              task_id, event_id, kind, occurred_at, data
            ) VALUES (?, ?, ?, ?, ?)
            """,
            (task["id"], event["id"], kind, event["at"], json(data)),
        )
        self._persist_task(task)
        with self._condition:
            self._condition.notify_all()
        return event

    def _save_artifact(
        self,
        task: dict[str, Any],
        name: str,
        content_type: str,
        path: str,
    ) -> str:
        artifact_id = f"artifact_{uuid.uuid4()}"
        artifact = {
            "id": artifact_id,
            "projectId": task["projectId"],
            "path": path,
            "contentType": content_type,
            "name": safe_artifact_name(name),
        }
        self.artifacts[artifact_id] = artifact
        self.database.execute(
            """
            INSERT INTO worker_artifacts (
              id, project_id, path, content_type, name, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              project_id = excluded.project_id,
              path = excluded.path,
              content_type = excluded.content_type,
              name = excluded.name
            """,
            (
                artifact_id,
                task["projectId"],
                path,
                content_type,
                artifact["name"],
                now(),
            ),
        )
        task["artifactIds"].append(artifact_id)
        self._publish(
            task,
            "artifact.created",
            {
                "artifactId": artifact_id,
                "name": artifact["name"],
                "contentType": content_type,
            },
        )
        return artifact_id

    def task_response(self, task: dict[str, Any]) -> dict[str, Any]:
        response = {
            "id": task["id"],
            "projectId": task["projectId"],
            "type": task["type"],
            "status": task["status"],
            "createdAt": task["createdAt"],
            "artifactIds": task["artifactIds"],
            "artifacts": [
                {
                    "id": self.artifacts[artifact_id]["id"],
                    "name": self.artifacts[artifact_id]["name"],
                    "contentType": self.artifacts[artifact_id]["contentType"],
                }
                for artifact_id in task["artifactIds"]
                if artifact_id in self.artifacts
            ],
            "result": task.get("result"),
            "browserState": task["browserState"],
            "events": task["events"],
        }
        if task.get("summary") is not None:
            response["summary"] = task["summary"]
        return response

    def enqueue_run(self, task: dict[str, Any]) -> None:
        request = task["executionRequest"]
        input = {
            "environment": request.get("environment") or {},
            "flow": request.get("flow") or {},
            "elements": request.get("elements") or [],
            "variables": request.get("variables") or {},
            "data": {},
            "secrets": {
                key: request.get("variables", {}).get(key, "")
                for key in (request.get("secretKeys") or [])
            },
            "upToStepId": request.get("upToStepId"),
        }

        def started() -> None:
            task["status"] = "running"
            task["browserState"] = "running"
            self._publish(task, "status", {"status": "running"})

        def event(kind: str, data: dict[str, Any]) -> None:
            self._publish(task, kind, data)

        def artifact(input_data: dict[str, Any]) -> None:
            self._save_artifact(
                task,
                str(input_data["name"]),
                str(input_data["contentType"]),
                str(input_data["path"]),
            )

        def completed(result: dict[str, Any]) -> None:
            screenshot_id = (
                task["artifactIds"][-1] if task["artifactIds"] else None
            )
            task["result"] = {**result, "screenshotId": screenshot_id}
            task["status"] = result.get("status", "failed")
            task["browserState"] = "closed"
            self._publish(task, "result", task["result"])
            self._publish(task, "status", {"status": task["status"]})

        self.managed_runner.enqueue(
            task["id"],
            input,
            {
                "started": started,
                "event": event,
                "artifact": artifact,
                "completed": completed,
            },
            kind="run",
        )

    def enqueue_validation(self, task: dict[str, Any]) -> None:
        request = task["executionRequest"]
        input = {
            "environment": request.get("environment") or {},
            "element": request.get("element") or {},
        }

        def finish_with_error(error: str) -> None:
            task["status"] = "failed"
            task["browserState"] = "closed"
            task["result"] = {
                "status": "failed",
                "count": 0,
                "elapsedMs": 0,
                "error": error,
            }
            self._publish(task, "result", task["result"])
            self._publish(task, "status", {"status": "failed"})

        if input["element"].get("requiresLogin"):
            environment_id = (
                request.get("environment", {}).get("id")
                if isinstance(request.get("environment"), dict)
                else None
            )
            session = next(
                (
                    item
                    for item in self.picker_sessions.values()
                    if item["projectId"] == task["projectId"]
                    and item["environmentId"] == environment_id
                ),
                None,
            )
            if not session:
                finish_with_error("LOGIN_SESSION_REQUIRED")
                return
            input["storage_state"] = session["context"].storage_state()
            input["requiresLogin"] = True

        def started() -> None:
            task["status"] = "running"
            task["browserState"] = "running"
            self._publish(task, "status", {"status": "running"})

        def artifact(input_data: dict[str, Any]) -> None:
            self._save_artifact(
                task,
                str(input_data["name"]),
                str(input_data["contentType"]),
                str(input_data["path"]),
            )

        def completed(result: dict[str, Any]) -> None:
            screenshot_id = (
                task["artifactIds"][-1] if task["artifactIds"] else None
            )
            task["result"] = {**result, "screenshotId": screenshot_id}
            task["status"] = result.get("status", "failed")
            task["browserState"] = "closed"
            self._publish(task, "result", task["result"])
            self._publish(task, "status", {"status": task["status"]})

        self.managed_runner.enqueue(
            task["id"],
            input,
            {
                "started": started,
                "artifact": artifact,
                "event": lambda *_args: None,
                "completed": completed,
            },
            kind="validation",
        )

    def task_by_id(
        self,
        project_id: str,
        task_id: str,
        task_type: str | None = None,
    ) -> dict[str, Any]:
        task = self.tasks.get(task_id)
        if not task or task["projectId"] != project_id:
            raise PlatformError(404, "RUN_NOT_FOUND")
        if task_type and task["type"] != task_type:
            raise PlatformError(404, "VALIDATION_NOT_FOUND")
        return task

    def cancel(self, task_id: str) -> bool:
        task = self.tasks.get(task_id)
        if not task:
            return False
        self.managed_runner.cancel(task_id)
        if task["status"] not in ("success", "failed", "canceled"):
            task["status"] = "canceled"
            task["browserState"] = "closed"
            self._publish(task, "status", {"status": "canceled"})
        return True

    def retry_run(self, project_id: str, run_id: str) -> dict[str, Any]:
        task = self.task_by_id(project_id, run_id, "run")
        if not task.get("request"):
            raise PlatformError(400, "RUN_RETRY_NOT_AVAILABLE")
        if task.get("sensitive"):
            raise PlatformError(409, "RUN_SECRETS_REQUIRED")
        execution_request = task.get("executionRequest") or task.get("request")
        retry = self.create_task(project_id, "run", execution_request)
        self.enqueue_run(retry)
        return retry

    def picker_session_response(self, session: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": session["id"],
            "projectId": session["projectId"],
            "environmentId": session["environmentId"],
            "environmentName": session["environmentName"],
            "currentUrl": session.get("currentUrl", ""),
            "status": "active",
            "captureCount": len(session.get("captures", [])),
            "hasScreenshot": bool(session.get("screenshotBuffer")),
        }

    def picker_session_by_id(
        self,
        project_id: str,
        session_id: str,
    ) -> dict[str, Any]:
        session = self.picker_sessions.get(session_id)
        if not session or session["projectId"] != project_id:
            raise PlatformError(404, "PICKER_SESSION_NOT_FOUND")
        self._touch_picker_session(session)
        return session

    def _touch_picker_session(self, session: dict[str, Any]) -> None:
        session["lastActivityAt"] = time.time() * 1000

    def submit_picker(self, function, *args):
        future: concurrent.futures.Future = concurrent.futures.Future()
        self.picker_queue.put((future, function, args, None))
        return future

    def _picker_worker(self) -> None:
        import asyncio

        asyncio.set_event_loop(None)
        while True:
            item = self.picker_queue.get()
            if item is None:
                return
            future, function, args, _kwargs = item
            try:
                future.set_result(function(*args))
            except BaseException as exc:
                future.set_exception(exc)

    def _picker_housekeeping(self) -> None:
        while not self._housekeeping_stop.wait(1.0):
            now_ms = time.time() * 1000
            if (
                now_ms - self._last_picker_screenshot_ms
                >= self._picker_screenshot_interval_ms
            ):
                self._last_picker_screenshot_ms = now_ms
                for session in list(self.picker_sessions.values()):
                    if session.get("page") is not None:
                        self.submit_picker(self._refresh_picker_screenshot, session)
            if now_ms - self._last_picker_expiry_ms >= 60_000:
                self._last_picker_expiry_ms = now_ms
                self.submit_picker(self._expire_picker_sessions)

    def _refresh_picker_screenshot(self, session: dict[str, Any]) -> None:
        page = session.get("page")
        if page is None:
            return
        try:
            session["screenshotBuffer"] = page.screenshot(type="png")
        except Exception:
            pass

    def _expire_picker_sessions(self) -> None:
        now_ms = time.time() * 1000
        for session in list(self.picker_sessions.values()):
            last_activity_at = session.get("lastActivityAt", now_ms)
            expires_at = session.get("expiresAt", now_ms)
            if (
                last_activity_at + self.picker_idle_ms < now_ms
                or expires_at < now_ms
            ):
                self.end_local_picker_session(session)

    def create_local_picker_session(
        self,
        project_id: str,
        environment: dict[str, Any],
        start_url: str | None = None,
    ) -> dict[str, Any]:
        from playwright.sync_api import sync_playwright

        _project_or_throw(project_id)
        if environment.get("browser") != "Chromium":
            raise PlatformError(400, "PICKER_ENVIRONMENT_UNSUPPORTED")
        base_url = str(environment.get("baseUrl", ""))
        test_id_attribute = str(environment.get("testIdAttribute", "data-testid"))
        if not re.match(r"^[a-zA-Z_][\w:-]*$", test_id_attribute):
            raise PlatformError(400, "INVALID_TEST_ID_ATTRIBUTE")
        environment_id = str(environment.get("id", ""))
        existing = next(
            (
                session
                for session in self.picker_sessions.values()
                if session["projectId"] == project_id
                and session["environmentId"] == environment_id
            ),
            None,
        )
        if existing:
            self._touch_picker_session(existing)
            return existing
        pending_key = f"{project_id}:{environment_id}"
        if pending_key in self.picker_pending:
            return self.picker_pending[pending_key]
        session: dict[str, Any] = {}
        self.picker_pending[pending_key] = session
        try:
            target = self._picker_target_url(base_url, start_url or "/")
            playwright = sync_playwright().start()
            headless = os.environ.get("WORKER_PICKER_HEADLESS", "0") == "1"
            browser = playwright.chromium.launch(headless=headless)
            context = browser.new_context(locale="zh-CN")
            page = context.new_page()
            try:
                page.goto(target, wait_until="commit", timeout=30000)
            except Exception:
                try:
                    context.close()
                except Exception:
                    pass
                try:
                    browser.close()
                except Exception:
                    pass
                try:
                    playwright.stop()
                except Exception:
                    pass
                raise PlatformError(502, "PICKER_SESSION_LOAD_FAILED") from None
            try:
                page.wait_for_function(
                    "['interactive', 'complete'].includes(document.readyState)",
                    timeout=30000,
                )
            except Exception:
                pass
            page.wait_for_timeout(2000)
            session.update(
                {
                    "id": f"picker_{uuid.uuid4()}",
                    "projectId": project_id,
                    "environmentId": environment_id,
                    "environmentName": str(environment.get("name", "")),
                    "baseUrl": base_url,
                    "testIdAttribute": test_id_attribute,
                    "playwright": playwright,
                    "browser": browser,
                    "context": context,
                    "page": page,
                    "currentUrl": page.url,
                    "captures": [],
                    "screenshotBuffer": None,
                    "lastActivityAt": time.time() * 1000,
                    "expiresAt": time.time() * 1000 + self.picker_max_ms,
                }
            )
            page.expose_binding(
                "autoflowDebugPickerCapture",
                lambda source, payload: self._picker_capture(session, payload),
            )
            self.picker_sessions[session["id"]] = session
            return session
        finally:
            self.picker_pending.pop(pending_key, None)

    def _picker_target_url(self, base_url: str, value: str) -> str:
        base = urlsplit(base_url)
        target = urlsplit(urljoin(base_url, value))
        if (
            base.scheme not in ("http", "https")
            or target.scheme != base.scheme
            or target.netloc != base.netloc
        ):
            raise PlatformError(400, "TARGET_URL_ORIGIN_FORBIDDEN")
        return target.geturl()

    def _picker_capture(
        self,
        session: dict[str, Any],
        payload: Any,
    ) -> None:
        raw = payload if isinstance(payload, dict) else {}
        try:
            self.submit_picker(self._process_picker_payload, session, raw)
        except Exception:
            return

    def _process_picker_payload(
        self,
        session: dict[str, Any],
        raw: dict[str, Any],
    ) -> None:
        page = session.get("page")
        if page is None:
            return
        try:
            candidates = build_picker_candidates(
                page,
                raw,
                session["testIdAttribute"],
                [],
            )
            if not candidates:
                return
            session.setdefault("captures", []).insert(
                0,
                {
                    "id": str(uuid.uuid4()),
                    "sessionId": session["id"],
                    "target": str(raw.get("target", "")),
                    "candidates": candidates,
                    "capturedAt": now(),
                },
            )
            self._touch_picker_session(session)
        except Exception:
            return

    def end_local_picker_session(self, session: dict[str, Any]) -> None:
        self.picker_sessions.pop(session["id"], None)
        try:
            session.get("context").close()
        except Exception:
            pass
        try:
            session.get("browser").close()
        except Exception:
            pass
        try:
            session.get("playwright").stop()
        except Exception:
            pass

    def enable_picker(
        self,
        project_id: str,
        session_id: str,
    ) -> dict[str, Any]:
        session = self.picker_session_by_id(project_id, session_id)
        try:
            session["page"].bring_to_front()
        except Exception:
            pass
        session["page"].evaluate(
            picker_injection_script(session["testIdAttribute"])
        )
        self._touch_picker_session(session)
        return self.picker_session_response(session)

    def picker_capture(self, capture_id: str, session: dict[str, Any]) -> dict[str, Any]:
        capture = next(
            (
                item
                for item in session.get("captures", [])
                if item["id"] == capture_id
            ),
            None,
        )
        if not capture:
            raise PlatformError(404, "PICKER_CAPTURE_NOT_FOUND")
        return capture

    def preview_picker_candidate(
        self,
        project_id: str,
        session_id: str,
        capture_id: str,
        candidate_index: int,
    ) -> int:
        session = self.picker_session_by_id(project_id, session_id)
        capture = self.picker_capture(capture_id, session)
        candidates = capture.get("candidates", [])
        if candidate_index < 0 or candidate_index >= len(candidates):
            raise PlatformError(400, "PICKER_CANDIDATE_INVALID")
        count = preview_picker_candidate(
            session["page"],
            candidates[candidate_index],
            session["testIdAttribute"],
        )
        self._touch_picker_session(session)
        return count

    def confirm_picker_candidate(
        self,
        project_id: str,
        session_id: str,
        capture_id: str,
        candidate_index: int,
        name: str | None = None,
    ) -> dict[str, Any]:
        session = self.picker_session_by_id(project_id, session_id)
        capture = self.picker_capture(capture_id, session)
        candidates = capture.get("candidates", [])
        if candidate_index < 0 or candidate_index >= len(candidates):
            raise PlatformError(400, "PICKER_CANDIDATE_INVALID")
        candidate = candidates[candidate_index]
        path = "/"
        try:
            path = urlsplit(session["page"].url).path or "/"
        except Exception:
            path = "/"
        suggested_name = (name or "").strip()[:160] or capture.get("target") or candidate.get("label")
        self._touch_picker_session(session)
        return {
            "target": "fillback",
            "candidate": {
                "method": candidate["method"],
                "value": candidate["value"],
                "count": candidate["count"],
                "score": candidate["score"],
                "label": candidate["label"],
            },
            "path": path,
            "environmentId": session["environmentId"],
            "suggestedName": suggested_name,
        }

    def picker_screenshot(
        self,
        project_id: str,
        session_id: str,
    ) -> bytes:
        session = self.picker_session_by_id(project_id, session_id)
        screenshot = session.get("screenshotBuffer")
        if screenshot is None:
            screenshot = session["page"].screenshot(type="png")
            session["screenshotBuffer"] = screenshot
        self._touch_picker_session(session)
        return screenshot

    def event_stream(self, project_id: str, task_id: str, task_type: str):
        task = self.task_by_id(project_id, task_id, task_type)
        sent = 0

        async def generator():
            nonlocal sent
            yield ": connected\n\n"
            while True:
                with self._condition:
                    current = self.task_by_id(project_id, task_id, task_type)
                events = current["events"]
                while sent < len(events):
                    yield _format_sse(events[sent])
                    sent += 1
                if current["status"] in ("success", "failed", "canceled"):
                    break
                await asyncio.sleep(0.3)

        return StreamingResponse(
            generator(),
            media_type="text/event-stream",
            headers={"cache-control": "no-cache, no-transform"},
        )


def create_worker_router(worker: WorkerService) -> APIRouter:
    router = APIRouter()

    @router.api_route(
        "/api/projects/{project_id}/runs",
        methods=["GET", "POST"],
    )
    async def runs(request: Request, project_id: str) -> Response:
        _project_or_throw(project_id)
        if request.method == "GET":
            rows = [
                worker.task_response(task)
                for task in worker.tasks.values()
                if task["projectId"] == project_id and task["type"] == "run"
            ]
            return Response(
                content=json({"runs": rows}),
                status_code=200,
                media_type="application/json; charset=utf-8",
            )
        body = await request.json()
        if not isinstance(body, dict):
            body = {}
        if not body.get("environment") or not body.get("flow"):
            raise PlatformError(400, "RUN_INPUT_INVALID")
        if not isinstance(body.get("flow", {}).get("steps"), list):
            raise PlatformError(400, "FLOW_STEPS_REQUIRED")
        if not isinstance(body.get("elements"), list):
            raise PlatformError(400, "ELEMENTS_REQUIRED")
        task = worker.create_task(project_id, "run", body)
        worker.enqueue_run(task)
        return Response(
            content=json({"runId": task["id"]}),
            status_code=202,
            media_type="application/json; charset=utf-8",
        )

    @router.api_route(
        "/api/projects/{project_id}/runs/{run_id}/events",
        methods=["GET"],
    )
    async def run_events(project_id: str, run_id: str):
        return worker.event_stream(project_id, run_id, "run")

    @router.api_route(
        "/api/projects/{project_id}/runs/{run_id}",
        methods=["GET"],
    )
    async def run_detail(project_id: str, run_id: str) -> Response:
        task = worker.task_by_id(project_id, run_id, "run")
        return Response(
            content=json(worker.task_response(task)),
            status_code=200,
            media_type="application/json; charset=utf-8",
        )

    @router.api_route(
        "/api/projects/{project_id}/runs/{run_id}/retry",
        methods=["POST"],
    )
    async def run_retry(project_id: str, run_id: str) -> Response:
        task = worker.retry_run(project_id, run_id)
        return Response(
            content=json({"runId": task["id"]}),
            status_code=202,
            media_type="application/json; charset=utf-8",
        )

    @router.api_route(
        "/api/projects/{project_id}/runs/{run_id}/cancel",
        methods=["POST"],
    )
    async def run_cancel(project_id: str, run_id: str) -> Response:
        worker.cancel(run_id)
        return Response(
            content=json({"runId": run_id, "canceled": True}),
            status_code=202,
            media_type="application/json; charset=utf-8",
        )

    @router.api_route(
        "/api/projects/{project_id}/validations",
        methods=["POST"],
    )
    async def validations(request: Request, project_id: str) -> Response:
        _project_or_throw(project_id)
        body = await request.json()
        if not isinstance(body, dict) or not body.get("environment") or not body.get("element"):
            raise PlatformError(400, "VALIDATION_INPUT_INVALID")
        task = worker.create_task(project_id, "validation", body)
        await asyncio.wrap_future(worker.submit_picker(worker.enqueue_validation, task))
        return Response(
            content=json({"validationId": task["id"]}),
            status_code=202,
            media_type="application/json; charset=utf-8",
        )

    @router.api_route(
        "/api/projects/{project_id}/validations/{validation_id}/events",
        methods=["GET"],
    )
    async def validation_events(project_id: str, validation_id: str):
        return worker.event_stream(project_id, validation_id, "validation")

    @router.api_route(
        "/api/projects/{project_id}/validations/{validation_id}",
        methods=["GET"],
    )
    async def validation_detail(project_id: str, validation_id: str) -> Response:
        task = worker.task_by_id(project_id, validation_id, "validation")
        return Response(
            content=json(worker.task_response(task)),
            status_code=200,
            media_type="application/json; charset=utf-8",
        )

    @router.api_route(
        "/api/projects/{project_id}/artifacts/{artifact_id}",
        methods=["GET"],
    )
    async def artifact(project_id: str, artifact_id: str) -> FileResponse:
        artifact = worker.artifacts.get(artifact_id)
        if not artifact or artifact["projectId"] != project_id:
            raise PlatformError(404, "ARTIFACT_NOT_FOUND")
        path = Path(artifact["path"])
        if not path.is_file():
            raise PlatformError(404, "ARTIFACT_FILE_MISSING")
        return FileResponse(
            path,
            media_type=artifact["contentType"],
            filename=artifact["name"],
        )

    @router.api_route(
        "/api/projects/{project_id}/local-picker/sessions",
        methods=["GET", "POST"],
    )
    async def local_picker_sessions(
        request: Request, project_id: str
    ) -> Response:
        _project_or_throw(project_id)
        if request.method == "GET":
            sessions = await asyncio.wrap_future(
                worker.submit_picker(
                    lambda: [
                        worker.picker_session_response(session)
                        for session in worker.picker_sessions.values()
                        if session["projectId"] == project_id
                    ]
                )
            )
            return Response(
                content=json({"sessions": sessions}),
                status_code=200,
                media_type="application/json; charset=utf-8",
            )
        try:
            body = await request.json()
        except Exception:
            body = {}
        environment = body.get("environment") if isinstance(body, dict) else None
        if not isinstance(environment, dict):
            raise PlatformError(400, "ENVIRONMENT_REQUIRED")
        session = await asyncio.wrap_future(
            worker.submit_picker(
                worker.create_local_picker_session,
                project_id,
                environment,
                body.get("startUrl") if isinstance(body, dict) else None,
            )
        )
        return Response(
            content=json({"session": worker.picker_session_response(session)}),
            status_code=201,
            media_type="application/json; charset=utf-8",
        )

    @router.api_route(
        (
            "/api/projects/{project_id}/local-picker/sessions/"
            "{session_id}/picker/enable"
        ),
        methods=["POST"],
    )
    async def local_picker_enable(
        project_id: str, session_id: str
    ) -> Response:
        session = await asyncio.wrap_future(
            worker.submit_picker(worker.enable_picker, project_id, session_id)
        )
        return Response(
            content=json({"session": session}),
            status_code=202,
            media_type="application/json; charset=utf-8",
        )

    @router.api_route(
        (
            "/api/projects/{project_id}/local-picker/sessions/"
            "{session_id}/picker-captures"
        ),
        methods=["GET"],
    )
    async def local_picker_captures(
        project_id: str, session_id: str
    ) -> Response:
        session = await asyncio.wrap_future(
            worker.submit_picker(
                worker.picker_session_by_id, project_id, session_id
            )
        )
        return Response(
            content=json({"captures": session.get("captures", [])}),
            status_code=200,
            media_type="application/json; charset=utf-8",
        )

    @router.api_route(
        (
            "/api/projects/{project_id}/local-picker/sessions/"
            "{session_id}/picker-captures/{capture_id}/preview"
        ),
        methods=["POST"],
    )
    async def local_picker_preview(
        request: Request,
        project_id: str,
        session_id: str,
        capture_id: str,
    ) -> Response:
        try:
            body = await request.json()
        except Exception:
            body = {}
        candidate_index = (
            int(body.get("candidateIndex", -1))
            if isinstance(body, dict)
            else -1
        )
        count = await asyncio.wrap_future(
            worker.submit_picker(
                worker.preview_picker_candidate,
                project_id,
                session_id,
                capture_id,
                candidate_index,
            )
        )
        return Response(
            content=json({"captureId": capture_id, "candidateIndex": candidate_index, "count": count}),
            status_code=200,
            media_type="application/json; charset=utf-8",
        )

    @router.api_route(
        (
            "/api/projects/{project_id}/local-picker/sessions/"
            "{session_id}/picker-captures/{capture_id}/confirm"
        ),
        methods=["POST"],
    )
    async def local_picker_confirm(
        request: Request,
        project_id: str,
        session_id: str,
        capture_id: str,
    ) -> Response:
        try:
            body = await request.json()
        except Exception:
            body = {}
        candidate_index = (
            int(body.get("candidateIndex", -1))
            if isinstance(body, dict)
            else -1
        )
        name = body.get("name") if isinstance(body, dict) else None
        result = await asyncio.wrap_future(
            worker.submit_picker(
                worker.confirm_picker_candidate,
                project_id,
                session_id,
                capture_id,
                candidate_index,
                name,
            )
        )
        return Response(
            content=json(result),
            status_code=200,
            media_type="application/json; charset=utf-8",
        )

    @router.api_route(
        (
            "/api/projects/{project_id}/local-picker/sessions/"
            "{session_id}/commands"
        ),
        methods=["POST"],
    )
    async def local_picker_command(
        request: Request,
        project_id: str,
        session_id: str,
    ) -> Response:
        session = await asyncio.wrap_future(
            worker.submit_picker(
                worker.picker_session_by_id, project_id, session_id
            )
        )
        try:
            body = await request.json()
        except Exception:
            body = {}
        command = body.get("command") if isinstance(body, dict) else None
        if command != "stop":
            raise PlatformError(400, "PICKER_COMMAND_INVALID")
        await asyncio.wrap_future(
            worker.submit_picker(worker.end_local_picker_session, session)
        )
        return Response(
            content=json({"ended": True}),
            status_code=200,
            media_type="application/json; charset=utf-8",
        )

    @router.api_route(
        (
            "/api/projects/{project_id}/local-picker/sessions/"
            "{session_id}/screenshot"
        ),
        methods=["GET"],
    )
    async def local_picker_screenshot(
        project_id: str, session_id: str
    ) -> Response:
        screenshot = await asyncio.wrap_future(
            worker.submit_picker(worker.picker_screenshot, project_id, session_id)
        )
        return Response(content=screenshot, media_type="image/png")

    return router
