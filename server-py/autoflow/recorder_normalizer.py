"""纯事件→草稿状态机（recorder.py 拆分，阶段2-A，行为保持）。

不含 Playwright 依赖，可用事件序列单测。浏览器事件流进，可编辑、可由现有
runner 重放的 FlowStep/ElementAsset 草稿 DTO 出。
"""

from __future__ import annotations

from typing import Any

from .recorder_validation import is_sensitive_field, sanitize_url, url_path

NAVIGATION_CAUSALITY_MS = 1500
CLICK_SUPPRESSION_MS = 15000
MEANINGFUL_KEYS = ("Enter", "Escape", "Tab")
MAX_LOGICAL_STEPS = 1000

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
        target_path = url_path(target)
        if self._first_navigation:
            self._first_navigation = False
            if not self._steps:
                self._append_step("打开页面", None, value=target_path)
            return
        if self._last_click_at is not None and 0 <= at - self._last_click_at <= NAVIGATION_CAUSALITY_MS:
            return
        self._flush_pending()
        self._append_step("打开页面", None, value=target_path)

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
        if element.get("fullText") or element.get("text"):
            # 全文优先：展示标签 text 已被折叠截断，直接作为定位值会导致
            # 重放端全字符串匹配永远失败（W0-2）。
            return {
                "method": "text",
                "value": str(element.get("fullText") or element["text"]),
            }
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
