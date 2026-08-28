"""Shared headed-browser session lifecycle for Platform recording.

录制协调器通过专用线程化提交器串行访问 Playwright，本模块不做加锁。
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Mapping

HEADED_WINDOW_BOUNDS = {
    "left": 80,
    "top": 80,
    "width": 1280,
    "height": 800,
    "windowState": "normal",
}

WINDOWS_CHROME_CANDIDATES = (
    Path("/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"),
    Path("/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"),
)


def running_under_wsl(
    environ: Mapping[str, str] | None = None,
    wslg_root: Path | None = None,
) -> bool:
    """Detect WSL/WSLg so headed Chromium can use a native Windows window."""
    env = os.environ if environ is None else environ
    if env.get("WSL_DISTRO_NAME"):
        return True
    root = Path("/mnt/wslg") if wslg_root is None else wslg_root
    return root.exists()


def windows_chrome_executable(
    candidates: tuple[Path, ...] | None = None,
) -> Path | None:
    for path in candidates if candidates is not None else WINDOWS_CHROME_CANDIDATES:
        if path.is_file():
            return path
    return None


def should_use_windows_chrome() -> bool:
    """WSLg RAIL does not show Playwright's Linux Chromium; use Windows Chrome."""
    return running_under_wsl() and windows_chrome_executable() is not None


def headed_chromium_args(*, wsl: bool | None = None) -> list[str]:
    """Launch args that keep a headed Chromium window on-screen.

    Used for native Linux/Windows. WSL recording prefers Windows Chrome via CDP
    because WSLg maps Linux Chromium as a 32x32 RAIL stub the user cannot see.
    """
    bounds = HEADED_WINDOW_BOUNDS
    args = [
        f"--window-size={bounds['width']},{bounds['height']}",
        f"--window-position={bounds['left']},{bounds['top']}",
    ]
    use_wsl = running_under_wsl() if wsl is None else wsl
    if use_wsl:
        args.append("--ozone-platform=wayland")
    return args


def reveal_headed_window(page: Any) -> None:
    """Resize the real OS window after page creation.

    Launch args alone are not enough on WSLg: Weston still reports geometry
    32x32 at a negative origin. CDP ``Browser.setWindowBounds`` updates the
    RAIL window the user actually sees. Failures are swallowed so stub pages
    and headless tests stay unaffected.
    """
    try:
        page.bring_to_front()
    except Exception:
        pass
    try:
        session = page.context.new_cdp_session(page)
        info = session.send("Browser.getWindowForTarget")
        window_id = info.get("windowId") if isinstance(info, dict) else None
        if window_id is None:
            return
        session.send(
            "Browser.setWindowBounds",
            {"windowId": window_id, "bounds": dict(HEADED_WINDOW_BOUNDS)},
        )
        session.send(
            "Browser.setWindowBounds",
            {"windowId": window_id, "bounds": {"windowState": "maximized"}},
        )
    except Exception:
        return


def _pick_debug_port(start: int = 9330, count: int = 100) -> int:
    """Return a localhost port nothing is listening on.

    Do not bind-and-release here. WSL mirrored networking shares loopback with
    Windows; a port Python just held can make Windows Chrome fail to listen.
    """
    for port in range(start, start + count):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(0.15)
            if sock.connect_ex(("127.0.0.1", port)) != 0:
                return port
    raise RuntimeError("no free Chrome debugging port")


def _windows_local_app_data() -> str:
    result = subprocess.run(
        ["cmd.exe", "/c", "echo %LOCALAPPDATA%"],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
        cwd="/mnt/c/Windows",
    )
    path = (result.stdout or "").strip().splitlines()
    value = path[-1].strip() if path else ""
    if value and value != "%LOCALAPPDATA%":
        return value
    return r"C:\Users\Public"


def _wait_for_cdp(endpoint: str, timeout_s: float = 20) -> None:
    url = f"{endpoint}/json/version"
    deadline = time.time() + timeout_s
    last_error: Exception | None = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                if getattr(response, "status", 200) == 200:
                    return
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            last_error = error
        time.sleep(0.1)
    raise RuntimeError(f"Windows Chrome CDP was not reachable at {url}: {last_error}")


def _close_windows_chrome(browser: Any) -> None:
    try:
        session = browser.new_browser_cdp_session()
        session.send("Browser.close")
    except Exception:
        pass


def _headed_context_kwargs(storage_state: dict[str, Any] | None) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "locale": "zh-CN",
        "viewport": {
            "width": int(HEADED_WINDOW_BOUNDS["width"]),
            "height": int(HEADED_WINDOW_BOUNDS["height"]),
        },
    }
    if storage_state:
        kwargs["storage_state"] = storage_state
    return kwargs


def _launch_windows_chrome(
    playwright: Any,
    storage_state: dict[str, Any] | None,
) -> dict[str, Any]:
    chrome = windows_chrome_executable()
    if chrome is None:
        raise RuntimeError("Windows Chrome executable was not found")
    port = _pick_debug_port()
    user_data_dir = rf"{_windows_local_app_data()}\Temp\autoflow-recording-{port}"
    bounds = HEADED_WINDOW_BOUNDS
    subprocess.Popen(
        [
            str(chrome),
            f"--remote-debugging-port={port}",
            f"--user-data-dir={user_data_dir}",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-sync",
            "--disable-session-crashed-bubble",
            f"--window-size={bounds['width']},{bounds['height']}",
            f"--window-position={bounds['left']},{bounds['top']}",
            "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=False,
        cwd="/mnt/c/Windows",
    )
    endpoint = f"http://127.0.0.1:{port}"
    browser = None
    try:
        _wait_for_cdp(endpoint)
        browser = playwright.chromium.connect_over_cdp(endpoint)
        default_contexts = list(browser.contexts)
        context = browser.new_context(**_headed_context_kwargs(storage_state))
        page = context.new_page()
        # Closing the default CDP context kills the whole Windows Chrome process.
        # Only close its leftover about:blank pages so one recording window remains.
        for existing in default_contexts:
            for extra_page in list(existing.pages):
                try:
                    extra_page.close()
                except Exception:
                    pass
        reveal_headed_window(page)
        sys.stderr.write(f"[autoflow:recording] opened Windows Chrome at {endpoint}\n")
        sys.stderr.flush()
        return {
            "playwright": playwright,
            "browser": browser,
            "context": context,
            "page": page,
            "windowsChrome": True,
            "cdpEndpoint": endpoint,
            "windowsUserDataDir": user_data_dir,
        }
    except Exception:
        if browser is not None:
            _close_windows_chrome(browser)
        raise


def launch_browser_session(
    headless: bool,
    storage_state: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """启动一套 playwright/chromium/context/page；调用方负责在专用线程上调用。"""
    from playwright.sync_api import sync_playwright

    playwright = sync_playwright().start()
    if not headless and should_use_windows_chrome():
        try:
            return _launch_windows_chrome(playwright, storage_state)
        except Exception:
            try:
                playwright.stop()
            except Exception:
                pass
            raise
    launch_kwargs: dict[str, Any] = {"headless": headless}
    if not headless:
        launch_kwargs["args"] = headed_chromium_args()
    browser = playwright.chromium.launch(**launch_kwargs)
    context_kwargs: dict[str, Any] = {"locale": "zh-CN"}
    if storage_state:
        context_kwargs["storage_state"] = storage_state
    if not headless:
        context_kwargs["viewport"] = {
            "width": int(HEADED_WINDOW_BOUNDS["width"]),
            "height": int(HEADED_WINDOW_BOUNDS["height"]),
        }
    context = browser.new_context(**context_kwargs)
    page = context.new_page()
    if not headless:
        reveal_headed_window(page)
    return {
        "playwright": playwright,
        "browser": browser,
        "context": context,
        "page": page,
    }


def close_browser_session(session: dict[str, Any]) -> None:
    """按 context → browser → playwright 顺序尽力回收，不抛出。"""
    if session.get("windowsChrome"):
        _close_windows_chrome(session.get("browser"))
    for closer in (
        lambda: session["context"].close(),
        lambda: session["browser"].close(),
        lambda: session["playwright"].stop(),
    ):
        try:
            closer()
        except Exception:
            pass
