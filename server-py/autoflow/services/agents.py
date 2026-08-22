"""Managed agent availability and Chromium environment checks."""
from __future__ import annotations

import os
import time as _time
from pathlib import Path
from typing import Any
from ..core import digest, now
from ._shared import (
    _CHROMIUM_AVAILABLE,
    _CHROMIUM_AVAILABLE_AT,
    _CHROMIUM_CACHE_TTL_NEGATIVE,
    _CHROMIUM_CACHE_TTL_POSITIVE,
)


class AgentServices:
    """Managed agent availability and Chromium environment checks."""

    def managed_agent(self, project_id: str) -> dict[str, Any]:
        project = self.project_for(project_id)
        agent_id = f"managed-{project['workspace_id']}"
        self.database.execute(
            """
            INSERT OR IGNORE INTO agents (
              id, workspace_id, name, credential_hash, status,
              browser_version, os, max_concurrency, created_at
            ) VALUES (?, ?, 'ManagedRunner', ?, 'disabled', 'bundled',
                      'Windows', 1, ?)
            """,
            (agent_id, project["workspace_id"], digest(f"managed:{project['workspace_id']}"), now()),
        )
        return {
            "id": agent_id,
            "workspaceId": project["workspace_id"],
            "name": "ManagedRunner",
            "status": "disabled",
            "browserVersion": "bundled",
            "os": "Windows",
            "maxConcurrency": 1,
            "currentTask": None,
            "lastSeenAt": None,
            "createdAt": now(),
        }

    @staticmethod
    def require_chromium_environment(environment: dict[str, Any]) -> None:
        from ..http import PlatformError

        browser = environment.get("browser")
        if not isinstance(browser, str):
            browser = "Chromium"
        if browser != "Chromium":
            raise PlatformError(400, "AGENT_BROWSER_UNSUPPORTED")

    def ensure_chromium_available(self) -> None:
        import platform as _platform
        import sys as _sys
        global _CHROMIUM_AVAILABLE, _CHROMIUM_AVAILABLE_AT
        from ..http import PlatformError

        now = _time.monotonic()
        cached_value = _CHROMIUM_AVAILABLE
        cached_at = _CHROMIUM_AVAILABLE_AT
        if cached_value is not None and cached_at is not None:
            ttl = (
                _CHROMIUM_CACHE_TTL_POSITIVE
                if cached_value
                else _CHROMIUM_CACHE_TTL_NEGATIVE
            )
            if now - cached_at < ttl:
                if not cached_value:
                    raise PlatformError(409, "AGENT_BROWSER_UNSUPPORTED")
                return
        available: bool = False
        executable: Path | None = None
        probe_error: Exception | None = None
        system_name: str = _platform.system()
        browsers_root: Path = Path(
            os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
            or (Path.home() / ".cache" / "ms-playwright")
        )
        # 根据平台选择 Chromium 二进制相对路径。若添加新浏览器类型，同步更新。
        if system_name == "Linux":
            candidate_rel = Path("chrome-linux64") / "chrome"
        elif system_name == "Darwin":
            candidate_rel = (
                Path("chrome-mac") / "Chromium.app" / "Contents" / "MacOS" / "Chromium"
            )
        elif system_name == "Windows":
            candidate_rel = Path("chrome-win64") / "chrome.exe"
        else:
            candidate_rel = Path("chrome")  # 占位，下面会抛出 unsupported platform
        try:
            # 注意：在 uvicorn async handler 中同步调用 sync_playwright() 会被
            # Playwright 直接拒绝（"It looks like you are using Playwright Sync API
            # inside the asyncio loop."），因此这里不启动 Playwright 运行时，
            # 而是直接解析 Playwright 官方浏览器缓存目录结构定位二进制。
            # 缓存位置 & 二进制相对路径已在函数外层按平台计算好（browsers_root /
            # candidate_rel）。如果不支持的平台，在这里直接抛错走 fallback。
            if system_name not in {"Linux", "Darwin", "Windows"}:
                raise RuntimeError(f"Unsupported platform system={system_name!r}")
            # Playwright 的子目录命名是 chromium-<revision_number>，取所有匹配项中
            # 路径存在（按 mtime 取最新）的那一个。如果没有设置 PLAYWRIGHT_BROWSERS_PATH
            # 且 ms-playwright 也不存在，可能用户用 PLAYWRIGHT_BROWSERS_PATH=/nonexistent
            # 覆盖了默认，此时 fallback 到 async API 以兼容自定义安装。
            found_candidates: list[Path] = []
            if browsers_root.exists():
                for entry in browsers_root.iterdir():
                    if entry.is_dir() and entry.name.startswith("chromium-"):
                        candidate = entry / candidate_rel
                        if candidate.exists():
                            found_candidates.append(candidate)
            if found_candidates:
                found_candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
                executable = found_candidates[0]
                available = True
            else:
                # Fallback：如果目录扫描没找到（例如非标准的 PLAYWRIGHT_BROWSERS_PATH
                # 映射、或自定义编译的 Chromium），则在新线程中通过 asyncio event loop
                # 调用 Playwright async API 查 executable_path — 这样不会与主线程
                # uvicorn 已运行的 event loop 冲突。
                try:
                    import asyncio as _asyncio
                    import threading as _threading

                    async def _probe_async() -> str | None:
                        from playwright.async_api import async_playwright

                        async with async_playwright() as pw:
                            return pw.chromium.executable_path  # type: ignore[no-any-return]

                    def _runner(loop: _asyncio.AbstractEventLoop) -> str | None:
                        future = _asyncio.run_coroutine_threadsafe(_probe_async(), loop)
                        try:
                            return future.result(timeout=30)
                        finally:
                            loop.call_soon_threadsafe(loop.stop)

                    new_loop = _asyncio.new_event_loop()
                    thread = _threading.Thread(
                        target=new_loop.run_forever, daemon=True
                    )
                    thread.start()
                    try:
                        async_path = _runner(new_loop)
                    finally:
                        thread.join(timeout=5)
                    if async_path:
                        executable = Path(async_path)
                        available = executable.exists()
                except Exception as exc:  # noqa: BLE001
                    probe_error = exc
                    available = False
        except Exception as exc:  # noqa: BLE001
            probe_error = exc
            available = False
        _CHROMIUM_AVAILABLE = available
        _CHROMIUM_AVAILABLE_AT = now
        if not available:
            details: list[str] = [f"[autoflow:chromium] probe failed at {now:.1f}s (pid {os.getpid()})"]
            if probe_error is not None:
                details.append(f"  exception: {type(probe_error).__name__}: {probe_error}")
            elif executable is None:
                details.append("  no chromium-<rev> directory found in browsers root")
                details.append(f"  browsers_root={browsers_root!s} (exists={browsers_root.exists()})")
                details.append(f"  expected relative binary: {candidate_rel}")
            else:
                details.append(f"  executable not found on disk: {executable}")
                details.append(f"  file exists={executable.exists()}, parent exists={executable.parent.exists()}")
            details.append(f"  system={system_name} HOME={os.environ.get('HOME')!r} PLAYWRIGHT_BROWSERS_PATH={os.environ.get('PLAYWRIGHT_BROWSERS_PATH')!r}")
            _sys.stderr.write("\n".join(details) + "\n")
            _sys.stderr.flush()
            raise PlatformError(409, "AGENT_BROWSER_UNSUPPORTED")
