"""阶段2-B：runner 启停路径单测（拆分前建立基线，拆分后保持全绿）。

覆盖 ``execute_browser_run`` / ``execute_element_validation`` 的浏览器启动序列、
teardown（hooks 清理 + context/browser close）、取消判定与失败路径，用假
Playwright 驱动，不启动真实浏览器。
"""

from __future__ import annotations

import threading
import time

import pytest

from autoflow.runner import (
    _heartbeat_interval_s,
    execute_browser_run,
    execute_element_validation,
)


# ---------- 假 Playwright 栈 ----------


class _FakeTracing:
    def __init__(self) -> None:
        self.started = False

    def start(self, **kwargs: object) -> None:
        self.started = True

    def stop(self, **kwargs: object) -> None:
        pass


class _FakeLocator:
    def __init__(self, count: int = 2) -> None:
        self._count = count
        self.first = self

    def wait_for(self, **kwargs: object) -> None:
        pass

    def count(self) -> int:
        return self._count

    def evaluate(self, script: str) -> str:
        return "<html data-test>…</html>"


class _FakePage:
    def __init__(self, fail_screenshot: bool = False) -> None:
        self._fail_screenshot = fail_screenshot

    def screenshot(self, **kwargs: object) -> None:
        if self._fail_screenshot:
            raise RuntimeError("screenshot boom")

    def goto(self, *args: object, **kwargs: object) -> None:
        pass

    def evaluate(self, script: str) -> object:
        return False

    def locator(self, value: str) -> _FakeLocator:
        return _FakeLocator()

    def get_by_label(self, value: str) -> _FakeLocator:
        return _FakeLocator()

    def get_by_text(self, value: str, **kwargs: object) -> _FakeLocator:
        return _FakeLocator()

    def get_by_role(self, role: str, **kwargs: object) -> _FakeLocator:
        return _FakeLocator()


class _FakeContext:
    def __init__(self) -> None:
        self.pages: list[_FakePage] = []
        self.closed = False
        self.new_context_kwargs: dict[str, object] | None = None
        self.tracing = _FakeTracing()
        self._fail_screenshot = False

    def new_page(self) -> _FakePage:
        page = _FakePage(fail_screenshot=self._fail_screenshot)
        self.pages.append(page)
        return page

    def close(self) -> None:
        self.closed = True


class _FakeBrowser:
    def __init__(self) -> None:
        self.contexts: list[_FakeContext] = []
        self.closed = False

    def new_context(self, **kwargs: object) -> _FakeContext:
        context = _FakeContext()
        context.new_context_kwargs = dict(kwargs)
        self.contexts.append(context)
        return context

    def close(self) -> None:
        self.closed = True


class _FakeChromium:
    def __init__(self) -> None:
        self.launches: list[dict[str, object]] = []

    def launch(self, headless: object = None, args: object = None) -> _FakeBrowser:
        browser = _FakeBrowser()
        self.launches.append({"headless": headless, "args": args, "browser": browser})
        return browser


class _FakePlaywright:
    def __init__(self) -> None:
        self.chromium = _FakeChromium()
        self.stopped = False

    # 与真实 sync_playwright() 的 CM 协议一致：with sync_playwright() as pw
    def __enter__(self) -> "_FakePlaywright":
        return self

    def __exit__(self, *exc: object) -> bool:
        self.stop()
        return False

    def stop(self) -> None:
        self.stopped = True


def _make_hooks(
    recorder: list[tuple[str, object]],
    signal: threading.Event | None = None,
) -> dict[str, object]:
    return {
        "browser": lambda browser, context: recorder.append(
            ("browser", "register" if browser is not None else "clear")
        ),
        "event": lambda kind, payload: recorder.append(("event", kind)),
        "artifact_path": lambda name, ext: f"/tmp/{name}.{ext}",
        "artifact": lambda artifact: recorder.append(("artifact", artifact["name"])),
        "signal": signal,
    }


# ---------- execute_browser_run ----------


def test_browser_run_start_sequence_and_teardown(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_pw = _FakePlaywright()
    monkeypatch.setattr("playwright.sync_api.sync_playwright", lambda: fake_pw)
    monkeypatch.setenv("MANAGED_RUNNER_HEADLESS", "1")
    recorder: list[tuple[str, object]] = []
    hooks = _make_hooks(recorder)

    result = execute_browser_run(
        {
            "environment": {"baseUrl": "https://app.test"},
            "flow": {"steps": []},
            "secrets": {},
        },
        hooks,  # type: ignore[arg-type]
    )

    assert result["status"] == "success"
    assert result["completedSteps"] == 0
    # 启动：chromium.launch 缺省 headless=True（env 无 headless + 环境变量 "1"）
    assert len(fake_pw.chromium.launches) == 1
    assert fake_pw.chromium.launches[0]["headless"] is True
    browser = fake_pw.chromium.launches[0]["browser"]
    assert len(browser.contexts) == 1
    assert browser.contexts[0].new_context_kwargs == {"locale": "zh-CN"}
    context = browser.contexts[0]
    assert len(context.pages) == 1
    assert context.tracing.started  # 非敏感 run 开启 Trace
    # 注册顺序：browser(context, browser) 先 register，teardown 后 clear
    assert ("browser", "register") in recorder
    assert recorder[-1] == ("browser", "clear")
    # teardown：context/browser close + playwright.stop
    assert context.closed and browser.closed and fake_pw.stopped


def test_browser_run_headless_from_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_pw = _FakePlaywright()
    monkeypatch.setattr("playwright.sync_api.sync_playwright", lambda: fake_pw)
    # 有头路径：固定走自带 Chromium（否则 WSL/Windows 宿主上会拉起真实 Chrome）
    monkeypatch.setattr("autoflow.runner.should_use_windows_chrome", lambda: False)
    monkeypatch.setattr(
        "autoflow.runner.headed_chromium_args",
        lambda: ["--window-size=1280,800", "--window-position=80,80"],
    )
    recorder: list[tuple[str, object]] = []
    hooks = _make_hooks(recorder)

    execute_browser_run(
        {
            "environment": {"baseUrl": "https://app.test", "headless": False},
            "flow": {"steps": []},
            "secrets": {},
        },
        hooks,  # type: ignore[arg-type]
    )

    assert fake_pw.chromium.launches[0]["headless"] is False
    # 有头自带 Chromium 需要钉住窗口几何，避免窗口跑出屏幕
    assert fake_pw.chromium.launches[0]["args"] == [
        "--window-size=1280,800",
        "--window-position=80,80",
    ]


def test_browser_run_headed_windows_host_uses_windows_chrome(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """WSL/Windows 宿主上有头运行改走 Windows Chrome via CDP。

    取消是纯信号：ManagedRunner 不跨线程关 Playwright，浏览器统一由
    ``_BrowserSession.__exit__`` 回收，因此 CDP 浏览器必须先 ``Browser.close``
    杀进程再断连，不能把 Chrome 留成孤儿窗口。
    """
    fake_pw = _FakePlaywright()
    monkeypatch.setattr("playwright.sync_api.sync_playwright", lambda: fake_pw)
    monkeypatch.setattr("autoflow.runner.should_use_windows_chrome", lambda: True)
    launched: dict[str, object] = {}
    closed_browsers: list[object] = []

    class _CdpBrowser(_FakeBrowser):
        pass

    def fake_launch_windows_chrome(
        playwright: object,
        storage_state: object,
        *,
        context_kwargs: dict[str, object] | None = None,
    ) -> dict[str, object]:
        launched["context_kwargs"] = context_kwargs
        browser = _CdpBrowser()
        launched["browser"] = browser
        context = _FakeContext()
        launched["context"] = context
        return {
            "browser": browser,
            "context": context,
            "page": object(),
            "windowsChrome": True,
            "cdpEndpoint": "http://127.0.0.1:9334",
        }

    monkeypatch.setattr(
        "autoflow.runner.launch_windows_chrome_session", fake_launch_windows_chrome
    )
    monkeypatch.setattr(
        "autoflow.runner.close_windows_chrome",
        lambda browser: closed_browsers.append(browser),
    )
    recorder: list[tuple[str, object]] = []
    hooks = _make_hooks(recorder)

    result = execute_browser_run(
        {
            "environment": {"baseUrl": "https://app.test", "headless": False},
            "flow": {"steps": []},
            "secrets": {},
        },
        hooks,  # type: ignore[arg-type]
    )

    assert result["status"] == "success"
    # 自带 Chromium 不得启动
    assert fake_pw.chromium.launches == []
    # 与自带 Chromium 路径同参（locale/storage_state，不设 viewport），跨宿主行为一致
    assert launched["context_kwargs"] == {"locale": "zh-CN"}
    browser = launched["browser"]
    context = launched["context"]
    assert ("browser", "register") in recorder
    assert recorder[-1] == ("browser", "clear")
    # teardown：先杀 Windows Chrome 进程，再收尾 context/playwright
    assert closed_browsers == [browser]
    assert context.closed and browser.closed and fake_pw.stopped


def test_browser_run_cancel_runs_teardown(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_pw = _FakePlaywright()
    monkeypatch.setattr("playwright.sync_api.sync_playwright", lambda: fake_pw)
    recorder: list[tuple[str, object]] = []
    signal = threading.Event()
    signal.set()
    hooks = _make_hooks(recorder, signal=signal)

    result = execute_browser_run(
        {
            "environment": {"baseUrl": "https://app.test"},
            "flow": {"steps": [{"id": "s1", "action": "点击", "title": "Click"}]},
            "secrets": {},
        },
        hooks,  # type: ignore[arg-type]
    )

    assert result["status"] == "canceled"
    assert result["error"] == "RUN_CANCELED"
    browser = fake_pw.chromium.launches[0]["browser"]
    context = browser.contexts[0]
    # 原 finally 顺序：先 hooks clear，再停 trace（记录 artifact），故用成员判断
    assert ("browser", "clear") in recorder
    assert context.closed and browser.closed and fake_pw.stopped


def test_browser_run_step_failure_runs_teardown(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_pw = _FakePlaywright()
    monkeypatch.setattr("playwright.sync_api.sync_playwright", lambda: fake_pw)
    # fake page.screenshot 抛错：截图步骤失败 → 非继续执行 → run failed
    monkeypatch.setattr(
        _FakeContext,
        "new_page",
        lambda self: _FakePage(fail_screenshot=True),
    )
    recorder: list[tuple[str, object]] = []
    hooks = _make_hooks(recorder)

    result = execute_browser_run(
        {
            "environment": {"baseUrl": "https://app.test"},
            "flow": {"steps": [{"id": "s1", "action": "截图", "title": "Shot"}]},
            "secrets": {},
        },
        hooks,  # type: ignore[arg-type]
    )

    assert result["status"] == "failed"
    assert "screenshot boom" in result["error"]
    browser = fake_pw.chromium.launches[0]["browser"]
    context = browser.contexts[0]
    # 原 finally 顺序：先 hooks clear，再停 trace（记录 artifact），故用成员判断
    assert ("browser", "clear") in recorder
    assert context.closed and browser.closed and fake_pw.stopped


def test_heartbeat_interval_clamps_and_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RUN_HEARTBEAT_INTERVAL_S", raising=False)
    assert _heartbeat_interval_s() == 30.0
    monkeypatch.setenv("RUN_HEARTBEAT_INTERVAL_S", "abc")
    assert _heartbeat_interval_s() == 30.0
    monkeypatch.setenv("RUN_HEARTBEAT_INTERVAL_S", "0")
    assert _heartbeat_interval_s() == 1.0
    monkeypatch.setenv("RUN_HEARTBEAT_INTERVAL_S", "1")
    assert _heartbeat_interval_s() == 1.0
    monkeypatch.setenv("RUN_HEARTBEAT_INTERVAL_S", "45")
    assert _heartbeat_interval_s() == 45.0
    monkeypatch.setenv("RUN_HEARTBEAT_INTERVAL_S", "999")
    assert _heartbeat_interval_s() == 60.0


def test_browser_run_in_step_heartbeat_keeps_progress(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_pw = _FakePlaywright()
    monkeypatch.setattr("playwright.sync_api.sync_playwright", lambda: fake_pw)
    monkeypatch.setenv("RUN_HEARTBEAT_INTERVAL_S", "1")
    ticks: list[int] = []

    class _SlowPage(_FakePage):
        def goto(self, *args: object, **kwargs: object) -> None:
            time.sleep(2.2)

    monkeypatch.setattr(_FakeContext, "new_page", lambda self: _SlowPage())
    recorder: list[tuple[str, object]] = []
    hooks = {
        **_make_hooks(recorder),
        "progress": lambda index: ticks.append(index),
    }

    result = execute_browser_run(
        {
            "environment": {"baseUrl": "https://app.test"},
            "flow": {
                "steps": [
                    {"id": "s1", "action": "打开页面", "title": "Open", "value": "/"}
                ]
            },
            "secrets": {},
        },
        hooks,  # type: ignore[arg-type]
    )

    assert result["status"] == "success"
    assert ticks[0] == 0
    assert ticks.count(0) >= 2


def test_heartbeat_stops_and_reclaims_when_step_wedged_past_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """P2-6：单步卡死在 Playwright 之下（超过自身健康预算仍不返回）时，
    心跳线程必须在步骤超窗后停更（否则 updated_at 一直新鲜，DB watchdog
    永不判死），并通过 reclaim 钩子请求释放并发槽。

    卡死判定依据：Playwright 对每个动作都传了显式 timeout，健康步骤必然在
    各自超时前返回/抛错。此处 fake goto 永不返回（也永不抛错），模拟卡在
    CDP 传输层的 worker。
    """
    import threading

    fake_pw = _FakePlaywright()
    monkeypatch.setattr("playwright.sync_api.sync_playwright", lambda: fake_pw)
    monkeypatch.setenv("RUN_HEARTBEAT_INTERVAL_S", "1")
    monkeypatch.setenv("RUN_HEARTBEAT_STEP_GRACE_MS", "0")
    # 压缩导航地板/步骤超时，让「健康预算」缩到 ~2.5s，测试不用等 30s+。
    monkeypatch.setattr("autoflow.runner._NAVIGATE_TIMEOUT_FLOOR_MS", 500)

    unblock = threading.Event()

    class _WedgedPage(_FakePage):
        def goto(self, *args: object, **kwargs: object) -> None:
            # 卡死：真实 Playwright 本应于 1s（timeout:1）后抛 Timeout。
            unblock.wait(timeout=60)

    monkeypatch.setattr(_FakeContext, "new_page", lambda self: _WedgedPage())

    ticks: list[float] = []
    reclaimed: list[float] = []
    results: list[dict[str, object]] = []
    recorder: list[tuple[str, object]] = []

    def run_flow() -> None:
        results.append(
            execute_browser_run(
                {
                    "environment": {"baseUrl": "https://app.test"},
                    "flow": {
                        "steps": [
                            {
                                "id": "s1",
                                "action": "打开页面",
                                "title": "Open",
                                "value": "/",
                                "timeout": 1,
                            }
                        ]
                    },
                    "secrets": {},
                },
                {
                    **_make_hooks(recorder),
                    "progress": lambda _index: ticks.append(time.monotonic()),
                    "reclaim": lambda: reclaimed.append(time.monotonic()),
                },
            )
        )

    worker = threading.Thread(target=run_flow)
    worker.start()
    try:
        # 期望（修复后）：步骤超窗后心跳停更，并触发一次 reclaim。
        deadline = time.monotonic() + 8.0
        while time.monotonic() < deadline and not reclaimed:
            time.sleep(0.05)
        assert reclaimed, (
            "步骤超过健康预算仍不返回时，心跳必须触发 reclaim 释放并发槽；"
            "当前实现只无限续命，DB watchdog 永不判死"
        )
        assert len(reclaimed) == 1

        # reclaim 之后心跳已停更：后续窗口内不得再有 progress 刷新。
        frozen = len(ticks)
        time.sleep(2.5)
        assert len(ticks) == frozen, (
            "超窗后心跳必须停更，否则 updated_at 一直新鲜，DB watchdog 永不判死"
        )
    finally:
        unblock.set()
        worker.join(timeout=5)
    assert results and results[0]["status"] == "success"


# ---------- execute_element_validation ----------


def test_validation_start_sequence_and_teardown(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_pw = _FakePlaywright()
    monkeypatch.setattr("playwright.sync_api.sync_playwright", lambda: fake_pw)
    monkeypatch.setenv("MANAGED_RUNNER_HEADLESS", "1")
    recorder: list[tuple[str, object]] = []
    hooks = _make_hooks(recorder)

    result = execute_element_validation(
        {
            "environment": {"baseUrl": "https://app.test", "testIdAttribute": "data-testid"},
            "element": {"path": "/login", "method": "css", "value": "#email"},
            "storage_state": {"cookies": []},
        },
        hooks,  # type: ignore[arg-type]
    )

    assert result["status"] == "success"
    assert result["count"] == 2
    browser = fake_pw.chromium.launches[0]["browser"]
    context = browser.contexts[0]
    # 校验路径：new_context 透传 storage_state
    assert context.new_context_kwargs == {
        "locale": "zh-CN",
        "storage_state": {"cookies": []},
    }
    assert recorder[-1] == ("browser", "clear")
    assert context.closed and browser.closed and fake_pw.stopped


def test_validation_cancel_runs_teardown(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_pw = _FakePlaywright()
    monkeypatch.setattr("playwright.sync_api.sync_playwright", lambda: fake_pw)
    recorder: list[tuple[str, object]] = []
    signal = threading.Event()
    signal.set()
    hooks = _make_hooks(recorder, signal=signal)

    result = execute_element_validation(
        {
            "environment": {"baseUrl": "https://app.test", "testIdAttribute": "data-testid"},
            "element": {"path": "/login", "method": "css", "value": "#email"},
            "storage_state": None,
        },
        hooks,  # type: ignore[arg-type]
    )

    assert result["status"] == "canceled"
    assert result["error"] == "VALIDATION_CANCELED"
    browser = fake_pw.chromium.launches[0]["browser"]
    context = browser.contexts[0]
    assert recorder[-1] == ("browser", "clear")
    assert context.closed and browser.closed and fake_pw.stopped
