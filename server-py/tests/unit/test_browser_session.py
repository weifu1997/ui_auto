"""Headed Chromium window visibility for Platform recording."""

from pathlib import Path

from autoflow.browser_session import (
    HEADED_WINDOW_BOUNDS,
    _pick_debug_port,
    _windows_local_app_data,
    _windows_temp_root,
    close_browser_session,
    default_windows_chrome_candidates,
    headed_chromium_args,
    is_native_windows,
    launch_browser_session,
    purge_stale_windows_chrome_profiles,
    reveal_headed_window,
    running_under_wsl,
    should_use_windows_chrome,
    windows_chrome_executable,
)


def test_running_under_wsl_reads_distro_name():
    assert running_under_wsl(environ={"WSL_DISTRO_NAME": "Ubuntu-24.04"}) is True
    assert running_under_wsl(environ={}, wslg_root=Path("/missing-wslg-root")) is False


def test_headed_args_pin_window_geometry_without_wsl_ozone():
    args = headed_chromium_args(wsl=False)
    assert f"--window-size={HEADED_WINDOW_BOUNDS['width']},{HEADED_WINDOW_BOUNDS['height']}" in args
    assert f"--window-position={HEADED_WINDOW_BOUNDS['left']},{HEADED_WINDOW_BOUNDS['top']}" in args
    assert "--ozone-platform=wayland" not in args


def test_headed_args_force_wayland_on_wsl():
    args = headed_chromium_args(wsl=True)
    assert "--ozone-platform=wayland" in args


def test_reveal_headed_window_sets_cdp_bounds():
    sent: list[tuple[str, dict | None]] = []

    class _Session:
        def send(self, method, params=None):
            sent.append((method, params))
            if method == "Browser.getWindowForTarget":
                return {"windowId": 7}

    class _Context:
        def new_cdp_session(self, _page):
            return _Session()

    class _Page:
        context = _Context()
        brought = False

        def bring_to_front(self):
            self.brought = True

    page = _Page()
    reveal_headed_window(page)
    assert page.brought is True
    assert sent[0] == ("Browser.getWindowForTarget", None)
    assert sent[1] == (
        "Browser.setWindowBounds",
        {"windowId": 7, "bounds": dict(HEADED_WINDOW_BOUNDS)},
    )
    assert sent[2] == (
        "Browser.setWindowBounds",
        {"windowId": 7, "bounds": {"windowState": "maximized"}},
    )


def test_reveal_headed_window_swallows_missing_cdp():
    class _Page:
        context = object()

        def bring_to_front(self):
            raise RuntimeError("no window")

    reveal_headed_window(_Page())


def test_headed_launch_passes_args_and_reveals(monkeypatch):
    captured: dict[str, object] = {}
    revealed: list[object] = []

    class _Page:
        pass

    class _Context:
        def new_page(self):
            return _Page()

        def close(self):
            pass

    class _Browser:
        def new_context(self, **kwargs):
            captured["context"] = kwargs
            return _Context()

        def close(self):
            pass

    class _Chromium:
        def launch(self, **kwargs):
            captured["launch"] = kwargs
            return _Browser()

    class _Playwright:
        chromium = _Chromium()

        def stop(self):
            captured["stopped"] = True

        def start(self):
            return self

    import playwright.sync_api as api

    monkeypatch.setattr(api, "sync_playwright", lambda: _Playwright())
    monkeypatch.setattr("autoflow.browser_session.should_use_windows_chrome", lambda: False)
    monkeypatch.setattr(
        "autoflow.browser_session.headed_chromium_args",
        lambda: ["--window-size=1280,800"],
    )
    monkeypatch.setattr(
        "autoflow.browser_session.reveal_headed_window",
        lambda page: revealed.append(page),
    )

    session = launch_browser_session(False, {"cookies": []})
    assert captured["launch"] == {
        "headless": False,
        "args": ["--window-size=1280,800"],
    }
    assert captured["context"]["locale"] == "zh-CN"
    assert captured["context"]["storage_state"] == {"cookies": []}
    assert captured["context"]["viewport"] == {
        "width": HEADED_WINDOW_BOUNDS["width"],
        "height": HEADED_WINDOW_BOUNDS["height"],
    }
    assert revealed
    assert session["page"] is revealed[0]


def test_headless_launch_does_not_reveal_or_pass_window_args(monkeypatch):
    captured: dict[str, object] = {}
    revealed: list[object] = []

    class _Page:
        pass

    class _Context:
        def new_page(self):
            return _Page()

    class _Browser:
        def new_context(self, **kwargs):
            captured["context"] = kwargs
            return _Context()

    class _Chromium:
        def launch(self, **kwargs):
            captured["launch"] = kwargs
            return _Browser()

    class _Playwright:
        chromium = _Chromium()

        def stop(self):
            pass

        def start(self):
            return self

    import playwright.sync_api as api

    monkeypatch.setattr(api, "sync_playwright", lambda: _Playwright())
    monkeypatch.setattr(
        "autoflow.browser_session.reveal_headed_window",
        lambda page: revealed.append(page),
    )

    launch_browser_session(True)
    assert captured["launch"] == {"headless": True}
    assert "viewport" not in captured["context"]
    assert revealed == []


def test_pick_debug_port_returns_a_closed_localhost_port():
    import socket

    port = _pick_debug_port()
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.2)
        assert sock.connect_ex(("127.0.0.1", port)) != 0


def test_windows_chrome_executable_skips_missing_paths(tmp_path):
    missing = tmp_path / "missing" / "chrome.exe"
    present = tmp_path / "chrome.exe"
    present.write_bytes(b"")
    assert windows_chrome_executable(candidates=(missing,)) is None
    assert windows_chrome_executable(candidates=(missing, present)) == present


def test_is_native_windows_follows_platform(monkeypatch):
    import sys

    assert is_native_windows() is (sys.platform == "win32")
    monkeypatch.setattr(sys, "platform", "win32")
    assert is_native_windows() is True


def test_default_windows_chrome_candidates_wsl_paths():
    candidates = default_windows_chrome_candidates(wsl=True)
    assert Path("/mnt/c/Program Files/Google/Chrome/Application/chrome.exe") in candidates
    assert Path(
        "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"
    ) in candidates


def test_default_windows_chrome_candidates_native_paths(monkeypatch):
    from pathlib import PureWindowsPath

    monkeypatch.setenv("ProgramFiles", r"D:\Apps")
    monkeypatch.setenv("LOCALAPPDATA", r"C:\Users\t\AppData\Local")
    candidates = default_windows_chrome_candidates(wsl=False)
    # 候选路径用 PureWindowsPath 归一化比较，兼容 POSIX/Windows 宿主的分隔符差异
    normalized = [PureWindowsPath(str(path)) for path in candidates]
    assert PureWindowsPath(r"D:\Apps\Google\Chrome\Application\chrome.exe") in normalized
    assert (
        PureWindowsPath(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe")
        in normalized
    )
    assert (
        PureWindowsPath(
            r"C:\Users\t\AppData\Local\Google\Chrome\Application\chrome.exe"
        )
        in normalized
    )


def test_should_use_windows_chrome_requires_windows_host_and_chrome(monkeypatch):
    monkeypatch.setattr("autoflow.browser_session.running_under_wsl", lambda: False)
    monkeypatch.setattr("autoflow.browser_session.is_native_windows", lambda: True)
    monkeypatch.setattr(
        "autoflow.browser_session.windows_chrome_executable",
        lambda: Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
    )
    assert should_use_windows_chrome() is True

    # 宿主是 Windows 但找不到 chrome.exe → 回退自带 Chromium。
    monkeypatch.setattr("autoflow.browser_session.windows_chrome_executable", lambda: None)
    assert should_use_windows_chrome() is False

    # 纯 Linux 宿主永远不用 Windows Chrome。
    monkeypatch.setattr("autoflow.browser_session.is_native_windows", lambda: False)
    monkeypatch.setattr(
        "autoflow.browser_session.windows_chrome_executable",
        lambda: Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
    )
    assert should_use_windows_chrome() is False


def test_windows_local_app_data_native_reads_env(monkeypatch):
    monkeypatch.setattr("autoflow.browser_session.is_native_windows", lambda: True)
    monkeypatch.setenv("LOCALAPPDATA", r"C:\Users\t\AppData\Local")
    assert _windows_local_app_data() == r"C:\Users\t\AppData\Local"
    monkeypatch.delenv("LOCALAPPDATA", raising=False)
    assert _windows_local_app_data() == r"C:\Users\Public"


def test_windows_temp_root_maps_between_hosts():
    local = r"C:\Users\t\AppData\Local"
    # 有头 Chrome 的 profile 建在 `Local\Temp\autoflow-headed-<port>`，清理扫的是
    # Temp 根；映射必须带 Temp 后缀，否则 purge 永远 glob 不到任何 profile。
    assert _windows_temp_root(local, native=True) == Path(local) / "Temp"
    assert _windows_temp_root(local, native=False) == Path(
        "/mnt/c/Users/t/AppData/Local"
    ) / "Temp"
    # 无法解析的格式兜底到不存在的目录，glob 自然为空
    assert _windows_temp_root("not-a-path", native=False) == Path("/nonexistent")


def test_purge_stale_windows_chrome_profiles(tmp_path, monkeypatch):
    import os
    import time

    stale = tmp_path / "autoflow-headed-9000"
    fresh = tmp_path / "autoflow-headed-9001"
    unrelated = tmp_path / "autoflow-other"
    for directory in (stale, fresh, unrelated):
        directory.mkdir()
    old = time.time() - 48 * 3600
    os.utime(stale, (old, old))

    monkeypatch.setattr(
        "autoflow.browser_session._windows_local_app_data",
        lambda: r"C:\Users\t\AppData\Local",
    )
    monkeypatch.setattr(
        "autoflow.browser_session._windows_temp_root",
        lambda local, native=None: tmp_path,
    )

    purge_stale_windows_chrome_profiles()

    assert not stale.exists()  # 超过 24h 的旧 profile 被清理
    assert fresh.exists()  # 最近会话的 profile 保留
    assert unrelated.exists()  # 非本功能命名空间的不动


def test_purge_stale_windows_chrome_profiles_never_raises(monkeypatch):
    monkeypatch.setattr(
        "autoflow.browser_session._windows_local_app_data",
        lambda: r"C:\Users\t\AppData\Local",
    )
    monkeypatch.setattr(
        "autoflow.browser_session._windows_temp_root",
        lambda local, native=None: (_ for _ in ()).throw(RuntimeError("boom")),
    )
    purge_stale_windows_chrome_profiles()  # 不应抛出


def _install_windows_chrome_stubs(monkeypatch, *, native: bool) -> dict[str, object]:
    """Stub the full Windows Chrome launch path for either host kind.

    Returns a ``captured`` dict with the Popen args/kwargs, the CDP endpoint,
    the fake browser/context, and teardown observations.
    """
    import playwright.sync_api as api

    chrome = (
        Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
        if native
        else Path("/mnt/c/Program Files/Google/Chrome/Application/chrome.exe")
    )
    captured: dict[str, object] = {
        "launched": [],
        "popen_kwargs": {},
        "revealed": [],
        "closed_via_cdp": [],
    }

    class _StubPage:
        def __init__(self):
            self.closed = False

        def close(self):
            self.closed = True

    class _StubContext:
        def __init__(self):
            self.pages = []
            self.closed = False

        def new_page(self):
            page = _StubPage()
            self.pages.append(page)
            return page

        def close(self):
            self.closed = True

    class _StubBrowser:
        def __init__(self):
            self.default_page = _StubPage()
            self.default_context = _StubContext()
            self.default_context.pages.append(self.default_page)
            self.contexts = [self.default_context]
            self.closed = False

        def new_context(self, **kwargs):
            captured["context_kwargs"] = kwargs
            return _StubContext()

        def new_browser_cdp_session(self):
            class _Session:
                def send(self, method, params=None):
                    captured["closed_via_cdp"].append(method)

            return _Session()

        def close(self):
            self.closed = True

    class _StubChromium:
        def launch(self, **kwargs):
            raise AssertionError(
                "bundled Chromium must not launch when Windows Chrome is used"
            )

        def connect_over_cdp(self, endpoint):
            captured["endpoint"] = endpoint
            browser = _StubBrowser()
            captured["browser"] = browser
            return browser

    class _StubPlaywright:
        def __init__(self):
            self.chromium = _StubChromium()

        def start(self):
            return self

        def stop(self):
            captured["stopped"] = True

    def _fake_popen(args, **kwargs):
        captured["launched"].append(args)
        captured["popen_kwargs"].update(kwargs)
        return type("Proc", (), {})()

    monkeypatch.setattr(api, "sync_playwright", lambda: _StubPlaywright())
    monkeypatch.setattr("autoflow.browser_session.should_use_windows_chrome", lambda: True)
    monkeypatch.setattr("autoflow.browser_session.windows_chrome_executable", lambda: chrome)
    monkeypatch.setattr("autoflow.browser_session.is_native_windows", lambda: native)
    monkeypatch.setattr("autoflow.browser_session._pick_debug_port", lambda: 9334)
    monkeypatch.setattr(
        "autoflow.browser_session._windows_local_app_data",
        lambda: r"C:\Users\tester\AppData\Local",
    )
    monkeypatch.setattr(
        "autoflow.browser_session._wait_for_cdp", lambda endpoint, timeout_s=20: None
    )
    monkeypatch.setattr("autoflow.browser_session.subprocess.Popen", _fake_popen)
    monkeypatch.setattr(
        "autoflow.browser_session.reveal_headed_window",
        lambda page: captured["revealed"].append(page),
    )
    return captured


def test_headed_wsl_launch_connects_to_windows_chrome(monkeypatch):
    captured = _install_windows_chrome_stubs(monkeypatch, native=False)

    session = launch_browser_session(False, {"cookies": []})

    assert captured["endpoint"] == "http://127.0.0.1:9334"
    args = captured["launched"][0]
    assert args[0] == "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"
    assert "--remote-debugging-port=9334" in args
    assert captured["popen_kwargs"]["cwd"] == "/mnt/c/Windows"
    assert session["windowsChrome"] is True
    assert captured["context_kwargs"]["storage_state"] == {"cookies": []}
    browser = captured["browser"]
    assert browser.default_page.closed is True
    assert browser.default_context.closed is False
    assert captured["revealed"]

    close_browser_session(session)
    assert captured["closed_via_cdp"] == ["Browser.close"]
    assert captured["stopped"] is True


def test_headed_native_windows_launch_connects_to_windows_chrome(monkeypatch):
    captured = _install_windows_chrome_stubs(monkeypatch, native=True)

    session = launch_browser_session(False, {"cookies": []})

    args = captured["launched"][0]
    assert args[0] == r"C:\Program Files\Google\Chrome\Application\chrome.exe"
    assert "--remote-debugging-port=9334" in args
    # 原生 Windows 没有 /mnt/c，直接从当前目录启动 chrome.exe。
    assert captured["popen_kwargs"]["cwd"] is None
    assert session["windowsChrome"] is True
    assert captured["context_kwargs"]["storage_state"] == {"cookies": []}

    close_browser_session(session)
    assert captured["closed_via_cdp"] == ["Browser.close"]
    assert captured["stopped"] is True
