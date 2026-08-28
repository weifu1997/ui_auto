"""Headed Chromium window visibility for Platform recording."""

from pathlib import Path

from autoflow.browser_session import (
    HEADED_WINDOW_BOUNDS,
    _pick_debug_port,
    close_browser_session,
    headed_chromium_args,
    launch_browser_session,
    reveal_headed_window,
    running_under_wsl,
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


def test_headed_wsl_launch_connects_to_windows_chrome(monkeypatch):
    captured: dict[str, object] = {}
    revealed: list[object] = []
    launched: list[list[str]] = []

    class _Page:
        def __init__(self):
            self.closed = False

        def close(self):
            self.closed = True

    class _Context:
        def __init__(self):
            self.pages = []
            self.closed = False

        def new_page(self):
            page = _Page()
            self.pages.append(page)
            return page

        def close(self):
            self.closed = True

    class _Browser:
        def __init__(self):
            self.default_page = _Page()
            self.default_context = _Context()
            self.default_context.pages.append(self.default_page)
            self.contexts = [self.default_context]

        def new_context(self, **kwargs):
            captured["context"] = kwargs
            return _Context()

        def new_browser_cdp_session(self):
            class _Session:
                def send(self, method, params=None):
                    captured["browser_close"] = (method, params)

            return _Session()

        def close(self):
            captured["disconnected"] = True

    class _Chromium:
        def launch(self, **kwargs):
            captured["launch"] = kwargs
            raise AssertionError("bundled Chromium must not launch when Windows Chrome is used")

        def connect_over_cdp(self, endpoint):
            captured["endpoint"] = endpoint
            browser = _Browser()
            captured["browser"] = browser
            return browser

    class _Playwright:
        chromium = _Chromium()

        def stop(self):
            captured["stopped"] = True

        def start(self):
            return self

    import playwright.sync_api as api

    monkeypatch.setattr(api, "sync_playwright", lambda: _Playwright())
    monkeypatch.setattr("autoflow.browser_session.should_use_windows_chrome", lambda: True)
    monkeypatch.setattr(
        "autoflow.browser_session.windows_chrome_executable",
        lambda: Path("/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"),
    )
    monkeypatch.setattr("autoflow.browser_session._pick_debug_port", lambda: 9334)
    monkeypatch.setattr(
        "autoflow.browser_session._windows_local_app_data",
        lambda: r"C:\Users\tester\AppData\Local",
    )
    monkeypatch.setattr("autoflow.browser_session._wait_for_cdp", lambda endpoint, timeout_s=20: None)
    monkeypatch.setattr(
        "autoflow.browser_session.subprocess.Popen",
        lambda args, **kwargs: launched.append(args) or type("Proc", (), {})(),
    )
    monkeypatch.setattr(
        "autoflow.browser_session.reveal_headed_window",
        lambda page: revealed.append(page),
    )

    session = launch_browser_session(False, {"cookies": []})
    assert "launch" not in captured
    assert captured["endpoint"] == "http://127.0.0.1:9334"
    assert launched[0][0].endswith("chrome.exe")
    assert "--remote-debugging-port=9334" in launched[0]
    assert session["windowsChrome"] is True
    browser = captured["browser"]
    assert browser.default_page.closed is True
    assert browser.default_context.closed is False
    assert revealed
    assert captured["context"]["storage_state"] == {"cookies": []}

    close_browser_session(session)
    assert captured["browser_close"] == ("Browser.close", None)
    assert captured["stopped"] is True
