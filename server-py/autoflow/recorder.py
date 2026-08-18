"""Flow recording kernel: browser capture script, pure event normalizer and session coordinator.

录制 MVP 的内核（Phase 0 PoC 验证通过，Phase 1 补齐会话生命周期）：

- ``RECORDER_INIT_SCRIPT`` 由 ``context.add_init_script`` 注入，在浏览器侧采集
  click/input/change/keydown 并做敏感字段判定；敏感输入的值不发送（双层防线
  的第一层，服务端 ``is_sensitive_field`` 为第二层）。
- ``RecorderNormalizer`` 是纯逻辑归并器：事件流进，可编辑、可由现有 runner 重放
  的 FlowStep/ElementAsset 草稿 DTO 出。不含 Playwright 依赖，可用事件序列单测。
- ``validate_recorder_event`` / ``recording_target_url`` / ``RecordingCoordinator``
  负责 DTO 校验、起始 URL 同源规则和有界内存会话生命周期（seq、暂停/继续、
  stop flush、取消、过期回收）。Playwright 操作一律通过注入的 submit 提交器
  在专用线程上执行；登录态按需从 Platform 录制会话的 storage_state 快照注入（只读）。
"""

from __future__ import annotations

import re
import threading
import time
import uuid
from collections import deque
from copy import deepcopy
from typing import Any, Callable
from urllib.parse import urljoin, urlsplit, urlunsplit

from .browser_session import close_browser_session, launch_browser_session

SENSITIVE_FIELD_PATTERN = re.compile(
    r"password|passwd|secret|token|api[-_ ]?key|credential", re.IGNORECASE
)
NAVIGATION_CAUSALITY_MS = 1500
CLICK_SUPPRESSION_MS = 15000
MEANINGFUL_KEYS = ("Enter", "Escape", "Tab")
MAX_LOGICAL_STEPS = 1000

RECORDER_INIT_SCRIPT = r"""
(() => {
  if (window.__autoflowRecorderInstalled) return;
  window.__autoflowRecorderInstalled = true;
  const SENSITIVE = /password|passwd|secret|token|api[-_ ]?key|credential/i;
  const frameKind = () => (window.top === window ? "top" : "child");
  const safeUrl = () => location.protocol + "//" + location.host + location.pathname;
  const labelText = (el) => {
    if (el.labels && el.labels.length) return (el.labels[0].textContent || "").trim();
    const aria = el.getAttribute("aria-label");
    return aria ? aria.trim() : "";
  };
  const roleFor = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a" && el.getAttribute("href")) return "link";
    if (tag === "select") return "combobox";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "button" || type === "submit") return "button";
    }
    return "";
  };
  const cssPath = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      let selector = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(selector + "#" + node.id);
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (child) => child.tagName === node.tagName,
        );
        if (siblings.length > 1) {
          selector += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")";
        }
      }
      parts.unshift(selector);
      node = node.parentElement;
    }
    return parts.join(">");
  };
  const descriptor = (el) => ({
    tag: el.tagName.toLowerCase(),
    type: (el.getAttribute("type") || "").toLowerCase(),
    name: el.getAttribute("name") || "",
    id: el.id || "",
    label: labelText(el),
    autocomplete: el.getAttribute("autocomplete") || "",
    role: roleFor(el),
    accessibleName: labelText(el) || (el.getAttribute("aria-label") || "").trim(),
    testid: el.getAttribute("data-testid") || "",
    text: (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60),
    css: cssPath(el),
    contenteditable: Boolean(el.isContentEditable || el.getAttribute("contenteditable") === "true"),
  });
  const sensitiveFor = (el, desc) =>
    (el.tagName === "INPUT" && desc.type === "password") ||
    SENSITIVE.test(
      [desc.name, desc.id, desc.label, el.getAttribute("autocomplete") || ""].join(" "),
    );
  const emit = (payload) => {
    try {
      window.__autoflowRecorderEvent(
        Object.assign({ frame: frameKind(), url: safeUrl(), at: Date.now() }, payload),
      );
    } catch (error) {
      /* binding 在会话回收后不可用，忽略 */
    }
  };
  const target = (event) =>
    event.target instanceof HTMLElement
      ? event.target
      : event.target && event.target.parentElement instanceof HTMLElement
        ? event.target.parentElement
        : null;
  const unsupportedFeature = (event, el) => {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    if (path.some((node) => typeof ShadowRoot !== "undefined" && node instanceof ShadowRoot)) {
      return "shadow-dom";
    }
    if (el && (el.isContentEditable || el.getAttribute("contenteditable") === "true")) {
      return "contenteditable";
    }
    return "";
  };
  const emitUnsupported = (event, feature) => {
    const el = target(event);
    emit({
      kind: "unsupported",
      feature,
      element: el ? descriptor(el) : null,
    });
  };
  document.addEventListener(
    "click",
    (event) => {
      const el = target(event);
      if (!el) return;
      const unsupported = unsupportedFeature(event, el);
      if (unsupported) {
        emitUnsupported(event, unsupported);
        return;
      }
      const desc = descriptor(el);
      emit({ kind: "click", element: desc, sensitive: sensitiveFor(el, desc) });
    },
    true,
  );
  document.addEventListener(
    "input",
    (event) => {
      const el = event.target;
      if (el instanceof HTMLElement) {
        const unsupported = unsupportedFeature(event, el);
        if (unsupported) {
          emitUnsupported(event, unsupported);
          return;
        }
      }
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
      const desc = descriptor(el);
      if (desc.type === "checkbox" || desc.type === "radio") return;
      const sensitive = sensitiveFor(el, desc);
      emit({
        kind: "input",
        element: desc,
        sensitive,
        value: sensitive ? null : String(el.value || ""),
      });
    },
    true,
  );
  document.addEventListener(
    "change",
    (event) => {
      const el = event.target;
      if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement)) return;
      const unsupported = unsupportedFeature(event, el);
      if (unsupported) {
        emitUnsupported(event, unsupported);
        return;
      }
      const desc = descriptor(el);
      const payload = {
        kind: "change",
        element: desc,
        sensitive: sensitiveFor(el, desc),
      };
      if (el instanceof HTMLSelectElement) payload.selectedValue = el.value;
      else payload.checked = Boolean(el.checked);
      emit(payload);
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (!["Enter", "Escape", "Tab"].includes(event.key)) return;
      const el = target(event);
      const unsupported = unsupportedFeature(event, el);
      if (unsupported) {
        emitUnsupported(event, unsupported);
        return;
      }
      emit({ kind: "keydown", key: event.key, element: el ? descriptor(el) : null });
    },
    true,
  );
  ["dragstart", "drop"].forEach((kind) => {
    document.addEventListener(kind, (event) => emitUnsupported(event, "drag"), true);
  });
})();
"""


def sanitize_url(url: str) -> str:
    parsed = urlsplit(url or "")
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return ""
    # 去掉 userinfo，避免凭据进入事件/步骤/日志。
    netloc = parsed.netloc.rsplit("@", 1)[-1]
    return f"{parsed.scheme}://{netloc}{parsed.path or '/'}"


def url_path(url: str) -> str:
    parsed = urlsplit(url or "")
    return parsed.path or "/"


def is_sensitive_field(element: dict[str, Any] | None) -> bool:
    if not isinstance(element, dict):
        return False
    if str(element.get("type") or "").lower() == "password":
        return True
    haystack = " ".join(
        str(element.get(field) or "")
        for field in ("name", "id", "label", "accessibleName", "autocomplete")
    )
    return bool(SENSITIVE_FIELD_PATTERN.search(haystack))


def _element_key(element: dict[str, Any] | None) -> str:
    if not isinstance(element, dict):
        return "page"
    if element.get("testid"):
        return f"testid:{element['testid']}"
    if element.get("id"):
        return f"id:{element['id']}"
    return "|".join(
        str(element.get(field) or "")
        for field in ("tag", "type", "name", "label", "css")
    )


class RecorderNormalizer:
    """把浏览器事件流归并为 FlowStep/ElementAsset 草稿的纯状态机。"""

    def __init__(self, start_url: str = "", environment_id: str = "") -> None:
        self._seq = 0
        self._steps: list[dict[str, Any]] = []
        self._elements: dict[str, dict[str, Any]] = {}
        self._names: set[str] = set()
        self._pending: dict[str, Any] | None = None
        self._last_change: tuple[str, int] | None = None
        self._last_click_at: int | None = None
        self._warnings: list[str] = []
        self._unsupported_features: set[str] = set()
        self._required_bindings: list[dict[str, str]] = []
        self._first_navigation = True
        self._environment_id = environment_id
        self._current_path = "/"
        self._start_url = sanitize_url(start_url)
        if self._start_url:
            self._current_path = url_path(self._start_url)
            self._append_step("打开页面", None, value=self._current_path)

    def append(self, event: dict[str, Any]) -> int:
        self._seq += 1
        seq = self._seq
        if not isinstance(event, dict):
            return seq
        kind = str(event.get("kind") or "")
        at = int(event.get("at") or 0)
        event_url = event.get("url")
        if isinstance(event_url, str) and event_url:
            path = url_path(event_url)
            if path:
                self._current_path = path
        if event.get("frame", "top") != "top":
            self._warnings.append(f"seq={seq}：iframe 内事件不生成步骤")
            return seq
        element = event.get("element") if isinstance(event.get("element"), dict) else None
        key = _element_key(element)
        if kind == "navigate":
            self._note_navigation(str(event.get("url") or ""), at)
        elif kind == "click":
            self._handle_click(element, key, at)
        elif kind == "input":
            sensitive = bool(event.get("sensitive")) or is_sensitive_field(element)
            value = None if sensitive else str(event.get("value") or "")
            self._handle_input(element, key, value, sensitive)
        elif kind == "change":
            self._handle_change(element, key, event, at)
        elif kind == "keydown":
            key_name = str(event.get("key") or "")
            if key_name in MEANINGFUL_KEYS:
                self._flush_pending()
                self._append_step("键盘按键", element, value=key_name)
        elif kind == "unsupported":
            feature = str(event.get("feature") or "unsupported")
            self.warn_unsupported(feature)
        elif kind in ("dragstart", "dragover", "drop"):
            self.warn_unsupported("drag")
        return seq

    def note_navigation(self, url: str, at: int = 0) -> None:
        self.append({"kind": "navigate", "url": url, "at": at})

    def warn(self, message: str) -> None:
        self._warnings.append(message)

    def warn_unsupported(self, feature: str) -> None:
        """Add one warning per unsupported behavior, even for noisy DOM events."""
        normalized = feature.strip() or "unsupported"
        if normalized in self._unsupported_features:
            return
        self._unsupported_features.add(normalized)
        self.warn(f"检测到不支持的 {normalized} 行为，未生成可执行步骤")

    def result(self) -> dict[str, Any]:
        self._flush_pending()
        steps = [
            {key: value for key, value in step.items() if not key.startswith("__")}
            for step in self._steps
        ]
        return {
            "steps": steps,
            "elements": [dict(element) for element in self._elements.values()],
            "requiredBindings": list(self._required_bindings),
            "warnings": list(self._warnings),
            "lastSeq": self._seq,
        }

    def step_count(self) -> int:
        """Return a non-mutating preview count for the recording toolbar."""
        return len(self._steps) + (1 if self._pending is not None else 0)

    def flush_pending(self) -> None:
        """Commit an in-progress input at an explicit recording boundary."""
        self._flush_pending()

    def _note_navigation(self, url: str, at: int) -> None:
        target = sanitize_url(url)
        if not target:
            return
        if self._first_navigation:
            self._first_navigation = False
            if not self._steps:
                self._append_step("打开页面", None, value=url_path(target))
            return
        if self._last_click_at is not None and 0 <= at - self._last_click_at <= NAVIGATION_CAUSALITY_MS:
            return
        self._flush_pending()
        self._append_step("打开页面", None, value=url_path(target))

    def _handle_click(self, element: dict[str, Any], key: str, at: int) -> None:
        tag = str(element.get("tag") or "")
        input_type = str(element.get("type") or "")
        if tag in ("input", "textarea") and input_type not in (
            "button",
            "submit",
            "checkbox",
            "radio",
        ):
            return
        if (
            self._last_change is not None
            and self._last_change[0] == key
            and 0 <= at - self._last_change[1] <= CLICK_SUPPRESSION_MS
        ):
            return
        self._last_click_at = at
        self._flush_pending()
        step = self._append_step("点击", element)
        step["__elementKey"] = key
        step["__at"] = at

    def _handle_input(
        self,
        element: dict[str, Any],
        key: str,
        value: str | None,
        sensitive: bool,
    ) -> None:
        if str(element.get("type") or "") in ("checkbox", "radio"):
            return
        if self._pending is not None and self._pending["key"] != key:
            self._flush_pending()
        if self._pending is None:
            self._pending = {"key": key, "element": element}
        self._pending["value"] = value
        self._pending["sensitive"] = sensitive or is_sensitive_field(element)

    def _handle_change(
        self,
        element: dict[str, Any],
        key: str,
        event: dict[str, Any],
        at: int,
    ) -> None:
        tag = str(element.get("tag") or "")
        input_type = str(element.get("type") or "")
        if tag == "select":
            self._suppress_recent_click(key, at)
            self._flush_pending()
            self._append_step(
                "选择下拉项", element, value=str(event.get("selectedValue") or "")
            )
            self._last_change = (key, at)
        elif input_type in ("checkbox", "radio"):
            self._suppress_recent_click(key, at)
            self._flush_pending()
            if event.get("checked"):
                self._append_step("勾选", element)
            else:
                self._warnings.append("取消勾选暂不支持，未生成步骤")
            self._last_change = (key, at)

    def _suppress_recent_click(self, key: str, at: int) -> None:
        if not self._steps:
            return
        last = self._steps[-1]
        if (
            last.get("action") == "点击"
            and last.get("__elementKey") == key
            and 0 <= at - int(last.get("__at") or 0) <= CLICK_SUPPRESSION_MS
        ):
            self._steps.pop()

    def _flush_pending(self) -> None:
        if self._pending is None:
            return
        pending = self._pending
        self._pending = None
        if pending.get("sensitive"):
            step = self._append_step("填写", pending["element"], value=None)
            self._required_bindings.append(
                {"stepId": step["id"], "fieldHint": self._field_hint(pending["element"])}
            )
            return
        value = str(pending.get("value") or "")
        self._append_step(
            "清空填写" if value == "" else "填写", pending["element"], value=value
        )

    def _field_hint(self, element: dict[str, Any]) -> str:
        for field in ("name", "id", "testid", "label"):
            value = str(element.get(field) or "")
            if value:
                return value
        return str(_element_key(element))

    def _append_step(
        self,
        action: str,
        element: dict[str, Any] | None,
        value: str | None = None,
    ) -> dict[str, Any]:
        if len(self._steps) >= MAX_LOGICAL_STEPS:
            self._warnings.append("已达单次录制步骤上限，后续事件被忽略")
            return self._steps[-1]
        step: dict[str, Any] = {
            "id": f"rec-{len(self._steps) + 1}",
            "action": action,
            "title": action,
            "value": value,
        }
        if element is not None:
            asset = self._element_for(element)
            step["element"] = asset["name"]
            step["title"] = f"{action} · {asset['name']}"
        self._steps.append(step)
        return step

    def _element_for(self, element: dict[str, Any]) -> dict[str, Any]:
        key = _element_key(element)
        existing = self._elements.get(key)
        if existing is not None:
            return existing
        candidate = self._candidate(element)
        name = self._unique_name(element)
        asset = {
            "id": f"element-rec-{len(self._elements) + 1}",
            "name": name,
            "path": self._current_path or "/",
            "method": candidate["method"],
            "value": candidate["value"],
            "environment": self._environment_id,
            "description": "",
            "validation": "unverified",
        }
        self._elements[key] = asset
        return asset

    def _candidate(self, element: dict[str, Any]) -> dict[str, str]:
        role = str(element.get("role") or "")
        accessible = str(element.get("accessibleName") or "").strip()
        if element.get("testid"):
            return {"method": "testid", "value": str(element["testid"])}
        if role and accessible:
            return {"method": "role", "value": f'{role}[name="{accessible}"]'}
        if element.get("label"):
            return {"method": "label", "value": str(element["label"])}
        if element.get("text"):
            return {"method": "text", "value": str(element["text"])}
        return {"method": "css", "value": str(element.get("css") or "")}

    def _unique_name(self, element: dict[str, Any]) -> str:
        base = (
            str(element.get("label") or element.get("testid") or "")
            or str(element.get("accessibleName") or "")
            or str(element.get("text") or "")
            or str(element.get("role") or element.get("tag") or "元素")
        ).strip()[:40]
        if base not in self._names:
            self._names.add(base)
            return base
        index = 2
        while f"{base} {index}" in self._names:
            index += 1
        name = f"{base} {index}"
        self._names.add(name)
        return name

MAX_EVENTS = 5000
BROWSER_EVENT_KINDS = {
    "click",
    "input",
    "change",
    "keydown",
    "unsupported",
    "dragstart",
    "dragover",
    "drop",
}
RECORDING_IDLE_MS = 15 * 60_000
RECORDING_MAX_MS = 2 * 60 * 60_000
_TERMINAL_STATUSES = {"stopped", "canceled", "expired", "failed"}


class _RecordingOperationError(RuntimeError):
    """Internal browser operation failure with a stable public error code."""

    def __init__(self, code: str, cause: BaseException) -> None:
        super().__init__(code)
        self.code = code
        self.cause = cause


def recording_target_url(base_url: str, start_url: str) -> str:
    """起始 URL 校验：仅 http/https、禁止 userinfo、必须与环境 baseUrl 同源。"""
    from .http import PlatformError

    try:
        base = urlsplit(base_url or "")
        # Accessing ``port`` validates malformed values such as ``:abc``.
        base_port = base.port
    except ValueError:
        raise PlatformError(400, "RECORDING_ENVIRONMENT_INVALID") from None
    if base.scheme not in ("http", "https") or not base.netloc:
        raise PlatformError(400, "RECORDING_ENVIRONMENT_INVALID")
    try:
        target = urlsplit(urljoin(base_url, start_url or "/"))
        target_port = target.port
    except ValueError:
        # urllib raises ValueError for malformed ports/IPv6 instead of giving us
        # a predictable validation result. Never let that become a 500 response.
        raise PlatformError(400, "RECORDING_START_URL_INVALID") from None
    if (
        target.scheme not in ("http", "https")
        or not target.netloc
        or target.username
        or target.password
        or base.username
        or base.password
        or target.scheme != base.scheme
        or (target.hostname or "") != (base.hostname or "")
        or target_port != base_port
    ):
        raise PlatformError(400, "RECORDING_START_URL_INVALID")
    return urlunsplit((target.scheme, target.netloc, target.path or "/", target.query, ""))


def recording_url_is_same_origin(base_url: str, target_url: str) -> bool:
    """Return whether a captured browser URL remains inside the environment origin."""
    try:
        base = urlsplit(base_url or "")
        target = urlsplit(target_url or "")
        base_port = base.port
        target_port = target.port
    except ValueError:
        return False
    return (
        base.scheme in ("http", "https")
        and target.scheme in ("http", "https")
        and base.scheme == target.scheme
        and (base.hostname or "") == (target.hostname or "")
        and base_port == target_port
    )


def _bounded_text(value: Any, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    return value.strip()[:limit]


def validate_recorder_event(payload: Any) -> dict[str, Any] | None:
    """把浏览器事件 payload 收敛为受信 DTO；不合法时返回 None 丢弃。"""
    if not isinstance(payload, dict):
        return None
    kind = str(payload.get("kind") or "")
    if kind not in BROWSER_EVENT_KINDS:
        return None
    element_source = payload.get("element")
    element: dict[str, str] | None = None
    if isinstance(element_source, dict):
        element = {
            "tag": _bounded_text(element_source.get("tag"), 40).lower(),
            "type": _bounded_text(element_source.get("type"), 40).lower(),
            "name": _bounded_text(element_source.get("name"), 120),
            "id": _bounded_text(element_source.get("id"), 120),
            "label": _bounded_text(element_source.get("label"), 120),
            "autocomplete": _bounded_text(element_source.get("autocomplete"), 120),
            "role": _bounded_text(element_source.get("role"), 60),
            "accessibleName": _bounded_text(element_source.get("accessibleName"), 120),
            "testid": _bounded_text(element_source.get("testid"), 200),
            "text": _bounded_text(element_source.get("text"), 200),
            "css": _bounded_text(element_source.get("css"), 500),
            "contenteditable": bool(element_source.get("contenteditable")),
        }
    sensitive = bool(payload.get("sensitive"))
    value = None
    if not sensitive and payload.get("value") is not None:
        value = _bounded_text(payload.get("value"), 5000)
    try:
        at = int(payload.get("at") or 0)
    except (TypeError, ValueError):
        at = 0
    event: dict[str, Any] = {
        "kind": kind,
        "frame": "child" if payload.get("frame") == "child" else "top",
        "url": sanitize_url(_bounded_text(payload.get("url"), 500)),
        "element": element,
        "sensitive": sensitive,
        "at": at,
    }
    if sensitive or is_sensitive_field(element):
        event["sensitive"] = True
        event["value"] = None
    else:
        event["value"] = value
    if kind == "change":
        selected = payload.get("selectedValue")
        event["selectedValue"] = (
            None if event["sensitive"] else _bounded_text(selected, 200)
        )
        event["checked"] = bool(payload.get("checked"))
    if kind == "keydown":
        event["key"] = _bounded_text(payload.get("key"), 20)
    if kind == "unsupported":
        feature = _bounded_text(payload.get("feature"), 40)
        event["feature"] = feature or "unsupported"
    return event


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
    ) -> None:
        self._submit = submit
        self._launch = launch
        self._idle_ms = idle_ms
        self._max_ms = max_ms
        self._now_ms = now_ms
        self._on_failed = on_failed
        self._on_storage_state = on_storage_state
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
                "result": None,
                "browserSession": None,
                "errorCode": None,
                "failureNotified": False,
            }
            self._sessions[session_id] = session
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
            self._submit(
                self._start_browser, session, target, storage_state, headless
            ).result(timeout=120)
        except Exception as error:
            self._release_browser(session, timeout=10)
            code = (
                error.code
                if isinstance(error, _RecordingOperationError)
                else "RECORDING_BROWSER_START_FAILED"
            )
            with self._lock:
                session["status"] = "failed"
                session["errorCode"] = code
            self._notify_failed(session)
            from .http import PlatformError

            raise PlatformError(409, code) from None
        with self._lock:
            if session["status"] != "starting":
                code = session.get("errorCode") or "RECORDING_BROWSER_START_FAILED"
                from .http import PlatformError

                raise PlatformError(409, code)
            session["status"] = "recording"
        return self.session_response(session)

    def _start_browser(
        self,
        session: dict[str, Any],
        target: str,
        storage_state: dict[str, Any] | None,
        headless: bool,
    ) -> None:
        try:
            browser_session = self._launch(headless, storage_state)
        except Exception as error:
            raise _RecordingOperationError("RECORDING_BROWSER_START_FAILED", error) from error
        with self._lock:
            if session["status"] != "starting":
                close_browser_session(browser_session)
                return
            session["browserSession"] = browser_session
        try:
            context = browser_session["context"]
            page = browser_session["page"]
            context.add_init_script(RECORDER_INIT_SCRIPT)
            context.expose_binding(
                "__autoflowRecorderEvent",
                lambda _source, payload: self._on_browser_event(session, payload),
            )
        except Exception as error:
            raise _RecordingOperationError("RECORDING_BROWSER_START_FAILED", error) from error

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
        try:
            page.goto(target, wait_until="domcontentloaded", timeout=30000)
        except Exception as error:
            raise _RecordingOperationError("RECORDING_NAVIGATION_FAILED", error) from error

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
        # This callback runs on the Playwright thread, so close directly rather
        # than submitting back to the same single-thread executor.
        try:
            self._stop_browser(session)
        except Exception:
            pass
        self._notify_failed(session)

    def _release_browser(self, session: dict[str, Any], timeout: int = 30) -> None:
        """Release a terminal session even if its executor is no longer usable."""
        if session.get("browserSession") is None:
            return
        try:
            self._submit(self._stop_browser, session).result(timeout=timeout)
        except Exception:
            # This mirrors shutdown cleanup and is only a fallback after the
            # single Playwright worker has failed or timed out.
            try:
                self._stop_browser(session)
            except Exception:
                pass

    def _on_browser_event(self, session: dict[str, Any], payload: Any) -> None:
        event = validate_recorder_event(payload)
        if event is None:
            return
        with self._lock:
            if session["status"] != "recording":
                session["lastActivityAt"] = self._now_ms()
                return
            if not recording_url_is_same_origin(session["baseUrl"], event["url"]):
                self._warn_external_origin(session, event["url"])
                session["lastActivityAt"] = self._now_ms()
                return
            session["lastSeq"] = session["normalizer"].append(event)
            stored = dict(event)
            stored["seq"] = session["lastSeq"]
            session["events"].append(stored)
            session["lastActivityAt"] = self._now_ms()

    def _on_navigation(self, session: dict[str, Any], url: str) -> None:
        event = {
            "kind": "navigate",
            "url": sanitize_url(url),
            "at": self._now_ms(),
        }
        with self._lock:
            session["currentUrl"] = event["url"]
            # starting 阶段也会出现首次加载导航；归并器的首导航逻辑会消费该事件而不
            # 生成重复步骤。暂停/终态期间不产生业务步骤，也不推进业务事件游标。
            if session["status"] not in ("recording", "starting"):
                session["lastActivityAt"] = self._now_ms()
                return
            if not recording_url_is_same_origin(session["baseUrl"], url):
                self._warn_external_origin(session, url)
                session["lastActivityAt"] = self._now_ms()
                return
            session["lastSeq"] = session["normalizer"].append(event)
            stored = dict(event)
            stored["seq"] = session["lastSeq"]
            session["events"].append(stored)
            session["lastActivityAt"] = self._now_ms()

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
        return self.session_response(session)

    def resume(self, session_id: str) -> dict[str, Any]:
        session = self._require_session(session_id)
        with self._lock:
            if session["status"] == "paused":
                session["status"] = "recording"
                session["lastActivityAt"] = self._now_ms()
        return self.session_response(session)

    def stop(self, session_id: str) -> dict[str, Any]:
        session = self._require_session(session_id)
        with self._lock:
            if session["status"] in _TERMINAL_STATUSES:
                return self.session_response(session)
            session["status"] = "stopped"
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
        self._release_browser(session)
        with self._lock:
            self._prune_terminal_sessions()
        return self.session_response(session)

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
            raise PlatformError(404, "RECORDING_SESSION_NOT_FOUND")
        return session

    def session_response(self, session: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            normalizer = session.get("normalizer")
            recorded_step_count = (
                normalizer.step_count() if isinstance(normalizer, RecorderNormalizer) else 0
            )
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

    def session_result(self, session_id: str) -> dict[str, Any]:
        session = self._require_session(session_id)
        if session["status"] not in _TERMINAL_STATUSES:
            from .http import PlatformError

            raise PlatformError(409, "RECORDING_SESSION_ACTIVE")
        if session.get("result") is None:
            session["result"] = session["normalizer"].result()
        return {
            "session": self.session_response(session),
            "result": session["result"],
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
            self._release_browser(session)
