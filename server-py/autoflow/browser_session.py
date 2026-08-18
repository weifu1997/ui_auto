"""Shared headed-browser session lifecycle for Platform recording.

录制协调器通过专用线程化提交器串行访问 Playwright，本模块不做加锁。
"""

from __future__ import annotations

from typing import Any


def launch_browser_session(
    headless: bool,
    storage_state: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """启动一套 playwright/chromium/context/page；调用方负责在专用线程上调用。"""
    from playwright.sync_api import sync_playwright

    playwright = sync_playwright().start()
    browser = playwright.chromium.launch(headless=headless)
    context = browser.new_context(
        locale="zh-CN", **({"storage_state": storage_state} if storage_state else {})
    )
    page = context.new_page()
    return {
        "playwright": playwright,
        "browser": browser,
        "context": context,
        "page": page,
    }


def close_browser_session(session: dict[str, Any]) -> None:
    """按 context → browser → playwright 顺序尽力回收，不抛出。"""
    for closer in (
        lambda: session["context"].close(),
        lambda: session["browser"].close(),
        lambda: session["playwright"].stop(),
    ):
        try:
            closer()
        except Exception:
            pass
