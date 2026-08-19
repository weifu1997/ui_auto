import base64
import io
import threading
import time
import uuid
from collections import OrderedDict
from typing import Any

from .browser_session import close_browser_session, launch_browser_session
from .recorder import RECORDER_INIT_SCRIPT, _element_key


class LocalPickerCoordinator:
    """本地元素选取协调器：启动有头浏览器，记录点击事件，生成候选定位器。"""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._sessions: OrderedDict[str, dict[str, Any]] = OrderedDict()

    def list_sessions(self, project_id: str) -> list[dict[str, Any]]:
        with self._lock:
            return [self._public(s) for s in self._sessions.values() if s["projectId"] == project_id]

    def create_session(
        self,
        project_id: str,
        environment: dict[str, Any],
        start_url: str = "",
    ) -> dict[str, Any]:
        environment_id = str(environment.get("id") or "")
        base_url = str(environment.get("baseUrl") or "")
        test_id_attribute = str(environment.get("testIdAttribute") or "data-testid")
        from urllib.parse import urljoin
        target = urljoin(base_url, start_url or "/")
        with self._lock:
            existing = next(
                (s for s in self._sessions.values() if s["environmentId"] == environment_id and s["status"] not in ("stopped", "failed")),
                None,
            )
            if existing:
                return self._public(existing)
            session_id = f"lp_{uuid.uuid4()}"
            session = {
                "id": session_id,
                "projectId": project_id,
                "environmentId": environment_id,
                "environmentName": str(environment.get("name") or ""),
                "status": "starting",
                "currentUrl": target,
                "captures": [],
                "browserSession": None,
                "browserFuture": None,
                "browserReady": threading.Event(),
                "errorCode": None,
                "screenshot_data_url": None,
                "lastScreenshotAt": 0,
            }
            self._sessions[session_id] = session

        future = threading.Thread(
            target=self._run_browser,
            args=(session_id, target),
            daemon=True,
        )
        future.start()
        with self._lock:
            session["browserFuture"] = future
        if not session["browserReady"].wait(timeout=120):
            with self._lock:
                if session["status"] == "starting":
                    session["status"] = "failed"
                    session["errorCode"] = "LOCAL_PICKER_BROWSER_TIMEOUT"
        return self._public(session_id)

    def get_session(self, session_id: str) -> dict[str, Any] | None:
        with self._lock:
            session = self._sessions.get(session_id)
            return self._public(session_id) if session else None

    def enable_picker(self, session_id: str) -> dict[str, Any] | None:
        with self._lock:
            session = self._sessions.get(session_id)
            if session is None:
                return None
            if session["status"] == "running":
                session["status"] = "recording"
                session["enableRequested"] = True
        return self._public(session_id) if session else None

    def stop_session(self, session_id: str) -> dict[str, Any] | None:
        with self._lock:
            session = self._sessions.get(session_id)
            if session is None:
                return None
            if session["status"] not in ("stopped", "failed"):
                session["status"] = "stopped"
                self._close_browser(session)
        return self._public(session_id) if session else None

    def get_captures(self, session_id: str) -> list[dict[str, Any]]:
        with self._lock:
            session = self._sessions.get(session_id)
            if session is None:
                return []
            return [self._public_capture(c) for c in session["captures"]]

    def preview_candidate(self, session_id: str, capture_id: str, candidate_index: int) -> dict[str, Any]:
        with self._lock:
            session = self._sessions.get(session_id)
            if session is None:
                return {"ok": False}
            capture = next((c for c in session["captures"] if c["id"] == capture_id), None)
        if capture is None:
            return {"ok": False}
        candidate = capture["candidates"][candidate_index] if 0 <= candidate_index < len(capture["candidates"]) else None
        if candidate is None:
            return {"ok": False}
        browser_session = session.get("browserSession")
        if browser_session is None:
            return {"ok": False}
        try:
            from playwright.sync_api import sync_playwright
            playwright = sync_playwright().start()
            context = browser_session["context"]
            page = browser_session["page"]
            method = candidate["method"]
            value = candidate["value"]
            locator = None
            try:
                if method == "testid":
                    locator = page.get_by_test_id(value)
                elif method == "role":
                    locator = page.get_by_role(value.split("[")[0], name=value.split('name="')[1].rstrip('"]') if 'name="' in value else None)
                elif method == "label":
                    locator = page.get_by_label(value)
                elif method == "text":
                    locator = page.get_by_text(value, exact=True)
                elif method == "CSS":
                    locator = page.locator(value)
                if locator:
                    locator.highlight()
            except Exception:
                pass
            playwright.stop()
        except Exception:
            pass
        return {"ok": True}

    def confirm_candidate(
        self, session_id: str, capture_id: str, candidate_index: int, name: str = ""
    ) -> dict[str, Any] | None:
        with self._lock:
            session = self._sessions.get(session_id)
            if session is None:
                return None
            capture = next((c for c in session["captures"] if c["id"] == capture_id), None)
        if capture is None:
            return None
        candidate = capture["candidates"][candidate_index] if 0 <= candidate_index < len(capture["candidates"]) else None
        if candidate is None:
            return None
        suggested = name or capture.get("text") or candidate["value"][:40] or "元素"
        return {
            "capture": self._public_capture(capture),
            "candidate": candidate,
            "path": capture.get("path") or "/",
            "environmentId": session["environmentId"],
            "suggestedName": suggested,
        }

    def get_screenshot(self, session_id: str) -> str | None:
        with self._lock:
            session = self._sessions.get(session_id)
            if session is None:
                return None
            return session.get("screenshot_data_url")

    def _public(self, session_id: str) -> dict[str, Any]:
        session = self._sessions.get(session_id)
        if session is None:
            return {}
        return {
            "id": session["id"],
            "projectId": session["projectId"],
            "environmentId": session["environmentId"],
            "environmentName": session["environmentName"],
            "status": session["status"],
            "currentUrl": session["currentUrl"],
            "createdAt": int(time.time.time() * 1000),
            "elementCount": len(session.get("captures", [])),
        }

    def _public_capture(self, capture: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": capture["id"],
            "seq": capture.get("seq", 0),
            "tag": capture.get("tag", ""),
            "text": capture.get("text", ""),
            "candidates": capture.get("candidates", []),
        }

    def _close_browser(self, session: dict[str, Any]) -> None:
        browser_session = session.get("browserSession")
        if browser_session is not None:
            try:
                close_browser_session(browser_session)
            except Exception:
                pass
            session["browserSession"] = None

    def _run_browser(self, session_id: str, target: str) -> None:
        browser_session = None
        try:
            browser_session = launch_browser_session(headless=False)
        except Exception as error:
            with self._lock:
                session = self._sessions.get(session_id)
                if session:
                    session["status"] = "failed"
                    session["errorCode"] = "LOCAL_PICKER_BROWSER_START_FAILED"
            return

        with self._lock:
            session = self._sessions.get(session_id)
            if session is None:
                close_browser_session(browser_session)
                return
            session["browserSession"] = browser_session

        context = browser_session["context"]
        page = browser_session["page"]
        try:
            context.add_init_script(RECORDER_INIT_SCRIPT)
            context.expose_binding(
                "__autoflowRecorderEvent",
                lambda _source, payload: self._on_browser_event(session_id, payload),
            )
        except Exception as error:
            with self._lock:
                session = self._sessions.get(session_id)
                if session:
                    session["status"] = "failed"
                    session["errorCode"] = "LOCAL_PICKER_SCRIPT_INJECT_FAILED"
                    self._close_browser(session)
            return

        try:
            page.goto(target, wait_until="commit", timeout=60000)
        except Exception:
            try:
                page.goto("about:blank", wait_until="commit", timeout=5000)
            except Exception:
                pass

        with self._lock:
            session = self._sessions.get(session_id)
            if session:
                session["browserReady"].set()
                if session["status"] == "starting":
                    session["status"] = "running"

        try:
            while True:
                with self._lock:
                    session = self._sessions.get(session_id)
                    if session is None or session["status"] in ("stopped", "failed"):
                        break
                try:
                    page.wait_for_timeout(500)
                    self._capture_screenshot(session_id, page)
                except Exception:
                    break
        except Exception:
            pass
        finally:
            with self._lock:
                session = self._sessions.get(session_id)
                if session and session["status"] not in ("stopped", "failed"):
                    session["status"] = "stopped"
                    self._close_browser(session)

    def _capture_screenshot(self, session_id: str, page: Any) -> None:
        try:
            screenshot_bytes = page.screenshot(type="png", timeout=5000)
            data_url = "data:image/png;base64," + base64.b64encode(screenshot_bytes).decode("ascii")
            with self._lock:
                session = self._sessions.get(session_id)
                if session:
                    session["screenshot_data_url"] = data_url
                    session["lastScreenshotAt"] = int(time.time.time() * 1000)
        except Exception:
            pass

    def _on_browser_event(self, session_id: str, payload: dict[str, Any]) -> None:
        with self._lock:
            session = self._sessions.get(session_id)
            if session is None or session["status"] not in ("running", "recording"):
                return
            kind = str(payload.get("kind") or "")
            element = payload.get("element")
            url = str(payload.get("url") or "")

            if kind == "navigate" and url:
                session["currentUrl"] = url
                return

            if kind == "click" and isinstance(element, dict):
                key = _element_key(element)
                if key and key != "page":
                    candidates = self._build_candidates(element)
                    capture_id = f"cap-{session_id[-8:]}-{len(session['captures']) + 1}"
                    capture = {
                        "id": capture_id,
                        "seq": int(payload.get("seq") or (len(session["captures"]) + 1)),
                        "tag": str(element.get("tag") or ""),
                        "text": str(element.get("text") or "")[:40],
                        "path": self._url_path(url or session.get("currentUrl") or "/"),
                        "element": element,
                        "candidates": candidates,
                    }
                    session["captures"].insert(0, capture)
                    if len(session["captures"]) > 50:
                        session["captures"] = session["captures"][:50]

    def _build_candidates(self, element: dict[str, Any]) -> list[dict[str, Any]]:
        candidates = []
        testid = str(element.get("testid") or "")
        role = str(element.get("role") or "")
        accessible = str(element.get("accessibleName") or "").strip()
        label = str(element.get("label") or "")
        text = str(element.get("text") or "")
        css = str(element.get("css") or "")

        if testid:
            candidates.append({"method": "testid", "value": testid, "count": 1, "score": 100, "label": "testid 匹配"})
        if role and accessible:
            val = f'{role}[name="{accessible}"]'
            candidates.append({"method": "role", "value": val, "count": 1, "score": 90, "label": "role+name 匹配"})
        if label:
            candidates.append({"method": "label", "value": label, "count": 1, "score": 80, "label": "label 匹配"})
        if text:
            candidates.append({"method": "text", "value": text[:40], "count": 1, "score": 70, "label": "text 匹配"})
        if css:
            candidates.append({"method": "CSS", "value": css, "count": 1, "score": 50, "label": "CSS 匹配"})

        if not candidates:
            tag = str(element.get("tag") or "")
            if tag:
                candidates.append({"method": "CSS", "value": tag, "count": 1, "score": 10, "label": "tag 匹配"})
        return candidates

    @staticmethod
    def _url_path(url: str) -> str:
        from urllib.parse import urlparse
        try:
            return urlparse(url).path or "/"
        except Exception:
            return "/"
