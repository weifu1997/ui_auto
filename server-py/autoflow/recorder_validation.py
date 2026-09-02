"""事件 DTO 校验与 URL 同源守卫（recorder.py 拆分，阶段2-A，行为保持）。

- ``sanitize_url`` / ``url_path`` / ``is_sensitive_field``：URL 归一化与敏感字段判定。
- ``recording_target_url`` / ``recording_url_is_same_origin``：起始 URL 与捕获 URL 同源规则。
- ``validate_recorder_event``：浏览器 payload → 受信 DTO（不合法返回 None 丢弃）。
- ``BROWSER_EVENT_KINDS``：受信事件 kind 集合。
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urljoin, urlsplit, urlunsplit

from .netguard import is_link_local_or_metadata_host
from .sensitive import is_sensitive_field as shared_is_sensitive_field

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
    """委托 sensitive 单源判定；保留名字以维持既有调用/测试的导入路径。"""
    return shared_is_sensitive_field(element)

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
    # P1-1 SSRF：录制起始导航同源但 base 本身可能是 link-local/云 metadata；
    # 拒绝，避免录制浏览器被指去读实例凭据。
    if is_link_local_or_metadata_host(base.hostname):
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
            "fullText": _bounded_text(element_source.get("fullText"), 1000),
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
