"""Flow recording kernel: session coordinator（recorder.py 拆分后收窄为协调器）.

录制 MVP 的内核（阶段2-A 拆分）：浏览器采集脚本移入 ``recorder_capture.py``、
纯事件归并器移入 ``recorder_normalizer.py``、事件 DTO 校验与 URL 守卫移入
``recorder_validation.py``；本文件保留 ``RecordingCoordinator``（有界内存会话
协调器）并 shim re-export 上述符号，保持既有 import 路径不变
（``from ..recorder import RecordingCoordinator`` 等）。

录制语义：Playwright 操作一律通过注入的 submit 提交器在专用线程上执行；
登录态按需从 Platform 录制会话的 storage_state 快照注入（只读）。
"""

from __future__ import annotations

import sqlite3
import threading
import time
import uuid
from collections import deque
from copy import deepcopy
from typing import Any, Callable
from urllib.parse import urlsplit

from .browser_session import close_browser_session, launch_browser_session
from .recorder_capture import (
    RECORDER_INIT_SCRIPT,
    RECORDER_INIT_SCRIPT_TEMPLATE,
    recorder_init_script,
)
from .recorder_normalizer import (
    CLICK_SUPPRESSION_MS,
    MAX_LOGICAL_STEPS,
    MEANINGFUL_KEYS,
    NAVIGATION_CAUSALITY_MS,
    RecorderNormalizer,
    _element_key,
)
from .recorder_validation import (
    BROWSER_EVENT_KINDS,
    _bounded_text,
    is_sensitive_field,
    recording_target_url,
    recording_url_is_same_origin,
    sanitize_url,
    url_path,
    validate_recorder_event,
)

MAX_EVENTS = 5000

RECORDING_IDLE_MS = 15 * 60_000
RECORDING_MAX_MS = 2 * 60 * 60_000
RECORDING_PUMP_INTERVAL_MS = 100
# interrupted 为 D6 重启恢复终态：遗留非终态会话在服务重启后被置为它，不可再恢复。
_TERMINAL_STATUSES = {"stopped", "canceled", "expired", "failed", "interrupted"}


MAX_EVENTS = 5000


RECORDING_IDLE_MS = 15 * 60_000
RECORDING_MAX_MS = 2 * 60 * 60_000
RECORDING_PUMP_INTERVAL_MS = 100
_TERMINAL_STATUSES = {"stopped", "canceled", "expired", "failed", "interrupted"}


class _RecordingOperationError(RuntimeError):
    """Internal browser operation failure with a stable public error code."""

    def __init__(self, code: str, cause: BaseException) -> None:
        super().__init__(code)
        self.code = code
        self.cause = cause

class RecordingCoordinator:
    """录制会话的有界内存协调器；Playwright 操作经 submit 提交器串行执行。"""

    def __init__(
        self,
        submit: Callable[..., Any],
        launch: Callable[..., dict[str, Any]] = launch_browser_session,
        idle_ms: int = RECORDING_IDLE_MS,
        max_ms: int = RECORDING_MAX_MS,
        now_ms: Callable[[], int] = lambda: int(time.time() * 1000),
        on_failed: Callable[[dict[str, Any]], None] | None = None,
        on_storage_state: Callable[[dict[str, Any], dict[str, Any]], None] | None = None,
        database: Callable[[], sqlite3.Connection] | None = None,
        max_concurrent: int = 4,
    ) -> None:
        self._submit = submit
        self._launch = launch
        self._idle_ms = idle_ms
        self._max_ms = max_ms
        self._now_ms = now_ms
        self._on_failed = on_failed
        self._on_storage_state = on_storage_state
        self._database = database
        self._max_concurrent = max(1, int(max_concurrent))
        self._lock = threading.RLock()
        self._sessions: dict[str, dict[str, Any]] = {}

    # -- 会话管理 ---------------------------------------------------------

    def create_session(
        self,
        project_id: str,
        flow_id: str,
        environment: dict[str, Any],
        start_url: str,
        *,
        owner_id: str = "",
        fresh_login: bool = False,
        login_state_provider: Callable[[str, str], dict[str, Any] | None] | None = None,
        headless: bool = False,
    ) -> dict[str, Any]:
        from .http import PlatformError

        environment_id = str(environment.get("id") or "")
        if environment.get("browser") != "Chromium":
            raise PlatformError(400, "RECORDING_ENVIRONMENT_UNSUPPORTED")
        base_url = str(environment.get("baseUrl") or "")
        test_id_attribute = str(environment.get("testIdAttribute") or "data-testid")
        target = recording_target_url(base_url, start_url or "/")
        with self._lock:
            active = next(
                (
                    session
                    for session in self._sessions.values()
                    if session["projectId"] == project_id
                    and session["environmentId"] == environment_id
                    and session.get("ownerId") == owner_id
                    and session["status"] not in _TERMINAL_STATUSES
                ),
                None,
            )
            if active is not None:
                raise PlatformError(
                    409, "RECORDING_SESSION_ACTIVE", {"sessionId": active["id"]}
                )
            busy = sum(
                1
                for session in self._sessions.values()
                if session["status"] not in _TERMINAL_STATUSES
            )
            if busy >= self._max_concurrent:
                raise PlatformError(409, "RECORDING_BUSY")
            session_id = f"rec_{uuid.uuid4()}"
            # 先占位 starting，避免并发创建同一项目/环境多个浏览器。
            session = {
                "id": session_id,
                "projectId": project_id,
                "ownerId": owner_id,
                "flowId": flow_id,
                "environmentId": environment_id,
                "environmentName": str(environment.get("name") or ""),
                "baseUrl": base_url,
                "testIdAttribute": test_id_attribute,
                "status": "starting",
                "currentUrl": sanitize_url(target),
                "normalizer": RecorderNormalizer(target, environment_id),
                "events": deque(maxlen=MAX_EVENTS),
                "externalOriginsWarned": set(),
                "lastSeq": 0,
                "createdAt": self._now_ms(),
                "lastActivityAt": self._now_ms(),
                "expiresAt": self._now_ms() + self._max_ms,
                "lastPersistedAt": 0,
                "result": None,
                "browserSession": None,
                "browserFuture": None,
                "browserReady": threading.Event(),
                "startupError": None,
                "errorCode": None,
                "failureNotified": False,
            }
            self._sessions[session_id] = session
        self._persist_session(session)
        storage_state = None
        if not fresh_login and login_state_provider is not None:
            try:
                login_state = login_state_provider(project_id, environment_id)
                # The provider owns its state. Recorder receives one detached,
                # read-only snapshot and must never hand a mutable reference back.
                if isinstance(login_state, dict):
                    storage_state = deepcopy(login_state)
            except Exception:
                # An unreadable snapshot must not make recording unavailable.
                storage_state = None
        try:
            browser_future = self._submit(
                self._run_browser_session, session, target, storage_state, headless
            )
            with self._lock:
                session["browserFuture"] = browser_future
            if not session["browserReady"].wait(timeout=120):
                raise TimeoutError("recording browser did not become ready")
        except Exception:
            code = "RECORDING_BROWSER_START_FAILED"
            with self._lock:
                session["status"] = "failed"
                session["errorCode"] = code
            self._persist_session(session)
            # A startup task may already own a browser while it is blocked in
            # initial navigation. Signal it and give the owner thread a bounded
            # opportunity to close its Playwright resources before returning.
            self._release_browser(session, timeout=10)
            self._notify_failed(session)
            from .http import PlatformError

            raise PlatformError(409, code) from None
        with self._lock:
            startup_error = session.get("startupError")
            if startup_error:
                code = startup_error
                session["status"] = "failed"
                session["errorCode"] = code
                self._persist_session(session)
                self._notify_failed(session)
                from .http import PlatformError

                raise PlatformError(409, code)
            if session["status"] != "starting":
                code = session.get("errorCode") or "RECORDING_BROWSER_START_FAILED"
                self._persist_session(session)
                from .http import PlatformError

                raise PlatformError(409, code)
            session["status"] = "recording"
            self._persist_session(session)
        return self.session_response(session)

    def _run_browser_session(
        self,
        session: dict[str, Any],
        target: str,
        storage_state: dict[str, Any] | None,
        headless: bool,
    ) -> None:
        browser_started = False
        try:
            try:
                browser_session = self._launch(headless, storage_state)
            except Exception as error:
                raise _RecordingOperationError(
                    "RECORDING_BROWSER_START_FAILED", error
                ) from error
            with self._lock:
                if session["status"] != "starting":
                    close_browser_session(browser_session)
                    return
                session["browserSession"] = browser_session
            context = browser_session["context"]
            page = browser_session["page"]
            try:
                context.add_init_script(
                    recorder_init_script(
                        str(session.get("testIdAttribute") or "data-testid")
                    )
                )
                context.expose_binding(
                    "__autoflowRecorderEvent",
                    lambda _source, payload: self._on_browser_event(session, payload),
                )

                def on_navigated(frame: Any) -> None:
                    try:
                        if frame == page.main_frame:
                            self._on_navigation(session, frame.url)
                    except Exception:
                        pass

                page.on("framenavigated", on_navigated)

                def on_unsupported(feature: str):
                    return lambda *_: self._on_unsupported(session, feature)

                page.on("popup", on_unsupported("popup"))
                page.on("filechooser", on_unsupported("filechooser"))
                page.on("download", on_unsupported("download"))
                self._register_close_handlers(session, browser_session, page, context)
            except Exception as error:
                raise _RecordingOperationError(
                    "RECORDING_BROWSER_START_FAILED", error
                ) from error
            try:
                # 使用 commit 而不是 domcontentloaded：页面只要完成导航提交即可开始录制，
                # 避免部分站点因 DOMContentLoaded 延迟或长期不触发而被误判为导航失败。
                page.goto(target, wait_until="commit", timeout=60000)
            except Exception as error:
                # 初始目标不可达时，不直接终止录制：回退到空白页并给出警告，
                # 用户仍可在有头录制浏览器里手动导航到目标站点。
                try:
                    page.goto("about:blank", wait_until="commit", timeout=5000)
                except Exception:
                    raise _RecordingOperationError(
                        "RECORDING_NAVIGATION_FAILED", error
                    ) from error
                normalizer = session.get("normalizer")
                if isinstance(normalizer, RecorderNormalizer):
                    normalizer.warn("初始页面导航失败，已打开空白页，请手动导航到目标页面")

            # Playwright's sync bindings are dispatched only while its owner
            # thread is inside a sync API call. A browser-side promise keeps
            # that protocol call pending while allowing the page event loop to
            # deliver interaction bindings between bounded pump intervals.
            browser_started = callable(getattr(page, "wait_for_timeout", None))
            session["browserReady"].set()
            if not browser_started:
                return
            while True:
                with self._lock:
                    if session["status"] in _TERMINAL_STATUSES:
                        break
                page.wait_for_timeout(RECORDING_PUMP_INTERVAL_MS)
        except _RecordingOperationError as error:
            with self._lock:
                session["startupError"] = error.code
                session["status"] = "failed"
                session["errorCode"] = error.code
            self._persist_session(session)
            self._notify_failed(session)
        except Exception:
            with self._lock:
                if session["status"] not in _TERMINAL_STATUSES:
                    session["status"] = "failed"
                    session["errorCode"] = "RECORDING_BROWSER_DISCONNECTED"
            self._persist_session(session)
            self._notify_failed(session)
        finally:
            session["browserReady"].set()
            # Production pages always run the pump. Test doubles without a
            # pump retain their historical explicit terminal cleanup behavior.
            if browser_started or session.get("status") == "failed":
                self._stop_browser(session)

    def _register_close_handlers(
        self,
        session: dict[str, Any],
        browser_session: dict[str, Any],
        page: Any,
        context: Any,
    ) -> None:
        def on_page_closed(*_args: Any) -> None:
            self._fail_from_browser(session, "RECORDING_PAGE_CLOSED")

        def on_browser_disconnected(*_args: Any) -> None:
            self._fail_from_browser(session, "RECORDING_BROWSER_DISCONNECTED")

        page_on = getattr(page, "on", None)
        if callable(page_on):
            page_on("close", on_page_closed)
        browser = browser_session.get("browser")
        browser_on = getattr(browser, "on", None)
        if callable(browser_on):
            browser_on("disconnected", on_browser_disconnected)
        context_on = getattr(context, "on", None)
        if callable(context_on):
            context_on("close", on_page_closed)

    # -- 事件入口（Playwright 线程回调） ----------------------------------

    def _notify_failed(self, session: dict[str, Any]) -> None:
        callback = None
        with self._lock:
            if session.get("failureNotified"):
                return
            session["failureNotified"] = True
            callback = self._on_failed
        if callback is not None:
            try:
                callback(session)
            except Exception:
                pass

    def _fail_from_browser(self, session: dict[str, Any], code: str) -> None:
        """Transition an externally closed/crashed browser to a safe terminal state."""
        with self._lock:
            if session.get("status") in _TERMINAL_STATUSES:
                return
            session["status"] = "failed"
            session["errorCode"] = code
            session["lastActivityAt"] = self._now_ms()
        self._persist_session(session)
        # A live recording task owns Playwright resources and will observe this
        # terminal state in its bounded pump interval. Completed test doubles
        # do not have a pump, so preserve their explicit cleanup behavior.
        future = session.get("browserFuture")
        if future is None or self._future_is_done(future):
            self._release_browser(session)
        self._notify_failed(session)

    @staticmethod
    def _future_is_done(future: Any) -> bool:
        done = getattr(future, "done", None)
        return bool(done()) if callable(done) else True

    def _release_browser(self, session: dict[str, Any], timeout: int = 30) -> None:
        """Wait for the recording thread to perform terminal cleanup."""
        if session.get("browserSession") is None:
            return
        future = session.get("browserFuture")
        try:
            if future is not None:
                future.result(timeout=timeout)
        except Exception:
            # A running browser task remains the owner of Playwright objects.
            # It will clean up in _run_browser_session's finally block.
            return
        # Synchronous unit-test submitters intentionally do not emulate the
        # production event pump, so their completed tasks still need cleanup.
        if session.get("browserSession") is not None:
            self._stop_browser(session)

    def _on_browser_event(self, session: dict[str, Any], payload: Any) -> None:
        event = validate_recorder_event(payload)
        if event is None:
            return
        changed = False
        with self._lock:
            if session["status"] != "recording":
                session["lastActivityAt"] = self._now_ms()
                changed = True
            elif not recording_url_is_same_origin(session["baseUrl"], event["url"]):
                self._warn_external_origin(session, event["url"])
                session["lastActivityAt"] = self._now_ms()
                changed = True
            else:
                session["lastSeq"] = session["normalizer"].append(event)
                stored = dict(event)
                stored["seq"] = session["lastSeq"]
                session["events"].append(stored)
                session["lastActivityAt"] = self._now_ms()
                changed = True
        if changed:
            self._maybe_persist_events(session)

    def _on_navigation(self, session: dict[str, Any], url: str) -> None:
        event = {
            "kind": "navigate",
            "url": sanitize_url(url),
            "at": self._now_ms(),
        }
        changed = False
        with self._lock:
            session["currentUrl"] = event["url"]
            # starting 阶段也会出现首次加载导航；归并器的首导航逻辑会消费该事件而不
            # 生成重复步骤。暂停/终态期间不产生业务步骤，也不推进业务事件游标。
            if session["status"] not in ("recording", "starting"):
                session["lastActivityAt"] = self._now_ms()
                changed = True
            elif not recording_url_is_same_origin(session["baseUrl"], url):
                self._warn_external_origin(session, url)
                session["lastActivityAt"] = self._now_ms()
                changed = True
            else:
                session["lastSeq"] = session["normalizer"].append(event)
                stored = dict(event)
                stored["seq"] = session["lastSeq"]
                session["events"].append(stored)
                session["lastActivityAt"] = self._now_ms()
                changed = True
        if changed:
            self._maybe_persist_events(session)

    def _warn_external_origin(self, session: dict[str, Any], url: str) -> None:
        parsed = urlsplit(url or "")
        origin = f"{parsed.scheme}://{parsed.netloc}" if parsed.netloc else "unknown"
        warned = session["externalOriginsWarned"]
        if origin in warned:
            return
        warned.add(origin)
        session["normalizer"].warn(
            "检测到外部域导航，未生成可执行步骤"
        )

    def _on_unsupported(self, session: dict[str, Any], feature: str) -> None:
        with self._lock:
            if session["status"] in _TERMINAL_STATUSES:
                return
            session["normalizer"].warn_unsupported(feature)
            session["lastActivityAt"] = self._now_ms()

    # -- 指令 -------------------------------------------------------------

    def pause(self, session_id: str) -> dict[str, Any]:
        session = self._require_session(session_id)
        with self._lock:
            if session["status"] == "recording":
                normalizer = session.get("normalizer")
                if isinstance(normalizer, RecorderNormalizer):
                    normalizer.flush_pending()
                session["status"] = "paused"
                self._persist_session(session)
        return self.session_response(session)

    def resume(self, session_id: str) -> dict[str, Any]:
        session = self._require_session(session_id)
        with self._lock:
            if session["status"] == "paused":
                session["status"] = "recording"
                session["lastActivityAt"] = self._now_ms()
                self._persist_session(session)
        return self.session_response(session)

    def stop(self, session_id: str) -> dict[str, Any]:
        session = self._require_session(session_id)
        with self._lock:
            if session["status"] in _TERMINAL_STATUSES:
                return self.session_response(session)
            session["status"] = "stopped"
            self._persist_session(session)
        self._release_browser(session)
        with self._lock:
            self._prune_terminal_sessions()
        return self.session_response(session)

    def cancel(self, session_id: str) -> dict[str, Any]:
        session = self._require_session(session_id)
        with self._lock:
            if session["status"] in _TERMINAL_STATUSES:
                return self.session_response(session)
            session["status"] = "canceled"
            self._persist_session(session)
        self._release_browser(session)
        with self._lock:
            self._prune_terminal_sessions()
        return self.session_response(session)

    def cancel_active(
        self, project_id: str, environment_id: str, owner_id: str
    ) -> dict[str, Any] | None:
        """Cancel the first active recording session owned by this user.

        Used when the client has lost the session id and needs to reclaim a
        project/environment slot before starting a fresh recording.
        """
        with self._lock:
            active = next(
                (
                    session
                    for session in self._sessions.values()
                    if session["projectId"] == project_id
                    and session["environmentId"] == environment_id
                    and session.get("ownerId") == owner_id
                    and session["status"] not in _TERMINAL_STATUSES
                ),
                None,
            )
            if active is None:
                return None
            session_id = active["id"]
        self.cancel(session_id)
        return self.session_response(self._require_session(session_id))

    def _stop_browser(self, session: dict[str, Any]) -> None:
        browser_session = session.get("browserSession")
        if browser_session is None:
            return
        session["browserSession"] = None
        try:
            session["result"] = session["normalizer"].result()
        finally:
            self._remember_storage_state(session, browser_session)
            # A normalizer failure must not strand Chromium resources.
            close_browser_session(browser_session)

    def _remember_storage_state(
        self, session: dict[str, Any], browser_session: dict[str, Any]
    ) -> None:
        if session.get("status") != "stopped" or self._on_storage_state is None:
            return
        try:
            storage_state = browser_session["context"].storage_state()
            if isinstance(storage_state, dict):
                self._on_storage_state(session, storage_state)
        except Exception:
            # A snapshot is optional; failure must not alter the session result.
            pass

    def _prune_terminal_sessions(self) -> None:
        max_terminal = 100
        terminal = [
            (session_id, session.get("createdAt", 0))
            for session_id, session in self._sessions.items()
            if session.get("status") in _TERMINAL_STATUSES
        ]
        if len(terminal) <= max_terminal:
            return
        terminal.sort(key=lambda item: item[1])
        for session_id, _created in terminal[:-max_terminal]:
            self._sessions.pop(session_id, None)

    # -- 查询 -------------------------------------------------------------

    def _require_session(self, session_id: str) -> dict[str, Any]:
        from .http import PlatformError

        with self._lock:
            session = self._sessions.get(session_id)
        if session is None:
            # 重启后内存无此会话：从持久化元数据还原（仅元数据，无浏览器/归并器）。
            session = self._load_session(session_id)
        if session is None:
            raise PlatformError(404, "RECORDING_SESSION_NOT_FOUND")
        return session

    def session_response(self, session: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            return self._to_response(session)

    def session_result(self, session_id: str) -> dict[str, Any]:
        session = self._require_session(session_id)
        if session["status"] not in _TERMINAL_STATUSES:
            from .http import PlatformError

            raise PlatformError(409, "RECORDING_SESSION_ACTIVE")
        if session.get("result") is None:
            normalizer = session.get("normalizer")
            if isinstance(normalizer, RecorderNormalizer):
                session["result"] = normalizer.result()
            else:
                # 重启后无归并器：返回与 normalizer.result() 同形的空结果。
                session["result"] = {
                    "steps": [],
                    "elements": [],
                    "requiredBindings": [],
                    "warnings": [],
                    "lastSeq": 0,
                }
        return {
            "session": self.session_response(session),
            "result": session["result"],
        }

    # -- D6 元数据持久化 ---------------------------------------------------

    def _db(self) -> sqlite3.Connection | None:
        provider = self._database
        if provider is None:
            return None
        try:
            return provider()
        except Exception:
            return None

    def _persist_session(self, session: dict[str, Any]) -> None:
        """把会话元数据 UPSERT 进 recording_sessions（尽力而为）。

        不持久化浏览器 context / 登录快照 / events / result（D6 折中）。失败静默：
        录制主流程不因元数据落库失败而中断。调用方应持有/重入 ``self._lock``。
        """
        db = self._db()
        if db is None:
            return
        normalizer = session.get("normalizer")
        step_count = (
            normalizer.step_count()
            if isinstance(normalizer, RecorderNormalizer)
            else int(session.get("stepCount") or 0)
        )
        try:
            db.execute(
                """
                INSERT INTO recording_sessions (
                    id, project_id, owner_id, flow_id, environment_id, status,
                    current_url, last_seq, event_count, step_count,
                    created_at, last_activity_at, expires_at, error_code
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    status = excluded.status,
                    current_url = excluded.current_url,
                    last_seq = excluded.last_seq,
                    event_count = excluded.event_count,
                    step_count = excluded.step_count,
                    last_activity_at = excluded.last_activity_at,
                    expires_at = excluded.expires_at,
                    error_code = excluded.error_code
                """,
                (
                    session["id"],
                    session["projectId"],
                    session.get("ownerId") or "",
                    session["flowId"],
                    session["environmentId"],
                    session["status"],
                    session["currentUrl"],
                    session["lastSeq"],
                    len(session["events"]),
                    step_count,
                    session["createdAt"],
                    session["lastActivityAt"],
                    session["expiresAt"],
                    session.get("errorCode"),
                ),
            )
        except Exception:
            # 元数据持久化是尽力而为：失败不得影响录制/指令主流程。
            pass

    def _maybe_persist_events(self, session: dict[str, Any]) -> None:
        """事件级元数据（lastSeq/currentUrl/计数）限频落库：每会话 ≥1s 一次。

        状态迁移走无条件 ``_persist_session``；这里只兜事件高频路径，避免每
        事件一次 SQLite 写（WAL 下每次 commit 的同步开销）拖慢录制线程。
        """
        now = self._now_ms()
        if now - session.get("lastPersistedAt", 0) < 1000:
            return
        self._persist_session(session)
        session["lastPersistedAt"] = now

    @staticmethod
    def _row_to_session(row: Any) -> dict[str, Any]:
        return {
            "id": row[0],
            "projectId": row[1],
            "ownerId": row[2],
            "flowId": row[3],
            "environmentId": row[4],
            "status": row[5],
            "currentUrl": row[6],
            "lastSeq": row[7],
            "eventCount": row[8],
            "stepCount": row[9],
            "createdAt": row[10],
            "lastActivityAt": row[11],
            "expiresAt": row[12],
            "errorCode": row[13],
            "normalizer": None,
            "events": deque(maxlen=MAX_EVENTS),
            "externalOriginsWarned": set(),
            "result": None,
            "browserSession": None,
            "browserFuture": None,
            "browserReady": threading.Event(),
            "failureNotified": True,
        }

    def _load_session(self, session_id: str) -> dict[str, Any] | None:
        db = self._db()
        if db is None:
            return None
        try:
            row = db.execute(
                """
                SELECT id, project_id, owner_id, flow_id, environment_id, status,
                       current_url, last_seq, event_count, step_count,
                       created_at, last_activity_at, expires_at, error_code
                FROM recording_sessions
                WHERE id = ?
                """,
                (session_id,),
            ).fetchone()
        except Exception:
            return None
        return self._row_to_session(row) if row is not None else None

    def _to_response(self, session: dict[str, Any]) -> dict[str, Any]:
        normalizer = session.get("normalizer")
        if isinstance(normalizer, RecorderNormalizer):
            recorded_step_count = normalizer.step_count()
        else:
            # 重启后无归并器：用持久化的 step_count。
            recorded_step_count = int(session.get("stepCount") or 0)
        response = {
            "id": session["id"],
            "projectId": session["projectId"],
            "flowId": session["flowId"],
            "environmentId": session["environmentId"],
            "status": session["status"],
            "currentUrl": session["currentUrl"],
            "lastSeq": session["lastSeq"],
            "recordedStepCount": recorded_step_count,
            "startedAt": session["createdAt"],
            "lastActivityAt": session["lastActivityAt"],
        }
        if session.get("errorCode"):
            response["errorCode"] = session["errorCode"]
        return response

    def recover_interrupted(self) -> int:
        """重启恢复：把遗留非终态会话标记为 interrupted 终态。

        返回受影响行数；无数据库提供者或失败时返回 0（尽力而为）。
        """
        db = self._db()
        if db is None:
            return 0
        try:
            rows = db.execute(
                """
                UPDATE recording_sessions
                SET status = 'interrupted',
                    error_code = COALESCE(error_code, 'SERVICE_RESTARTED')
                WHERE status NOT IN (
                    'stopped', 'canceled', 'expired', 'failed', 'interrupted'
                )
                """
            ).rowcount
            return rows or 0
        except Exception:
            return 0

    def list_sessions(
        self, project_id: str, owner_id: str, page: int, page_size: int
    ) -> dict[str, Any]:
        """项目内最近会话（含已中断/已结束），按最近活动倒序分页。"""
        db = self._db()
        empty = {
            "sessions": [],
            "total": 0,
            "page": page,
            "pageSize": page_size,
        }
        if db is None:
            return empty
        try:
            total = db.execute(
                """
                SELECT COUNT(*) FROM recording_sessions
                WHERE project_id = ? AND owner_id = ?
                """,
                (project_id, owner_id),
            ).fetchone()[0]
            rows = db.execute(
                """
                SELECT id, project_id, owner_id, flow_id, environment_id, status,
                       current_url, last_seq, event_count, step_count,
                       created_at, last_activity_at, expires_at, error_code
                FROM recording_sessions
                WHERE project_id = ? AND owner_id = ?
                ORDER BY last_activity_at DESC
                LIMIT ? OFFSET ?
                """,
                (project_id, owner_id, page_size, (page - 1) * page_size),
            ).fetchall()
        except Exception:
            return empty
        return {
            "sessions": [self._to_response(self._row_to_session(row)) for row in rows],
            "total": total,
            "page": page,
            "pageSize": page_size,
        }

    def events_after(self, session_id: str, after_seq: int, limit: int = 100) -> dict[str, Any]:
        session = self._require_session(session_id)
        try:
            after_seq = int(after_seq)
        except (TypeError, ValueError):
            from .http import PlatformError

            raise PlatformError(400, "RECORDING_AFTER_SEQ_INVALID") from None
        if after_seq < 0:
            from .http import PlatformError

            raise PlatformError(400, "RECORDING_AFTER_SEQ_INVALID")
        try:
            limit = int(limit)
        except (TypeError, ValueError):
            from .http import PlatformError

            raise PlatformError(400, "RECORDING_LIMIT_INVALID") from None
        if limit < 1 or limit > 500:
            from .http import PlatformError

            raise PlatformError(400, "RECORDING_LIMIT_INVALID")
        with self._lock:
            events = [
                event for event in session["events"] if event.get("seq", 0) > after_seq
            ]
            page_events = events[:limit]
            has_more = len(events) > len(page_events)
            last_seq = session["lastSeq"]
        return {"events": page_events, "lastSeq": last_seq, "hasMore": has_more}

    # -- 生命周期清扫 -----------------------------------------------------

    def sweep_expired(self) -> list[str]:
        expired: list[str] = []
        now = self._now_ms()
        with self._lock:
            candidates = [
                session
                for session in self._sessions.values()
                if session["status"] not in _TERMINAL_STATUSES
                and (
                    session["lastActivityAt"] + self._idle_ms < now
                    or session["expiresAt"] < now
                )
            ]
            for session in candidates:
                session["status"] = "expired"
                expired.append(session["id"])
        for session_id in expired:
            session = self._sessions.get(session_id)
            if session is not None:
                self._persist_session(session)
                self._release_browser(session)
        with self._lock:
            self._prune_terminal_sessions()
        return expired

    def close_all(self) -> None:
        with self._lock:
            sessions = [
                session
                for session in self._sessions.values()
                if session["status"] not in _TERMINAL_STATUSES
            ]
            for session in sessions:
                session["status"] = "expired"
        for session in sessions:
            self._persist_session(session)
            self._release_browser(session)
