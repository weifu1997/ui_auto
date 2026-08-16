"""Flow recording kernel: browser capture script and pure event normalizer.

录制 MVP 的内核起点（Phase 0 PoC 验证通过）：

- ``RECORDER_INIT_SCRIPT`` 由 ``context.add_init_script`` 注入，在浏览器侧采集
  click/input/change/keydown 并做敏感字段判定；敏感输入的值不发送（双层防线
  的第一层，服务端 ``is_sensitive_field`` 为第二层）。
- ``RecorderNormalizer`` 是纯逻辑归并器：事件流进，可编辑、可由现有 runner 重放
  的 FlowStep/ElementAsset 草稿 DTO 出。不含 Playwright 依赖，可用事件序列单测。
"""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlparse

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
    role: roleFor(el),
    accessibleName: labelText(el) || (el.getAttribute("aria-label") || "").trim(),
    testid: el.getAttribute("data-testid") || "",
    text: (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60),
    css: cssPath(el),
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
  document.addEventListener(
    "click",
    (event) => {
      const el = target(event);
      if (!el) return;
      const desc = descriptor(el);
      emit({ kind: "click", element: desc, sensitive: sensitiveFor(el, desc) });
    },
    true,
  );
  document.addEventListener(
    "input",
    (event) => {
      const el = event.target;
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
      emit({ kind: "keydown", key: event.key, element: el ? descriptor(el) : null });
    },
    true,
  );
})();
"""


def sanitize_url(url: str) -> str:
    parsed = urlparse(url or "")
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return ""
    return f"{parsed.scheme}://{parsed.netloc}{parsed.path or '/'}"


def url_path(url: str) -> str:
    parsed = urlparse(url or "")
    return parsed.path or "/"


def is_sensitive_field(element: dict[str, Any] | None) -> bool:
    if not isinstance(element, dict):
        return False
    if element.get("type") == "password":
        return True
    haystack = " ".join(
        str(element.get(field) or "")
        for field in ("name", "id", "label", "accessibleName")
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

    def __init__(self, start_url: str = "") -> None:
        self._seq = 0
        self._steps: list[dict[str, Any]] = []
        self._elements: dict[str, dict[str, Any]] = {}
        self._names: set[str] = set()
        self._pending: dict[str, Any] | None = None
        self._last_change: tuple[str, int] | None = None
        self._last_click_at: int | None = None
        self._warnings: list[str] = []
        self._required_bindings: list[dict[str, str]] = []
        self._first_navigation = True
        self._start_url = sanitize_url(start_url)
        if self._start_url:
            self._append_step("打开页面", None, value=url_path(self._start_url))

    def append(self, event: dict[str, Any]) -> int:
        self._seq += 1
        seq = self._seq
        if not isinstance(event, dict):
            return seq
        kind = str(event.get("kind") or "")
        at = int(event.get("at") or 0)
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
        return seq

    def note_navigation(self, url: str, at: int = 0) -> None:
        self.append({"kind": "navigate", "url": url, "at": at})

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
            "method": candidate["method"],
            "value": candidate["value"],
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
