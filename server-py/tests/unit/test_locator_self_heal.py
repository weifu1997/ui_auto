"""阶段2-F：D5 定位器自愈 MVP 单测。

假 Playwright 栈：主定位器命中数 0（动作抛超时），候选备用定位器唯一命中
（count()===1）并成功执行动作。验证：
- F1 启发式评分器：count!=1 判负无穷；唯一命中按定位技术稳定性取分。
- F2 回退重试：元素动作失败 → 候选评分 → 唯一命中者回退 → `step.locatorFallback`
  事件（恒在 step.completed/step.failed 之前）。
- F2 失败不误回退：无候选唯一命中时不发回退事件、按原有超时路径失败。
- F3 安全边界：敏感 run（含 secrets）自愈仍生效，但不绕过 Trace/截图禁用。
"""

from __future__ import annotations

import re

import pytest

from autoflow.locator_score import HeuristicLocatorScorer
from autoflow.runner import execute_browser_run

_ATTR_SELECTOR = re.compile(r'^\[([\w-]+)([*^$]?=)("([^"]*)")\]\s*$')


# ---------- 假 Playwright 栈 ----------


class _FakeLocator:
    def __init__(self, page: "_FakePage", *, count: int, fail_action: bool) -> None:
        self._page = page
        self._count = count
        self._fail_action = fail_action
        self.first = self

    def count(self) -> int:
        return self._count

    def _maybe_raise(self) -> None:
        # 命中数 0 等价真实 Playwright 的自动等待超时（未命中不产生副作用）。
        if self._count == 0 or self._fail_action:
            raise TimeoutError("Timeout 30000ms exceeded waiting for element")

    def click(self, **kwargs: object) -> None:
        self._maybe_raise()
        self._page.actions.append(("click", None))

    def fill(self, value: str, **kwargs: object) -> None:
        self._maybe_raise()
        self._page.actions.append(("fill", value))

    def select_option(self, value: str, **kwargs: object) -> None:
        self._maybe_raise()
        self._page.actions.append(("select", value))

    def check(self, **kwargs: object) -> None:
        self._maybe_raise()
        self._page.actions.append(("check", None))


class _FakePage:
    # 类级配置：测试运行前指定「唯一命中的候选 (kind, value)」，其余一律 count 0。
    HEAL: tuple[str, str] | None = None

    def __init__(self) -> None:
        self.actions: list[tuple[str, str | None]] = []
        self.url = "https://app.test/login"

    def _loc(self, kind: str, value: str, *, fail_action: bool = False) -> _FakeLocator:
        count = 1 if self.HEAL and (kind, value) == self.HEAL else 0
        return _FakeLocator(self, count=count, fail_action=fail_action)

    def locator(self, selector: str) -> _FakeLocator:
        m = _ATTR_SELECTOR.match(selector)
        if m:
            attr, op, _, value = m.groups()
            if op == "=":
                return self._loc("testid", value)
            if op == "*=":
                return self._loc("testidPartial", value)
        return self._loc("css", selector)

    def get_by_role(self, role: str, name: object = None) -> _FakeLocator:
        return self._loc("role", role)

    def get_by_label(self, value: str, **kwargs: object) -> _FakeLocator:
        # 真实语义：缺省精确匹配（主定位失败以驱动自愈），exact=False 才按候选命中。
        if kwargs.get("exact") is False:
            return self._loc("label", value)
        return self._loc("labelExact", value)

    def get_by_text(self, value: str, **kwargs: object) -> _FakeLocator:
        if kwargs.get("exact") is False:
            return self._loc("text", value)
        return self._loc("textExact", value)

    def goto(self, *args: object, **kwargs: object) -> None:
        self.url = "https://app.test/login"

    def evaluate(self, script: str) -> object:
        return False

    def screenshot(self, **kwargs: object) -> None:
        pass

    def wait_for_timeout(self, ms: int) -> None:
        pass


class _FakeTracing:
    def __init__(self) -> None:
        self.started = False

    def start(self, **kwargs: object) -> None:
        self.started = True

    def stop(self, **kwargs: object) -> None:
        pass


class _FakeContext:
    def __init__(self) -> None:
        self.pages: list[_FakePage] = []
        self.tracing = _FakeTracing()

    def new_page(self) -> _FakePage:
        page = _FakePage()
        self.pages.append(page)
        return page

    def close(self) -> None:
        pass


class _FakeBrowser:
    def __init__(self) -> None:
        self.contexts: list[_FakeContext] = []

    def new_context(self, **kwargs: object) -> _FakeContext:
        context = _FakeContext()
        self.contexts.append(context)
        return context

    def close(self) -> None:
        pass


class _FakeChromium:
    def __init__(self) -> None:
        self.launches: list[tuple[object, _FakeBrowser]] = []

    def launch(self, headless: object = None) -> _FakeBrowser:
        browser = _FakeBrowser()
        self.launches.append((headless, browser))
        return browser


class _FakePlaywright:
    def __init__(self) -> None:
        self.chromium = _FakeChromium()

    def __enter__(self) -> "_FakePlaywright":
        return self

    def __exit__(self, *exc: object) -> bool:
        return False

    def stop(self) -> None:
        pass


def _make_hooks(recorder: list[tuple[str, object]]) -> dict[str, object]:
    return {
        "browser": lambda browser, context: recorder.append(
            ("browser", "register" if browser is not None else "clear")
        ),
        "event": lambda kind, payload: recorder.append(("event", kind, payload)),
        "artifact_path": lambda name, ext: f"/tmp/{name}.{ext}",
        "artifact": lambda artifact: recorder.append(("artifact", artifact["name"])),
        "signal": None,
    }


def _event_kinds(recorder: list[tuple[str, object]]) -> list[str]:
    return [entry[1] for entry in recorder if entry[0] == "event"]  # type: ignore[misc]


def _fallback_payloads(
    recorder: list[tuple[str, object]],
) -> list[dict[str, object]]:
    return [
        entry[2]  # type: ignore[misc]
        for entry in recorder
        if entry[0] == "event" and entry[1] == "step.locatorFallback"
    ]


# ---------- F1：启发式评分器 ----------


def test_heuristic_scorer_rejects_ambiguous_or_missing() -> None:
    scorer = HeuristicLocatorScorer()
    page = _FakePage()
    assert scorer.score(_FakeLocator(page, count=0, fail_action=False), page) == float("-inf")
    assert scorer.score(_FakeLocator(page, count=2, fail_action=False), page) == float("-inf")


def test_heuristic_scorer_prefers_stable_technique() -> None:
    scorer = HeuristicLocatorScorer()
    page = _FakePage()
    testid = _FakeLocator(page, count=1, fail_action=False)
    testid._autoflow_method = "testid"  # type: ignore[attr-defined]
    text = _FakeLocator(page, count=1, fail_action=False)
    text._autoflow_method = "text"  # type: ignore[attr-defined]
    assert scorer.score(testid, page) > scorer.score(text, page)


# ---------- F2：定位失败 → 候选回退 ----------


def _flow(secret: bool = False) -> dict[str, object]:
    env: dict[str, object] = {
        "baseUrl": "https://app.test",
        "testIdAttribute": "data-testid",
    }
    flow: dict[str, object] = {
        "flow": {
            "steps": [
                {"id": "s1", "title": "打开登录页", "action": "打开页面", "value": "/login"},
                {
                    "id": "s2",
                    "title": "点击登录",
                    "action": "点击",
                    "element": "登录按钮",
                    "timeout": 1,
                },
            ]
        },
        "environment": env,
        "elements": [
            {
                "id": "e1",
                "name": "登录按钮",
                "path": "/login",
                "method": "testid",
                "value": "login-submit",
            }
        ],
    }
    if secret:
        flow["secrets"] = {"token": "secret-value"}  # type: ignore[assignment]
    return flow


def _run(
    monkeypatch: pytest.MonkeyPatch,
    recorder: list[tuple[str, object]],
    *,
    heal: tuple[str, str] | None,
    secret: bool = False,
) -> tuple[dict[str, object], _FakePage]:
    fake_pw = _FakePlaywright()
    monkeypatch.setattr("playwright.sync_api.sync_playwright", lambda: fake_pw)
    monkeypatch.setenv("MANAGED_RUNNER_HEADLESS", "1")
    _FakePage.HEAL = heal
    try:
        result = execute_browser_run(_flow(secret=secret), _make_hooks(recorder))  # type: ignore[arg-type]
    finally:
        _FakePage.HEAL = None
    page = fake_pw.chromium.launches[0][1].contexts[0].pages[0]
    return result, page


def test_heals_via_unique_candidate_and_emits_fallback_before_completed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    recorder: list[tuple[str, object]] = []
    # 主定位器 [data-testid="login-submit"] count 0（动作超时）；候选
    # [data-testid*="login-submit"] 唯一命中（count 1）。
    result, page = _run(monkeypatch, recorder, heal=("testidPartial", "login-submit"))

    assert result["status"] == "success"
    assert result["completedSteps"] == 2
    assert page.actions == [("click", None)]  # 自愈后成功点击一次

    kinds = _event_kinds(recorder)
    # 回退事件载荷：既有契约字段（method/value）+ 自愈原因，恒在结论事件之前。
    payloads = _fallback_payloads(recorder)
    assert len(payloads) == 1
    assert payloads[0]["method"] == "testidPartial"
    assert payloads[0]["value"] == "login-submit"
    assert "reason" in payloads[0]
    # 回退事件恒在同一步的结论事件（step.completed）之前。
    fb_index = kinds.index("step.locatorFallback")
    assert kinds[fb_index + 1] == "step.completed"
    assert "step.failed" not in kinds[fb_index:]


def test_no_heal_when_no_candidate_uniquely_matches(monkeypatch: pytest.MonkeyPatch) -> None:
    recorder: list[tuple[str, object]] = []
    # 页面无任何唯一命中的候选 → 保持既有失败路径（execute_browser_run 返回
    # status=failed 并携带超时错误，不抛异常）。
    result, _page = _run(monkeypatch, recorder, heal=None)

    assert result["status"] == "failed"
    assert "步骤「点击」超时" in str(result.get("error", ""))
    kinds = _event_kinds(recorder)
    assert "step.locatorFallback" not in kinds
    assert "step.failed" in kinds


def test_heals_fill_via_label_substring(monkeypatch: pytest.MonkeyPatch) -> None:
    """label 技术退化：get_by_label(exact) 失败 → exact=False 子串唯一命中。"""
    recorder: list[tuple[str, object]] = []
    flow = _flow()
    flow["flow"]["steps"] = [
        {"id": "s1", "title": "打开登录页", "action": "打开页面", "value": "/login"},
        {"id": "s2", "title": "填写账号", "action": "填写", "element": "账号框", "value": "alice"},
    ]
    flow["elements"] = [
        {"id": "e2", "name": "账号框", "path": "/login", "method": "label", "value": "账号"}
    ]
    fake_pw = _FakePlaywright()
    monkeypatch.setattr("playwright.sync_api.sync_playwright", lambda: fake_pw)
    monkeypatch.setenv("MANAGED_RUNNER_HEADLESS", "1")
    _FakePage.HEAL = ("label", "账号")
    try:
        result = execute_browser_run(flow, _make_hooks(recorder))  # type: ignore[arg-type]
    finally:
        _FakePage.HEAL = None
    page = fake_pw.chromium.launches[0][1].contexts[0].pages[0]

    assert result["status"] == "success"
    assert page.actions == [("fill", "alice")]
    kinds = _event_kinds(recorder)
    assert kinds.count("step.locatorFallback") == 1
    assert _fallback_payloads(recorder)[0]["method"] == "label"


# ---------- F3：安全边界 ----------


def test_sensitive_run_self_heal_keeps_trace_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    recorder: list[tuple[str, object]] = []
    fake_pw = _FakePlaywright()
    monkeypatch.setattr("playwright.sync_api.sync_playwright", lambda: fake_pw)
    monkeypatch.setenv("MANAGED_RUNNER_HEADLESS", "1")
    _FakePage.HEAL = ("testidPartial", "login-submit")
    try:
        result = execute_browser_run(_flow(secret=True), _make_hooks(recorder))  # type: ignore[arg-type]
    finally:
        _FakePage.HEAL = None

    assert result["status"] == "success"
    kinds = _event_kinds(recorder)
    assert "run.security" in kinds
    assert kinds.count("step.locatorFallback") == 1
    # 敏感 run：不开启 Trace、不产生 trace/截图产物。
    context = fake_pw.chromium.launches[0][1].contexts[0]
    assert context.tracing.started is False
    artifacts = [entry[1] for entry in recorder if entry[0] == "artifact"]
    assert "trace.zip" not in artifacts
