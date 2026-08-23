"""Assertion step execution tests: four assertion types, failure policies,
event ordering contract, result payload, and revision checksum regression.

Coverage per AC1/AC2/AC3:
- four types x (pass/fail) >= 8 cases;
- text/attribute exact and contains each >= 1;
- count covers "=" and ">=", plus the int() coercion paths ("5" vs "abc");
- visibility covers visible/hidden and the not-found distinction;
- cross-type misuse falls back to defaults without erroring;
- assertion failure + continue policy does not abort the run and keeps
  step.asserted(passed:false);
- assertion failure + immediate-fail marks the run failed, keeps
  step.asserted(passed:false) with expected/actual, and asserts the ordering
  contract (step.asserted strictly before the conclusion event);
- old flows without the new fields still execute normally;
- changing an assertion field changes the revision checksum; old flows keep it.
"""

from __future__ import annotations

import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

import pytest

from autoflow.revision_snapshot import canonical_checksum
from autoflow.runner import (
    _assert_attribute,
    _assert_count,
    _assert_text,
    _assert_visibility,
    execute_browser_run,
)

FIXTURE_HTML = """<!doctype html>
<html lang="zh-CN"><body>
  <h1 id="order-title">Order #12345</h1>
  <p class="item" data-testid="item">Apple</p>
  <p class="item" data-testid="item">Banana</p>
  <p class="item" data-testid="item">Cherry</p>
  <input id="name-input" value="hello world" disabled />
  <div id="hidden-box" style="display:none">Hidden content</div>
  <a id="link" href="/target">Link text</a>
</body></html>"""


@pytest.fixture(scope="module")
def http_server():
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 (http.server API)
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(FIXTURE_HTML.encode("utf-8"))

        def log_message(self, *_args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture
def playwright_browser():
    # 函数级作用域：纯函数测试各自启停浏览器。若保持模块级常驻，
    # 其 Sync 驱动的 asyncio loop 会一直占用当前线程，导致后续
    # execute_browser_run 内部的 sync_playwright() 报「Sync API inside
    # the asyncio loop」。
    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        yield browser
        browser.close()


@pytest.fixture
def page(playwright_browser, http_server):
    context = playwright_browser.new_context()
    page = context.new_page()
    page.goto(http_server, wait_until="load")
    yield page
    context.close()


def _element(name: str, selector: str, method: str = "css") -> dict[str, Any]:
    return {
        "id": f"el-{name}",
        "name": name,
        "path": "/",
        "method": method,
        "value": selector,
        "environment": "env-1",
    }


def _step(
    step_id: str,
    action: str,
    *,
    element: str | None = None,
    value: str = "",
    timeout: int = 2,
    failure_policy: str = "立即失败",
    **fields: Any,
) -> dict[str, Any]:
    step: dict[str, Any] = {
        "id": step_id,
        "action": action,
        "title": action,
        "value": value,
        "timeout": timeout,
        "failurePolicy": failure_policy,
        "status": "pending",
    }
    if element is not None:
        step["element"] = element
    step.update(fields)
    return step


def _run_input(
    base_url: str,
    steps: list[dict[str, Any]],
    elements: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "environment": {"baseUrl": base_url, "headless": True, "timeout": 30},
        "flow": {"id": "flow-1", "name": "Test flow", "steps": steps},
        "elements": elements or [],
        "variables": {},
        "data": {},
        "secrets": {},
    }


def _event_index(events: list[tuple[str, dict[str, Any]]], kind: str, step_id: str) -> int:
    """返回首个匹配 kind+stepId 的事件下标；未找到返回 -1。

    断言步骤的结论事件与 step.asserted 必须按 stepId 配对比较，
    不能只看 kind 全局下标（打开页面步骤的 step.completed 会提前出现）。
    """
    for index, (event_kind, data) in enumerate(events):
        if event_kind == kind and data.get("stepId") == step_id:
            return index
    return -1


def _hooks():
    events: list[tuple[str, dict[str, Any]]] = []
    artifacts: list[dict[str, Any]] = []
    hooks = {
        "signal": threading.Event(),
        "artifact_path": lambda name, extension: f"/tmp/assertion-test-{name}.{extension}",
        "artifact": artifacts.append,
        "event": lambda kind, data: events.append((kind, data)),
        "browser": lambda *args: None,
    }
    return hooks, events, artifacts


# ---------------------------------------------------------------------------
# 纯函数：可见性断言
# ---------------------------------------------------------------------------


def test_visibility_visible_pass(page):
    passed, expected, actual = _assert_visibility(
        page.locator("#order-title"), page, {"assertVisibility": "visible"}, 2000, ""
    )
    assert passed is True
    assert expected == "visible"
    assert actual == "visible"


def test_visibility_visible_fail_on_hidden(page):
    passed, expected, actual = _assert_visibility(
        page.locator("#hidden-box"), page, {"assertVisibility": "visible"}, 500, ""
    )
    assert passed is False
    assert expected == "visible"
    assert actual == "hidden"


def test_visibility_visible_fail_on_missing(page):
    passed, expected, actual = _assert_visibility(
        page.locator("#does-not-exist"), page, {}, 500, ""
    )
    assert passed is False
    assert expected == "visible"
    assert actual == "not-found"


def test_visibility_hidden_pass_present(page):
    passed, expected, actual = _assert_visibility(
        page.locator("#hidden-box"), page, {"assertVisibility": "hidden"}, 2000, ""
    )
    assert passed is True
    assert expected == "hidden"
    assert actual == "hidden"


def test_visibility_hidden_pass_not_found(page):
    passed, expected, actual = _assert_visibility(
        page.locator("#does-not-exist"), page, {"assertVisibility": "hidden"}, 2000, ""
    )
    assert passed is True
    assert expected == "hidden"
    assert actual == "not-found"


def test_visibility_hidden_fail_when_visible(page):
    passed, expected, actual = _assert_visibility(
        page.locator("#order-title"), page, {"assertVisibility": "hidden"}, 500, ""
    )
    assert passed is False
    assert expected == "hidden"
    assert actual == "visible"


def test_visibility_cross_type_value_falls_back_to_visible(page):
    # assertMatch 不属于可见性断言的枚举：回落默认 visible，不报错。
    passed, expected, _ = _assert_visibility(
        page.locator("#order-title"), page, {"assertMatch": "exact"}, 2000, ""
    )
    assert passed is True
    assert expected == "visible"


# ---------------------------------------------------------------------------
# 纯函数：文本断言
# ---------------------------------------------------------------------------


def test_text_contains_pass(page):
    passed, expected, actual = _assert_text(
        page.locator("#order-title"), page, {"assertMatch": "contains"}, 2000, "Order"
    )
    assert passed is True
    assert expected == "Order"
    assert actual == "Order #12345"


def test_text_contains_fail(page):
    passed, expected, actual = _assert_text(
        page.locator("#order-title"), page, {"assertMatch": "contains"}, 2000, "Invoice"
    )
    assert passed is False
    assert expected == "Invoice"
    assert actual == "Order #12345"


def test_text_exact_pass(page):
    passed, expected, actual = _assert_text(
        page.locator("#order-title"), page, {"assertMatch": "exact"}, 2000, "Order #12345"
    )
    assert passed is True
    assert expected == "Order #12345"
    assert actual == "Order #12345"


def test_text_exact_fail(page):
    passed, expected, actual = _assert_text(
        page.locator("#order-title"), page, {"assertMatch": "exact"}, 2000, "Order"
    )
    assert passed is False
    assert expected == "Order"
    assert actual == "Order #12345"


def test_text_default_match_is_contains(page):
    # 旧流程无 assertMatch：缺省 contains，保持既有 value in actual 行为。
    passed, _, _ = _assert_text(
        page.locator("#order-title"), page, {}, 2000, "Order"
    )
    assert passed is True


def test_text_cross_type_value_falls_back_to_contains(page):
    # assertVisibility 不属于文本断言的枚举：回落默认 contains，不报错。
    passed, _, _ = _assert_text(
        page.locator("#order-title"), page, {"assertVisibility": "hidden"}, 2000, "Order"
    )
    assert passed is True


def test_text_missing_element_reports_not_found(page):
    passed, expected, actual = _assert_text(
        page.locator("#does-not-exist"), page, {"assertMatch": "contains"}, 500, "x"
    )
    assert passed is False
    assert expected == "x"
    assert actual == "not-found"


# ---------------------------------------------------------------------------
# 纯函数：数量断言
# ---------------------------------------------------------------------------


def test_count_equals_pass(page):
    passed, expected, actual = _assert_count(
        page.locator('[data-testid="item"]'), page, {"assertOperator": "="}, 2000, "3"
    )
    assert passed is True
    assert expected == "3"
    assert actual == "3"


def test_count_equals_fail(page):
    passed, expected, actual = _assert_count(
        page.locator('[data-testid="item"]'), page, {"assertOperator": "="}, 2000, "5"
    )
    assert passed is False
    assert expected == "5"
    assert actual == "3"


def test_count_gte_pass(page):
    passed, _, _ = _assert_count(
        page.locator('[data-testid="item"]'), page, {"assertOperator": ">="}, 2000, "3"
    )
    assert passed is True


def test_count_gte_fail(page):
    passed, _, actual = _assert_count(
        page.locator('[data-testid="item"]'), page, {"assertOperator": ">="}, 2000, "4"
    )
    assert passed is False
    assert actual == "3"


def test_count_invalid_value_is_failure(page):
    # value 非数字：int() 强转失败即断言失败，actual 固定为 invalid，
    # 禁止字符串与数字直接比较。
    passed, expected, actual = _assert_count(
        page.locator('[data-testid="item"]'), page, {"assertOperator": "="}, 2000, "abc"
    )
    assert passed is False
    assert expected == "abc"
    assert actual == "invalid"


def test_count_default_operator_is_equals(page):
    passed, _, _ = _assert_count(
        page.locator('[data-testid="item"]'), page, {}, 2000, "3"
    )
    assert passed is True


def test_count_lt_pass(page):
    passed, _, _ = _assert_count(
        page.locator('[data-testid="item"]'), page, {"assertOperator": "<"}, 2000, "4"
    )
    assert passed is True


# ---------------------------------------------------------------------------
# 纯函数：属性断言
# ---------------------------------------------------------------------------


def test_attribute_contains_pass(page):
    passed, expected, actual = _assert_attribute(
        page.locator("#name-input"),
        page,
        {"assertMatch": "contains", "assertAttribute": "value"},
        2000,
        "hello",
    )
    assert passed is True
    assert expected == "hello"
    assert actual == "hello world"


def test_attribute_exact_pass(page):
    passed, _, actual = _assert_attribute(
        page.locator("#name-input"),
        page,
        {"assertMatch": "exact", "assertAttribute": "value"},
        2000,
        "hello world",
    )
    assert passed is True
    assert actual == "hello world"


def test_attribute_exact_fail(page):
    passed, expected, actual = _assert_attribute(
        page.locator("#name-input"),
        page,
        {"assertMatch": "exact", "assertAttribute": "value"},
        2000,
        "hello",
    )
    assert passed is False
    assert expected == "hello"
    assert actual == "hello world"


def test_attribute_default_name_is_value(page):
    # 无 assertAttribute：缺省属性名 value。
    passed, _, actual = _assert_attribute(
        page.locator("#name-input"), page, {"assertMatch": "exact"}, 2000, "hello world"
    )
    assert passed is True
    assert actual == "hello world"


def test_attribute_disabled_presence_is_empty_string(page):
    # 布尔属性（disabled）存在时 get_attribute 返回空字符串，而非 "true"。
    passed, expected, actual = _assert_attribute(
        page.locator("#name-input"),
        page,
        {"assertMatch": "exact", "assertAttribute": "disabled"},
        2000,
        "",
    )
    assert passed is True
    assert expected == ""
    assert actual == ""


def test_attribute_missing_attribute_fails(page):
    passed, _, actual = _assert_attribute(
        page.locator("#name-input"),
        page,
        {"assertMatch": "contains", "assertAttribute": "href"},
        2000,
        "x",
    )
    assert passed is False
    assert actual == ""


# ---------------------------------------------------------------------------
# 全流程：execute_browser_run 载荷 / 事件 / 失败策略 / 顺序契约
# ---------------------------------------------------------------------------


def _assertion_steps(base_url: str, *assertion_steps: dict[str, Any]) -> dict[str, Any]:
    steps: list[dict[str, Any]] = [
        _step("s-open", "打开页面", value="/", timeout=30),
        *assertion_steps,
    ]
    elements = [
        _element("title", "#order-title"),
        _element("item", '[data-testid="item"]'),
        _element("hidden", "#hidden-box"),
    ]
    return _run_input(base_url, steps, elements)


def test_full_flow_text_assertion_pass(http_server):
    hooks, events, _artifacts = _hooks()
    result = execute_browser_run(
        _assertion_steps(
            http_server,
            _step("s-assert", "文本断言", element="title", value="Order", assertMatch="contains"),
        ),
        hooks,
    )
    assert result["status"] == "success"
    assert result["completedSteps"] == 2
    assert result["assertions"] == [
        {
            "stepIndex": 1,
            "stepId": "s-assert",
            "title": "文本断言",
            "type": "text",
            "passed": True,
            "expected": "Order",
            "actual": "Order #12345",
            "durationMs": result["assertions"][0]["durationMs"],
        }
    ]
    # 顺序契约：同一断言步骤的 step.asserted 恒在其 step.completed 之前。
    asserted_index = _event_index(events, "step.asserted", "s-assert")
    completed_index = _event_index(events, "step.completed", "s-assert")
    assert asserted_index != -1 and completed_index != -1
    assert asserted_index < completed_index


def test_full_flow_immediate_fail_marks_run_failed(http_server):
    hooks, events, _artifacts = _hooks()
    result = execute_browser_run(
        _assertion_steps(
            http_server,
            _step(
                "s-assert",
                "文本断言",
                element="title",
                value="Invoice",
                assertMatch="contains",
                failure_policy="立即失败",
            ),
        ),
        hooks,
    )
    assert result["status"] == "failed"
    assert result["completedSteps"] == 1
    assert "ASSERTION_FAILED" in result["error"]
    assert len(result["assertions"]) == 1
    record = result["assertions"][0]
    assert record["stepIndex"] == 1
    assert record["stepId"] == "s-assert"
    assert record["type"] == "text"
    assert record["passed"] is False
    assert record["expected"] == "Invoice"
    assert record["actual"] == "Order #12345"

    kinds = [kind for kind, _ in events]
    asserted_index = kinds.index("step.asserted")
    failed_index = kinds.index("step.failed")
    # 顺序契约：step.asserted 恒在对应结论事件（step.failed）之前。
    assert asserted_index < failed_index
    asserted_event = events[asserted_index][1]
    assert asserted_event["passed"] is False
    assert asserted_event["expected"] == "Invoice"
    assert asserted_event["actual"] == "Order #12345"


def test_full_flow_continue_policy_does_not_abort(http_server):
    hooks, events, _artifacts = _hooks()
    result = execute_browser_run(
        _assertion_steps(
            http_server,
            _step(
                "s-fail",
                "文本断言",
                element="title",
                value="Invoice",
                assertMatch="contains",
                failure_policy="继续执行",
            ),
            _step("s-pass", "文本断言", element="title", value="Order", assertMatch="contains"),
        ),
        hooks,
    )
    assert result["status"] == "success"
    # 打开页面 + s-pass 完成；s-fail 未计入 completedSteps。
    assert result["completedSteps"] == 2
    assert [record["passed"] for record in result["assertions"]] == [False, True]
    # 断言失败 + 继续执行：step.asserted(passed:false) 存在，流程不中止。
    failed_asserted = events[_event_index(events, "step.asserted", "s-fail")][1]
    assert failed_asserted["passed"] is False
    assert failed_asserted["expected"] == "Invoice"
    # 后续步骤仍完成（打开页面 + s-pass；s-fail 为失败事件）。
    completed_events = [data for kind, data in events if kind == "step.completed"]
    assert len(completed_events) == 2
    assert completed_events[-1]["stepId"] == "s-pass"


def test_full_flow_retry_emits_per_attempt_asserted(http_server):
    hooks, events, _artifacts = _hooks()
    result = execute_browser_run(
        _assertion_steps(
            http_server,
            _step(
                "s-assert",
                "文本断言",
                element="title",
                value="Invoice",
                assertMatch="contains",
                failure_policy="重试 1 次",
            ),
        ),
        hooks,
    )
    assert result["status"] == "failed"
    asserted_events = [
        data for kind, data in events if kind == "step.asserted"
    ]
    # 每次尝试各发一组 step.asserted，最终结论事件在最后。
    assert len(asserted_events) == 2
    assert all(data["passed"] is False for data in asserted_events)
    kinds = [kind for kind, _ in events]
    assert kinds.count("step.retrying") == 1
    assert kinds.count("step.failed") == 1
    # 重试仍失败：assertions 只保留最终一条。
    assert len(result["assertions"]) == 1
    assert result["assertions"][0]["passed"] is False


def test_full_flow_old_flow_without_new_fields_still_runs(http_server):
    # 旧流程：可见性断言/文本断言无任何断言字段，缺省语义不变量。
    hooks, _events, _artifacts = _hooks()
    steps = [
        _step("s-open", "打开页面", value="/", timeout=30),
        _step("s-vis", "可见性断言", element="title"),
        _step("s-text", "文本断言", element="title", value="Order"),
    ]
    result = execute_browser_run(_run_input(http_server, steps, [_element("title", "#order-title")]), hooks)
    assert result["status"] == "success"
    assert [record["type"] for record in result["assertions"]] == ["visibility", "text"]
    assert all(record["passed"] for record in result["assertions"])


def test_full_flow_count_and_attribute(http_server):
    hooks, _events, _artifacts = _hooks()
    steps = [
        _step("s-open", "打开页面", value="/", timeout=30),
        _step("s-count", "数量断言", element="item", value="3", assertOperator=">="),
        # id="order-title" 含小写 "order"，contains 命中。
        _step("s-attr", "属性断言", element="title", value="order", assertMatch="contains", assertAttribute="id"),
    ]
    elements = [_element("item", '[data-testid="item"]'), _element("title", "#order-title")]
    result = execute_browser_run(_run_input(http_server, steps, elements), hooks)
    assert result["status"] == "success"
    records = result["assertions"]
    assert records[0]["type"] == "count"
    assert records[0]["passed"] is True
    assert records[0]["actual"] == "3"
    assert records[1]["type"] == "attribute"
    assert records[1]["passed"] is True
    assert records[1]["actual"] == "order-title"


def test_full_flow_hidden_assertion_not_found_passes(http_server):
    hooks, _events, _artifacts = _hooks()
    steps = [
        _step("s-open", "打开页面", value="/", timeout=30),
        _step("s-hidden", "可见性断言", element="hidden", assertVisibility="hidden"),
    ]
    result = execute_browser_run(_run_input(http_server, steps, [_element("hidden", "#hidden-box")]), hooks)
    assert result["status"] == "success"
    assert result["assertions"][0]["passed"] is True
    assert result["assertions"][0]["actual"] == "hidden"


# ---------------------------------------------------------------------------
# revision checksum 回归（AC3）
# ---------------------------------------------------------------------------


def _checksum_flow(step_fields: dict[str, Any]) -> str:
    flow = {
        "id": "flow-1",
        "name": "Flow",
        "steps": [
            {"id": "s-1", "action": "文本断言", "element": "e-1", "value": "Order", **step_fields}
        ],
    }
    environment = {"id": "env-1", "name": "Env", "browser": "Chromium"}
    elements: list[dict[str, Any]] = []
    return canonical_checksum(flow, environment, elements)


def test_assertion_field_change_produces_new_checksum():
    base = _checksum_flow({})
    exact = _checksum_flow({"assertMatch": "exact"})
    contains = _checksum_flow({"assertMatch": "contains"})
    assert base != exact
    assert exact != contains
    # 其它断言字段同样进 checksum。
    assert _checksum_flow({"assertVisibility": "hidden"}) != base
    assert _checksum_flow({"assertOperator": ">="}) != base
    assert _checksum_flow({"assertAttribute": "value"}) != base


def test_old_flow_checksum_stable_across_calls():
    first = _checksum_flow({})
    second = _checksum_flow({})
    assert first == second
