"""Playwright execution core matching server/runner-core.ts."""

from __future__ import annotations

import json
import os
import re
import time
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.parse import urljoin, urlparse


def interpolate(
    value: str,
    input: dict[str, Any],
    outputs: dict[str, str],
) -> str:
    def replace(match: re.Match[str]) -> str:
        expression = match.group(1).strip()
        parts = expression.split(".")
        scope = parts[0]
        key = ".".join(parts[1:])
        if scope == "env":
            if key == "baseUrl":
                return str(input.get("environment", {}).get("baseUrl", ""))
            return str(input.get("variables", {}).get(f"env.{key}", ""))
        if scope == "project":
            return str(
                input.get("variables", {}).get(f"project.{key}")
                or input.get("variables", {}).get(key, "")
            )
        if scope == "data":
            return str(input.get("data", {}).get(key, ""))
        if scope == "secret":
            return str(input.get("secrets", {}).get(key, ""))
        if scope == "flow":
            return str(outputs.get(key) or input.get("variables", {}).get(f"flow.{key}", ""))
        if scope == "run" and key == "timestamp":
            return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
        variables = input.get("variables", {})
        secrets = input.get("secrets", {})
        if expression in variables:
            return str(variables[expression])
        if expression in secrets:
            return str(secrets[expression])
        return ""

    return re.sub(r"{{\s*([^}]+)\s*}}", replace, value)


def _target_url(base_url: str, value: str) -> str:
    base = urlparse(base_url)
    target = urlparse(urljoin(base_url, value or "/"))
    if (
        base.scheme not in ("http", "https")
        or target.scheme not in ("http", "https")
        or target.netloc != base.netloc
    ):
        raise RuntimeError("TARGET_URL_ORIGIN_FORBIDDEN")
    return target.geturl()


_NAVIGATE_WAIT_UNTIL = "commit"
# 导航类操作的 timeout 下限（毫秒）：避免用户误将环境 timeout 配置为过小值（比如 10s）
# 导致 SPA 应用、远程部署机网络抖动等情况频繁超时。导航阶段至少给 30s；
# 点击/输入等元素级操作仍然严格按用户环境配置。
_NAVIGATE_TIMEOUT_FLOOR_MS = 30_000


def _navigate_timeout_ms(environment_or_step: dict[str, Any], default_seconds: int = 30) -> int:
    """根据环境/步骤的 timeout 字段计算导航超时，并用合理下限兜底。"""
    return max(_NAVIGATE_TIMEOUT_FLOOR_MS, max(1, int(environment_or_step.get("timeout", default_seconds))) * 1000)


def _ensure_page_opened(
    page: Any,
    element: dict[str, Any] | None,
    input: dict[str, Any],
) -> None:
    if page.url != "about:blank" or not element:
        return
    environment = input.get("environment", {})
    base_url = str(environment.get("baseUrl", ""))
    path = str(element.get("path") or "/")
    timeout = _navigate_timeout_ms(environment)
    page.goto(
        _target_url(base_url, path),
        wait_until=_NAVIGATE_WAIT_UNTIL,
        timeout=timeout,
    )


def _locator_for(
    page: Any,
    element: dict[str, Any],
    test_id_attribute: str = "data-testid",
) -> Any:
    value = str(element.get("value", ""))
    method = element.get("method")
    if method == "testid":
        if not re.match(r"^[a-zA-Z_][\w:-]*$", test_id_attribute):
            raise RuntimeError("INVALID_TEST_ID_ATTRIBUTE")
        return page.locator(f"[{test_id_attribute}={json.dumps(value)}]")
    if method == "label":
        return page.get_by_label(value)
    if method == "text":
        return page.get_by_text(value, exact=True)
    if method == "role":
        match = re.match(r"^([\w-]+)(?:\[name=['\"]?(.*?)['\"]?\])?$", value)
        role = match.group(1) if match else value
        name = match.group(2) if match and match.group(2) else None
        return page.get_by_role(role, name=name)
    if method == "XPath":
        return page.locator(f"xpath={value}")
    return page.locator(value)


def _required(locator: Any) -> Any:
    if locator is None:
        raise RuntimeError("STEP_ELEMENT_REQUIRED")
    return locator


_ASSERT_OPERATORS = ("=", ">", "<", ">=", "<=")
_ASSERT_MATCHES = ("exact", "contains")
_ASSERT_VISIBILITIES = ("visible", "hidden")

# 断言动作 -> 判定 type（事件/结果载荷里的统一标识）。
_ASSERTION_TYPES = {
    "可见性断言": "visibility",
    "文本断言": "text",
    "数量断言": "count",
    "属性断言": "attribute",
}


def _assert_visibility(
    locator: Any,
    page: Any,
    step: dict[str, Any],
    timeout_ms: int,
    value: str,
) -> tuple[bool, str, str]:
    """可见性断言：元素可见（默认）/不可见。

    hidden 区分「不存在」与「存在但隐藏」：两者都算通过，但 actual 分别
    报告为 not-found / hidden，便于审计定位。跨类型误值回落默认 visible。
    """
    expected = step.get("assertVisibility")
    if expected not in _ASSERT_VISIBILITIES:
        expected = "visible"
    try:
        if expected == "visible":
            locator.wait_for(state="visible", timeout=timeout_ms)
            return True, "visible", "visible"
        locator.wait_for(state="hidden", timeout=timeout_ms)
        actual = "hidden" if locator.count() > 0 else "not-found"
        return True, "hidden", actual
    except Exception:
        if expected == "visible":
            actual = "hidden" if locator.count() > 0 else "not-found"
        else:
            actual = "visible"
        return False, expected, actual


def _assert_text(
    locator: Any,
    page: Any,
    step: dict[str, Any],
    timeout_ms: int,
    value: str,
) -> tuple[bool, str, str]:
    """文本断言：元素文本按匹配方式命中期望值（exact/contains，缺省 contains）。"""
    match = step.get("assertMatch")
    if match not in _ASSERT_MATCHES:
        match = "contains"
    expected = value
    if locator is None:
        raise RuntimeError("STEP_ELEMENT_REQUIRED")
    try:
        actual = locator.text_content(timeout=timeout_ms) or ""
    except Exception:
        return False, expected, "not-found"
    passed = actual == expected if match == "exact" else expected in actual
    return passed, expected, actual


def _assert_count(
    locator: Any,
    page: Any,
    step: dict[str, Any],
    timeout_ms: int,
    value: str,
) -> tuple[bool, str, str]:
    """数量断言：匹配元素个数与期望数的关系（= > < >= <=，缺省 =）。

    期望数存于 value（字符串），执行前 int() 强转；转换失败即该断言失败，
    不得让字符串与数字直接比较。
    """
    operator = step.get("assertOperator")
    if operator not in _ASSERT_OPERATORS:
        operator = "="
    expected = value
    try:
        expected_number = int(value)
    except (TypeError, ValueError):
        return False, expected, "invalid"
    if locator is None:
        raise RuntimeError("STEP_ELEMENT_REQUIRED")
    actual_count = locator.count()
    if operator == "=":
        passed = actual_count == expected_number
    elif operator == ">":
        passed = actual_count > expected_number
    elif operator == "<":
        passed = actual_count < expected_number
    elif operator == ">=":
        passed = actual_count >= expected_number
    else:
        passed = actual_count <= expected_number
    return passed, expected, str(actual_count)


def _assert_attribute(
    locator: Any,
    page: Any,
    step: dict[str, Any],
    timeout_ms: int,
    value: str,
) -> tuple[bool, str, str]:
    """属性断言：元素某属性值按匹配方式命中期望值（缺省属性名 value）。"""
    match = step.get("assertMatch")
    if match not in _ASSERT_MATCHES:
        match = "contains"
    attribute = step.get("assertAttribute")
    if not isinstance(attribute, str) or attribute == "":
        attribute = "value"
    expected = value
    if locator is None:
        raise RuntimeError("STEP_ELEMENT_REQUIRED")
    try:
        actual = locator.get_attribute(attribute, timeout=timeout_ms) or ""
    except Exception:
        return False, expected, "not-found"
    passed = actual == expected if match == "exact" else expected in actual
    return passed, expected, actual


def _run_assertion(
    locator: Any,
    page: Any,
    step: dict[str, Any],
    timeout_ms: int,
    value: str,
) -> dict[str, Any]:
    """按动作分发到四种断言判定，返回结构化判定 {type, passed, expected, actual}。"""
    action = step.get("action")
    if action == "可见性断言":
        passed, expected, actual = _assert_visibility(locator, page, step, timeout_ms, value)
    elif action == "文本断言":
        passed, expected, actual = _assert_text(locator, page, step, timeout_ms, value)
    elif action == "数量断言":
        passed, expected, actual = _assert_count(locator, page, step, timeout_ms, value)
    else:  # 属性断言
        passed, expected, actual = _assert_attribute(locator, page, step, timeout_ms, value)
    return {
        "type": _ASSERTION_TYPES.get(action, "text"),
        "passed": passed,
        "expected": expected,
        "actual": actual,
    }


class _AssertionFailure(RuntimeError):
    """断言未通过：携带结构化判定记录，由执行循环写 result.assertions 并走既有 failurePolicy。"""

    def __init__(self, record: dict[str, Any]):
        super().__init__(
            f"ASSERTION_FAILED: {record['type']} "
            f"expected={record['expected']} actual={record['actual']}"
        )
        self.record = record


def _capture_output(
    page: Any,
    step: dict[str, Any],
    locator: Any,
) -> str | None:
    if not step.get("output"):
        return None
    output_source = step.get("outputSource")
    if output_source == "url":
        parsed = urlparse(page.url)
        if step.get("outputParameter"):
            from urllib.parse import parse_qs

            values = parse_qs(parsed.query).get(step["outputParameter"], [])
            return values[0] if values else ""
        return page.url
    if output_source == "attribute" and locator is not None:
        value = locator.get_attribute(str(step.get("outputAttribute", "")))
        return value or ""
    if locator is not None:
        return locator.text_content() or ""
    return ""


def _execute_step(
    page: Any,
    step: dict[str, Any],
    input: dict[str, Any],
    outputs: dict[str, str],
    hooks: dict[str, Any],
    index: int = -1,
) -> dict[str, Any] | None:
    """执行一个步骤。

    断言步骤返回结构化判定记录（含 stepIndex/stepId/title/type/passed/expected/
    actual/durationMs）；非断言步骤返回 None。断言判定由本函数先发 step.asserted，
    失败时抛 _AssertionFailure（携带记录），由 execute_browser_run 的既有
    failurePolicy 逻辑决定中止/继续/重试，并保证 step.asserted 恒在结论事件之前。
    """
    value = interpolate(str(step.get("value", "")), input, outputs)
    element = None
    if step.get("element"):
        reference = step["element"]
        elements = input.get("elements", [])
        element = next(
            (
                item
                for item in elements
                if item.get("name") == reference or item.get("id") == reference
            ),
            None,
        )
    locator = (
        _locator_for(
            page,
            element,
            str(input.get("environment", {}).get("testIdAttribute", "data-testid")),
        )
        if element
        else None
    )
    timeout = max(1, int(step.get("timeout", 30))) * 1000
    if step.get("action") != "打开页面":
        before = page.url
        _ensure_page_opened(page, element, input)
        if page.url != before:
            hooks["event"](
                "step.autoOpened",
                {"title": step.get("title"), "message": f"自动打开页面：{page.url}"},
            )
    assertion_record: dict[str, Any] | None = None
    try:
        action = step.get("action")
        if action == "打开页面":
            page.goto(
                _target_url(str(input.get("environment", {}).get("baseUrl", "")), value),
                wait_until=_NAVIGATE_WAIT_UNTIL,
                timeout=_navigate_timeout_ms(step),
            )
        elif action == "点击":
            _required(locator).click(timeout=timeout)
        elif action == "填写":
            _required(locator).fill(value, timeout=timeout)
        elif action == "清空填写":
            _required(locator).fill("", timeout=timeout)
        elif action == "选择下拉项":
            _required(locator).select_option(value, timeout=timeout)
        elif action == "勾选":
            _required(locator).check(timeout=timeout)
        elif action == "键盘按键":
            if locator:
                locator.press(value, timeout=timeout)
            else:
                page.keyboard.press(value)
        elif action == "等待":
            try:
                wait_ms = int(value)
            except ValueError:
                wait_ms = timeout
            page.wait_for_timeout(wait_ms)
        elif action in _ASSERTION_TYPES:
            assertion_started = time.time()
            assertion = _run_assertion(locator, page, step, timeout, value)
            duration_ms = int((time.time() - assertion_started) * 1000)
            assertion_record = {
                "stepIndex": index,
                "stepId": step.get("id"),
                "title": step.get("title"),
                "type": assertion["type"],
                "passed": assertion["passed"],
                "expected": assertion["expected"],
                "actual": assertion["actual"],
                "durationMs": duration_ms,
            }
            # 顺序契约：断言判定恒在对应 step.completed / step.failed 之前发出。
            hooks["event"](
                "step.asserted",
                {
                    "index": index,
                    "stepId": step.get("id"),
                    "title": step.get("title"),
                    "type": assertion["type"],
                    "passed": assertion["passed"],
                    "expected": assertion["expected"],
                    "actual": assertion["actual"],
                    "durationMs": duration_ms,
                },
            )
            if not assertion["passed"]:
                raise _AssertionFailure(assertion_record)
        elif action != "截图":
            raise RuntimeError(f"UNSUPPORTED_ACTION: {action}")
    except _AssertionFailure:
        raise
    except Exception as error:
        if (
            action != "打开页面"
            and isinstance(error, Exception)
            and "Timeout" in str(error)
        ):
            raise RuntimeError(
                f"步骤「{action}」超时（{timeout / 1000}s）。当前页面：{page.url}。"
                f"请确认流程已通过「打开页面」步骤打开目标页面，且元素定位与页面内容一致。"
                f"原始错误：{error}"
            ) from error
        raise
    output = _capture_output(page, step, locator)
    if step.get("output") and output is not None:
        outputs[step["output"]] = output
    return assertion_record


def _artifact_name(name: str) -> str:
    return re.sub(r"[^a-zA-Z0-9._-]+", "_", name).strip("._") or "artifact"


def execute_browser_run(
    input: dict[str, Any],
    hooks: dict[str, Any],
) -> dict[str, Any]:
    from playwright.sync_api import sync_playwright

    sensitive = len(input.get("secrets", {})) > 0
    outputs: dict[str, str] = {}
    steps = input.get("flow", {}).get("steps", [])
    if not isinstance(steps, list):
        steps = []
    up_to_step_id = input.get("upToStepId")
    if up_to_step_id:
        index = next(
            (
                index
                for index, step in enumerate(steps)
                if step.get("id") == up_to_step_id
            ),
            -1,
        )
        if index == -1:
            raise RuntimeError("RUN_STEP_NOT_FOUND")
        steps = steps[: index + 1]
    completed_steps = 0
    tracing_started = False
    started = time.time()
    assertions: list[dict[str, Any]] = []
    browser = None
    context = None
    try:
        with sync_playwright() as playwright:
            environment = input.get("environment", {})
            headless = environment.get("headless")
            if headless is None:
                headless = os.environ.get("MANAGED_RUNNER_HEADLESS", "1") != "0"
            browser = playwright.chromium.launch(headless=bool(headless))
            context = browser.new_context(locale="zh-CN")
            hooks["browser"](browser, context)
            page = context.new_page()
            if not sensitive:
                context.tracing.start(screenshots=True, snapshots=True)
                tracing_started = True
            else:
                hooks["event"](
                    "run.security", {"message": "Sensitive run disabled screenshots and Trace"}
                )
            for index, step in enumerate(steps):
                if hooks.get("signal") and hooks["signal"].is_set():
                    raise RuntimeError("RUN_CANCELED")
                step_started = time.time()
                hooks["event"](
                    "step.started",
                    {"index": index, "stepId": step.get("id"), "title": step.get("title")},
                )
                attempts = 2 if step.get("failurePolicy") == "重试 1 次" else 1
                failure: Exception | None = None
                assertion_record: dict[str, Any] | None = None
                for attempt in range(1, attempts + 1):
                    try:
                        if step.get("action") == "截图":
                            if not sensitive:
                                path = hooks["artifact_path"](
                                    _artifact_name(str(step.get("title", "screenshot"))),
                                    "png",
                                )
                                page.screenshot(path=path, full_page=True)
                                hooks["artifact"](
                                    {
                                        "name": f"{step.get('title')}.png",
                                        "contentType": "image/png",
                                        "path": path,
                                    }
                                )
                        else:
                            step_result = _execute_step(
                                page, step, input, outputs, hooks, index
                            )
                            if isinstance(step_result, dict):
                                assertion_record = step_result
                        failure = None
                        break
                    except _AssertionFailure as error:
                        assertion_record = error.record
                        failure = error
                        if attempt < attempts:
                            hooks["event"](
                                "step.retrying",
                                {"index": index, "stepId": step.get("id"), "attempt": attempt},
                            )
                    except Exception as error:
                        failure = error
                        if attempt < attempts:
                            hooks["event"](
                                "step.retrying",
                                {"index": index, "stepId": step.get("id"), "attempt": attempt},
                            )
                if failure:
                    error_text = str(failure)
                    if not sensitive:
                        path = hooks["artifact_path"](f"failure-step-{index + 1}", "png")
                        try:
                            page.screenshot(path=path, full_page=True)
                            hooks["artifact"](
                                {
                                    "name": f"failure-step-{index + 1}.png",
                                    "contentType": "image/png",
                                    "path": path,
                                }
                            )
                        except Exception:
                            pass
                    hooks["event"](
                        "step.failed",
                        {
                            "index": index,
                            "stepId": step.get("id"),
                            "title": step.get("title"),
                            "error": error_text,
                            "durationMs": int((time.time() - step_started) * 1000),
                        },
                    )
                    if assertion_record is not None:
                        assertions.append(assertion_record)
                    if step.get("failurePolicy") != "继续执行":
                        raise failure
                else:
                    completed_steps += 1
                    step_duration_ms = int((time.time() - step_started) * 1000)
                    event_data = {
                        "index": index,
                        "stepId": step.get("id"),
                        "title": step.get("title"),
                        "message": f"{step.get('title') or 'Step'} completed",
                        "durationMs": step_duration_ms,
                    }
                    hooks["event"]("step.completed", event_data)
                    # 兼容：同时写旧事件名「step.succeeded」，以便历史代码路径和外部工具在过渡期读取。
                    hooks["event"]("step.succeeded", event_data)
                    if assertion_record is not None:
                        assertions.append(assertion_record)
            if context and not sensitive:
                path = hooks["artifact_path"]("trace", "zip")
                context.tracing.stop(path=path)
                tracing_started = False
                hooks["artifact"](
                    {
                        "name": "trace.zip",
                        "contentType": "application/zip",
                        "path": path,
                    }
                )
            return {
                "status": "success",
                "completedSteps": completed_steps,
                "totalSteps": len(steps),
                "elapsedMs": int((time.time() - started) * 1000),
                "flowOutputs": outputs,
                "assertions": assertions,
            }
    except Exception as error:
        canceled = bool(
            hooks.get("signal") and hooks["signal"].is_set()
        ) or str(error) == "RUN_CANCELED"
        return {
            "status": "canceled" if canceled else "failed",
            "completedSteps": completed_steps,
            "totalSteps": len(steps),
            "elapsedMs": int((time.time() - started) * 1000),
            "error": "RUN_CANCELED" if canceled else str(error),
            "flowOutputs": outputs,
            "assertions": assertions,
        }
    finally:
        hooks["browser"](None, None)
        if context and tracing_started:
            try:
                path = hooks["artifact_path"]("trace", "zip")
                context.tracing.stop(path=path)
                hooks["artifact"](
                    {
                        "name": "trace.zip",
                        "contentType": "application/zip",
                        "path": path,
                    }
                )
            except Exception:
                pass
        if context is not None:
            try:
                context.close()
            except Exception:
                pass
        if browser is not None:
            try:
                browser.close()
            except Exception:
                pass


def _element_validation_login_error(
    element: dict[str, Any],
    login_detected: bool,
    storage_state: dict[str, Any] | None,
) -> str | None:
    """Return a stable error code when validation landed on a login wall.

    Validation opens the target page with the recorder's storage snapshot when
    one is available. If the page still shows a login wall the element lives
    behind authentication: a stale/absent session should produce a precise,
    actionable code instead of a silent "missed". Elements whose own path is a
    login page (e.g. the login button) are excluded to avoid false positives.
    """
    if not login_detected:
        return None
    element_path = str(element.get("path") or "")
    if re.search(r"login|log-in|signin|sign-in|auth|account", element_path, re.I):
        return None
    if storage_state:
        return "ELEMENT_VALIDATION_LOGIN_INVALID"
    return "ELEMENT_VALIDATION_LOGIN_REQUIRED"


def execute_element_validation(
    input: dict[str, Any],
    hooks: dict[str, Any],
) -> dict[str, Any]:
    from playwright.sync_api import sync_playwright

    environment = input.get("environment", {})
    element = input.get("element", {})
    started = time.time()
    browser = None
    context = None
    try:
        with sync_playwright() as playwright:
            headless = environment.get("headless")
            if headless is None:
                headless = os.environ.get("MANAGED_RUNNER_HEADLESS", "1") != "0"
            browser = playwright.chromium.launch(headless=bool(headless))
            context = browser.new_context(
                locale="zh-CN",
                storage_state=input.get("storage_state"),
            )
            hooks["browser"](browser, context)
            page = context.new_page()
            page.goto(
                _target_url(
                    str(environment.get("baseUrl", "")),
                    str(element.get("path") or "/"),
                ),
                wait_until=_NAVIGATE_WAIT_UNTIL,
                timeout=_navigate_timeout_ms(environment),
            )
            login_detected = page.evaluate(
                """
                () => /(login|signin|sign-in|log-in)/i.test(location.pathname)
                    || !!document.querySelector('input[type=password]')
                """
            )
            login_error = _element_validation_login_error(
                element,
                login_detected,
                input.get("storage_state"),
            )
            if login_error:
                raise RuntimeError(login_error)
            if hooks.get("signal") and hooks["signal"].is_set():
                raise RuntimeError("RUN_CANCELED")
            locator = _locator_for(
                page,
                element,
                str(environment.get("testIdAttribute", "data-testid")),
            )
            count = 0
            try:
                locator.first.wait_for(state="attached", timeout=15000)
                count = locator.count()
            except Exception:
                count = 0
            first_match = None
            if count > 0:
                try:
                    first_match = locator.first.evaluate(
                        "node => node.outerHTML.slice(0, 1000)"
                    )
                except Exception:
                    first_match = None
            path = hooks["artifact_path"]("element-validation", "png")
            page.screenshot(path=path, full_page=True)
            hooks["artifact"](
                {
                    "name": "element-validation.png",
                    "contentType": "image/png",
                    "path": path,
                }
            )
            return {
                "status": "success",
                "count": count,
                "firstMatch": first_match,
                "elapsedMs": int((time.time() - started) * 1000),
            }
    except Exception as error:
        canceled = bool(
            hooks.get("signal") and hooks["signal"].is_set()
        ) or str(error) == "RUN_CANCELED"
        return {
            "status": "canceled" if canceled else "failed",
            "count": 0,
            "elapsedMs": int((time.time() - started) * 1000),
            "error": "VALIDATION_CANCELED" if canceled else str(error),
        }
    finally:
        hooks["browser"](None, None)
        if context is not None:
            try:
                context.close()
            except Exception:
                pass
        if browser is not None:
            try:
                browser.close()
            except Exception:
                pass
