"""Shared headed-browser session lifecycle for Platform recording and runs.

录制协调器通过专用线程化提交器串行访问 Playwright，本模块不做加锁。
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path, PureWindowsPath
from typing import Any, Mapping

HEADED_WINDOW_BOUNDS = {
    "left": 80,
    "top": 80,
    "width": 1280,
    "height": 800,
    "windowState": "normal",
}


def is_native_windows() -> bool:
    """True when this Python process itself runs on Windows (not inside WSL)."""
    return sys.platform == "win32"


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


def default_windows_chrome_candidates(*, wsl: bool) -> tuple[Path, ...]:
    """Chrome install locations, seen through /mnt/c under WSL or natively."""
    if wsl:
        return (
            Path("/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"),
            Path("/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"),
        )

    def windows_path(base: str, *parts: str) -> Path:
        # PureWindowsPath keeps separators canonical even when this runs on a
        # POSIX host; Path() of it is concrete on Windows for is_file checks.
        return Path(PureWindowsPath(base).joinpath(*parts))

    return (
        windows_path(
            os.environ.get("ProgramFiles", r"C:\Program Files"),
            "Google",
            "Chrome",
            "Application",
            "chrome.exe",
        ),
        windows_path(
            os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"),
            "Google",
            "Chrome",
            "Application",
            "chrome.exe",
        ),
        windows_path(
            os.environ.get("LOCALAPPDATA", r"C:\Users\Public\AppData\Local"),
            "Google",
            "Chrome",
            "Application",
            "chrome.exe",
        ),
    )


def windows_chrome_executable(
    candidates: tuple[Path, ...] | None = None,
) -> Path | None:
    for path in (
        candidates
        if candidates is not None
        else default_windows_chrome_candidates(wsl=running_under_wsl())
    ):
        if path.is_file():
            return path
    return None


def should_use_windows_chrome() -> bool:
    """WSLg maps Linux Chromium to an invisible 32x32 RAIL stub, and a
    native-Windows service cannot rely on Playwright's bundled Chromium being
    installed; both host kinds run headed sessions on Windows Chrome via CDP."""
    if not (running_under_wsl() or is_native_windows()):
        return False
    return windows_chrome_executable() is not None


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
    if is_native_windows():
        return os.environ.get("LOCALAPPDATA") or r"C:\Users\Public"
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


def _windows_temp_root(local_app_data: str, *, native: bool | None = None) -> Path:
    """POSIX path of the Windows Temp root holding headed-Chrome profiles.

    有头会话把 profile 建在 ``{LocalAppData}\\Temp\\autoheaded-<port>``，清理逻辑扫
    的是 Temp 根；这里必须补上 ``Temp`` 段，否则 purge 扫到的是 Local 根，永远匹配
    不到任何 ``autoflow-headed-*`` 目录。
    """
    use_native = is_native_windows() if native is None else native
    if use_native:
        return Path(local_app_data) / "Temp"
    drive, _, rest = local_app_data.partition("\\")
    if not drive or not rest:
        return Path("/nonexistent")
    return Path("/mnt", drive.rstrip(":").lower(), rest.replace("\\", "/")) / "Temp"


STALE_PROFILE_MAX_AGE_S = 24 * 3600


def purge_stale_windows_chrome_profiles(
    *,
    now_s: float | None = None,
    max_age_s: float = STALE_PROFILE_MAX_AGE_S,
) -> None:
    """Best-effort delete leftover headed-Chrome profiles from old runs.

    每次有头会话都在 Windows Temp 建一个独立 profile，Chrome 退出后不会自动清
    理；只删超过 max_age 的目录，最近会话与运行中的（按端口命名的）一律不动。
    """
    try:
        root = _windows_temp_root(_windows_local_app_data())
        now = time.time() if now_s is None else now_s
        for entry in root.glob("autoflow-headed-*"):
            try:
                if not entry.is_dir() or now - entry.stat().st_mtime < max_age_s:
                    continue
                shutil.rmtree(entry, ignore_errors=True)
            except OSError:
                continue
    except Exception:
        return


def _wait_for_cdp(endpoint: str, timeout_s: float = 20) -> None:
    url = f"{endpoint}/json/version"
    # 直连 opener：127.0.0.1 的 CDP 探测绝不能走 http_proxy，否则配了代理的
    # 环境（WSL 开发机常见）会探测失败并误报 Chrome 未启动。
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.time() + timeout_s
    last_error: Exception | None = None
    while time.time() < deadline:
        try:
            with opener.open(url, timeout=1) as response:
                if getattr(response, "status", 200) == 200:
                    return
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            last_error = error
        time.sleep(0.1)
    raise RuntimeError(
        f"Windows Chrome did not expose CDP at {url} within {timeout_s:.0f}s "
        f"({last_error}); check that Chrome is allowed to start (antivirus/policy)"
    )


def close_windows_chrome(browser: Any) -> None:
    """Kill the Windows Chrome process behind a CDP connection.

    CDP 连接的 ``browser.close()`` 只断开 Playwright，不结束 Chrome 进程；录制
    与运行路径退出时都必须先经此显式 ``Browser.close``，否则留下孤儿窗口。
    """
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


def launch_windows_chrome_session(
    playwright: Any,
    storage_state: dict[str, Any] | None,
    *,
    context_kwargs: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Start Windows Chrome with a debugging port and attach over CDP.

    Shared by recording and run execution. ``context_kwargs=None`` keeps the
    recording viewport; callers that must match bundled-Chromium behavior pass
    their own kwargs explicitly.
    """
    chrome = windows_chrome_executable()
    if chrome is None:
        raise RuntimeError("Windows Chrome executable was not found")
    purge_stale_windows_chrome_profiles()
    port = _pick_debug_port()
    user_data_dir = rf"{_windows_local_app_data()}\Temp\autoflow-headed-{port}"
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
        cwd=None if is_native_windows() else "/mnt/c/Windows",
    )
    endpoint = f"http://127.0.0.1:{port}"
    browser = None
    try:
        _wait_for_cdp(endpoint)
        browser = playwright.chromium.connect_over_cdp(endpoint)
        default_contexts = list(browser.contexts)
        if context_kwargs is None:
            context_kwargs = _headed_context_kwargs(storage_state)
        context = browser.new_context(**context_kwargs)
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
        sys.stderr.write(f"[autoflow:headed] opened Windows Chrome at {endpoint}\n")
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
            close_windows_chrome(browser)
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
            return launch_windows_chrome_session(playwright, storage_state)
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
        close_windows_chrome(session.get("browser"))
    for closer in (
        lambda: session["context"].close(),
        lambda: session["browser"].close(),
        lambda: session["playwright"].stop(),
    ):
        try:
            closer()
        except Exception:
            pass
