"""Playwright execution core matching server/runner-core.ts."""

from __future__ import annotations

import json
import os
import re
import time
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.parse import urljoin, urlparse

from .assertion_contract import (
    ASSERT_MATCHES,
    ASSERT_OPERATORS,
    ASSERTION_TYPES,
    ASSERT_VISIBILITIES,
)
from .locator_score import HeuristicLocatorScorer, LocatorScorer


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

# 需要元素定位的动作：D5 自愈仅对这些动作的定位失败做备用定位器回退，
# 不碰导航/等待/键盘/断言等无需元素定位的路径。
_ELEMENT_ACTIONS = frozenset({"点击", "填写", "清空填写", "选择下拉项", "勾选"})

# 默认启发式评分器（无外部依赖）；未来可选 LLM 实现替换该模块级引用。
_DEFAULT_LOCATOR_SCORER: LocatorScorer = HeuristicLocatorScorer()


def _navigate_timeout_ms(environment_or_step: dict[str, Any], default_seconds: int = 30) -> int:
    """根据环境/步骤的 timeout 字段计算导航超时，并用合理下限兜底。"""
    return max(_NAVIGATE_TIMEOUT_FLOOR_MS, max(1, int(environment_or_step.get("timeout", default_seconds))) * 1000)


def _wait_step_cap_ms() -> int:
    """W1-5：「等待」步骤的硬上限（毫秒）。

    保证任何单个步骤时长有界，从而"取消最坏延迟 = 当前步骤上限"成立。
    环境变量 WAIT_STEP_MAX_MS 可调，默认 10 分钟，下限 1 秒。
    """
    raw = os.environ.get("WAIT_STEP_MAX_MS", "600000")
    try:
        value = int(raw)
    except ValueError:
        value = 600_000
    return max(1_000, value)


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
    on_locator_fallback: Any = None,
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
        # W0-2 兜底：优先全字符串匹配（Playwright 对参数做空白归一化）；
        # 页面上没有完全等值文本时（典型是旧数据里被截断的 60 字符标签）
        # 自动降级为子串匹配，保证"录了能放"，并通过回调暴露可观测事件。
        exact_locator = page.get_by_text(value, exact=True)
        try:
            if exact_locator.count() > 0:
                return exact_locator
        except Exception:
            pass
        if on_locator_fallback is not None:
            on_locator_fallback(value)
        return page.get_by_text(value, exact=False)
    if method == "role":
        match = re.match(r"^([\w-]+)(?:\[name=['\"]?(.*?)['\"]?\])?$", value)
        role = match.group(1) if match else value
        name = match.group(2) if match and match.group(2) else None
        return page.get_by_role(role, name=name)
    if method == "XPath":
        return page.locator(f"xpath={value}")
    return page.locator(value)


# D5 定位器自愈：由原定位确定性派生候选备用定位器，交由评分器以 count()===1
# 唯一性把关后回退。候选规格统一为 ``(kind, value, name)``，由
# ``_locator_from_spec`` 构建真实 Playwright 定位器。
_TEXT_ROLES = ("button", "link", "heading", "checkbox", "radio", "textbox", "option")


def _fallback_candidates(element: dict[str, Any]) -> list[tuple[str, str, str | None]]:
    """由原定位派生候选备用定位器（确定性、有界）。

    dom-to-locator 风格：对原定位做「退化 / 换技术」变换。CSS/XPath 的结构
    漂移无可派生信息，返回空；其余技术给出少量候选，最终采纳仍由评分器以
    ``count()===1`` 把关。
    """
    method = element.get("method")
    value = str(element.get("value", ""))
    if not value:
        return []
    if method == "text":
        # W0-2 已把 exact→substring 作为主定位；D5 追加：按常见 role 用可访问名
        # 匹配——按钮/链接的可访问名通常等于其文本，即使 DOM 文本漂移也能唯一命中。
        return [("role", role, value) for role in _TEXT_ROLES]
    if method == "testid":
        # 属性子串匹配：录制 testid 前后缀漂移（login-submit → login-submit-mobile）。
        return [("testidPartial", value, None)]
    if method == "label":
        return [("label", value, None)]
    if method == "role":
        parsed = re.match(r"^([\w-]+)(?:\[name=['\"]?(.*?)['\"]?\])?$", value)
        if not parsed:
            return []
        role = parsed.group(1)
        name = parsed.group(2) or None
        # Keep the accessible name when the original locator had one. Dropping
        # it can click the only button on the page instead of the named control.
        return [("role", role, name)]
    return []


# 候选技术 → 评分权重使用的「基础技术名」（testidPartial 按 testid 权重）。
_SCORE_METHOD: dict[str, str] = {
    "testid": "testid",
    "testidPartial": "testid",
    "role": "role",
    "label": "label",
    "text": "text",
}


def _locator_from_spec(
    page: Any,
    kind: str,
    value: str,
    test_id_attribute: str,
    name: str | None = None,
) -> Any:
    """按候选规格构建 Playwright 定位器，并标注来源技术供评分器取稳定性权重。"""
    if kind == "role":
        locator = (
            page.get_by_role(value, name=name)
            if name
            else page.get_by_role(value)
        )
    elif kind == "testid":
        locator = page.locator(f"[{test_id_attribute}={json.dumps(value)}]")
    elif kind == "testidPartial":
        locator = page.locator(f"[{test_id_attribute}*={json.dumps(value)}]")
    elif kind == "label":
        locator = page.get_by_label(value, exact=False)
    elif kind == "text":
        locator = page.get_by_text(value, exact=False)
    else:
        locator = page.locator(value)
    try:
        locator._autoflow_method = _SCORE_METHOD.get(kind, kind)  # type: ignore[attr-defined]
    except Exception:
        pass
    return locator


def _heal_locator(
    page: Any,
    element: dict[str, Any],
    test_id_attribute: str,
    scorer: LocatorScorer,
) -> tuple[Any, str, str] | None:
    """生成候选备用定位器，启发式评分后返回唯一命中的最佳者。

    返回 ``(locator, method, value)``；无候选或候选都不唯一命中时返回 None。
    评分实现（``HeuristicLocatorScorer``）自行吸收 ``count()`` 异常，候选
    生成与打分都只读不写，失败即视为不可用。
    """
    best: tuple[Any, str, str] | None = None
    best_score = float("-inf")
    for kind, value, name in _fallback_candidates(element):
        candidate = _locator_from_spec(page, kind, value, test_id_attribute, name)
        score = scorer.score(candidate, page)
        if score > best_score:
            best_score = score
            best = (candidate, kind, value)
    return best


def _should_heal_locator(locator: Any, error: BaseException) -> bool:
    """Heal only when the original locator missed, not when it found a node.

    Covered/disabled/animating nodes time out with count()>=1; swapping in a
    different unique locator would mis-click. Strict-mode ambiguity is treated
    as a miss so a unique fallback can still be tried.
    """
    if locator is None:
        return True
    try:
        count = locator.count()
    except Exception:
        return True
    if count == 0:
        return True
    return "strict mode" in str(error).lower()


def _run_element_action(action: str, locator: Any, value: str, timeout: int) -> None:
    """执行需要元素定位的动作（点击/填写/清空填写/选择下拉项/勾选）。

    Playwright 的自动等待保证动作要么完成要么超时（超时不产生副作用），
    因此 D5 自愈在失败后以备用定位器重试一次是安全的。
    """
    if action == "点击":
        _required(locator).click(timeout=timeout)
    elif action == "填写":
        _required(locator).fill(value, timeout=timeout)
    elif action == "清空填写":
        _required(locator).fill("", timeout=timeout)
    elif action == "选择下拉项":
        _required(locator).select_option(value, timeout=timeout)
    elif action == "勾选":
        _required(locator).check(timeout=timeout)


def _required(locator: Any) -> Any:
    if locator is None:
        raise RuntimeError("STEP_ELEMENT_REQUIRED")
    return locator


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
    if expected not in ASSERT_VISIBILITIES:
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


def _compare_normalize(value: str) -> str:
    """W2-5：trimCompare 默认开启时的比较归一化（首尾空白 + 连续空白折叠）。"""
    return " ".join(value.split())


def _assert_text(
    locator: Any,
    page: Any,
    step: dict[str, Any],
    timeout_ms: int,
    value: str,
) -> tuple[bool, str, str]:
    """文本断言：元素文本按匹配方式命中期望值（exact/contains，缺省 contains）。

    trimCompare 未显式设为 false 时（默认开），比较前对实际/期望文本做
    空白归一化——录制采集折叠空白的历史产物与含换行的真实 text_content
    才能互相匹配；期望值保留原样参与报告展示。
    """
    match = step.get("assertMatch")
    if match not in ASSERT_MATCHES:
        match = "contains"
    expected = value
    if locator is None:
        raise RuntimeError("STEP_ELEMENT_REQUIRED")
    try:
        actual = locator.text_content(timeout=timeout_ms) or ""
    except Exception:
        return False, expected, "not-found"
    compare_expected, compare_actual = expected, actual
    if step.get("trimCompare") is not False:
        compare_expected = _compare_normalize(expected)
        compare_actual = _compare_normalize(actual)
    passed = (
        compare_actual == compare_expected
        if match == "exact"
        else compare_expected in compare_actual
    )
    # 报告记录归一化后的 actual：失败时用户看到的差异即判定所用差异。
    return passed, expected, compare_actual


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
    if operator not in ASSERT_OPERATORS:
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
    if match not in ASSERT_MATCHES:
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


def _url_matches(actual: str, expected: str, match: str) -> bool:
    return actual == expected if match == "exact" else expected in actual


def _assert_url(
    page: Any,
    step: dict[str, Any],
    timeout_ms: int,
    value: str,
) -> tuple[bool, str, str]:
    """URL 断言：当前页面 URL 按匹配方式命中期望值（exact/contains，缺省 contains）。

    页面级断言（R3-1）：不读 locator——URL 断言步骤不引用元素，也不落
    STEP_ELEMENT_REQUIRED；无 trimCompare 语义（URL 不做空白折叠归一化）。
    有 ``wait_for_url`` 时等到命中或超时（覆盖 SPA/延迟跳转）；页面取 URL
    异常（如已关闭）时按「不可用」判定，不抛非预期异常。
    """
    match = step.get("assertMatch")
    if match not in ASSERT_MATCHES:
        match = "contains"
    expected = value
    waiter = getattr(page, "wait_for_url", None)
    if callable(waiter):
        try:
            waiter(
                lambda url: _url_matches(str(url), expected, match),
                timeout=max(1, int(timeout_ms)),
            )
            return True, expected, str(page.url)
        except Exception:
            pass
    try:
        actual = str(page.url)
    except Exception:
        return False, expected, "not-available"
    return _url_matches(actual, expected, match), expected, actual


def _run_assertion(
    locator: Any,
    page: Any,
    step: dict[str, Any],
    timeout_ms: int,
    value: str,
) -> dict[str, Any]:
    """按动作分发到断言判定，返回结构化判定 {type, passed, expected, actual}。

    W2-5：未知断言动作显式报 UNSUPPORTED_ACTION，不再静默落属性断言。
    """
    action = step.get("action")
    if action not in ASSERTION_TYPES:
        raise RuntimeError(f"UNSUPPORTED_ACTION: {action}")
    if action == "可见性断言":
        passed, expected, actual = _assert_visibility(locator, page, step, timeout_ms, value)
    elif action == "文本断言":
        passed, expected, actual = _assert_text(locator, page, step, timeout_ms, value)
    elif action == "数量断言":
        passed, expected, actual = _assert_count(locator, page, step, timeout_ms, value)
    elif action == "URL 断言":
        passed, expected, actual = _assert_url(page, step, timeout_ms, value)
    else:  # 属性断言（且仅属性断言会走到这里）
        passed, expected, actual = _assert_attribute(locator, page, step, timeout_ms, value)
    return {
        "type": ASSERTION_TYPES[action],
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
    def _emit_locator_fallback(raw_value: str) -> None:
        # W0-2 可观测性：text 定位从 exact 降级为子串匹配时打点。
        hooks["event"](
            "step.locatorFallback",
            {
                "index": index,
                "stepId": step.get("id"),
                "title": step.get("title"),
                "method": "text",
                "value": str(raw_value)[:200],
            },
        )

    locator = (
        _locator_for(
            page,
            element,
            str(input.get("environment", {}).get("testIdAttribute", "data-testid")),
            on_locator_fallback=_emit_locator_fallback,
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
        elif action in _ELEMENT_ACTIONS:
            _run_element_action(action, locator, value, timeout)
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
            cap = _wait_step_cap_ms()
            if wait_ms > cap:
                hooks["event"](
                    "step.waitCapped",
                    {
                        "index": index,
                        "stepId": step.get("id"),
                        "requestedMs": wait_ms,
                        "cappedMs": cap,
                        "message": f"等待时长被上限截断：{cap}ms",
                    },
                )
                wait_ms = cap
            page.wait_for_timeout(wait_ms)
        elif action in ASSERTION_TYPES:
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
        # D5 自愈：元素级动作定位失败时，生成候选备用定位器回退重试一次。
        # 仅在唯一命中（count()===1）时采纳，防止误点/误填；备用定位器仍失败
        # 则回到原有超时/错误处理。回退事件恒在 step.completed/step.failed 之前。
        healed: tuple[Any, str, str] | None = None
        if (
            action in _ELEMENT_ACTIONS
            and element is not None
            and _should_heal_locator(locator, error)
        ):
            healed = _heal_locator(
                page,
                element,
                str(input.get("environment", {}).get("testIdAttribute", "data-testid")),
                _DEFAULT_LOCATOR_SCORER,
            )
        if healed is not None:
            healed_locator, healed_method, healed_value = healed
            hooks["event"](
                "step.locatorFallback",
                {
                    "index": index,
                    "stepId": step.get("id"),
                    "title": step.get("title"),
                    "method": healed_method,
                    "value": str(healed_value)[:200],
                    "reason": f"{type(error).__name__}: {error}"[:200],
                },
            )
            try:
                _run_element_action(action, healed_locator, value, timeout)
            except Exception:
                healed = None  # 备用定位器仍失败 → 以原错误继续处理
            else:
                locator = healed_locator  # 输出捕获等后续逻辑用自愈后的定位器
        if healed is None:
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


def _close_quietly(call: Callable[[], None]) -> None:
    """Close a Playwright resource, ignoring cleanup-only errors."""
    try:
        call()
    except Exception:
        pass


def _is_canceled(hooks: dict[str, Any], error: BaseException) -> bool:
    """共享取消判定：signal 已置位或错误即 RUN_CANCELED。"""
    return bool(hooks.get("signal") and hooks["signal"].is_set()) or str(
        error
    ) == "RUN_CANCELED"


class _BrowserSession:
    """统一 Playwright 浏览器启停（阶段2-B：runner.py 抽公共启停）。

    启动：``sync_playwright`` + ``chromium.launch``（headless 缺省取环境变量
    ``MANAGED_RUNNER_HEADLESS``）+ ``new_context(locale="zh-CN"[, storage_state])``，
    并把 ``(browser, context)`` 注册到 ``hooks["browser"]``（ManagedRunner 取消时
    据此关浏览器）。退出：先 ``hooks["browser"](None, None)`` 清理引用，再安全关闭
    context/browser 与 playwright。

    Trace 归调用方负责（须在 ``__exit__`` 前停止，保证 context 仍打开）。
    """

    def __init__(
        self,
        hooks: dict[str, Any],
        environment: dict[str, Any] | None = None,
        *,
        storage_state: dict[str, Any] | None = None,
    ) -> None:
        self._hooks = hooks
        self._environment = environment or {}
        self._storage_state = storage_state
        self._playwright_cm: Any = None
        self.browser: Any = None
        self.context: Any = None

    def __enter__(self) -> Any:
        from playwright.sync_api import sync_playwright

        self._playwright_cm = sync_playwright()
        playwright = self._playwright_cm.__enter__()
        try:
            environment = self._environment
            headless = environment.get("headless")
            if headless is None:
                headless = os.environ.get("MANAGED_RUNNER_HEADLESS", "1") != "0"
            self.browser = playwright.chromium.launch(headless=bool(headless))
            context_kwargs: dict[str, Any] = {"locale": "zh-CN"}
            if self._storage_state is not None:
                context_kwargs["storage_state"] = self._storage_state
            self.context = self.browser.new_context(**context_kwargs)
        except BaseException:
            # 启动中途失败时释放 playwright driver，等价原 `with sync_playwright()` 的清理。
            try:
                self._playwright_cm.__exit__(None, None, None)
            except Exception:
                pass
            raise
        self._hooks["browser"](self.browser, self.context)
        return self.context

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> bool:
        self._hooks["browser"](None, None)
        if self.context is not None:
            _close_quietly(self.context.close)
        if self.browser is not None:
            _close_quietly(self.browser.close)
        if self._playwright_cm is not None:
            # 与原 `with sync_playwright()` 一致：driver 停止失败向上传播。
            self._playwright_cm.__exit__(exc_type, exc, tb)
        return False


def execute_browser_run(
    input: dict[str, Any],
    hooks: dict[str, Any],
) -> dict[str, Any]:
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
    try:
        with _BrowserSession(hooks, input.get("environment", {})) as context:
            page = context.new_page()
            if not sensitive:
                context.tracing.start(screenshots=True, snapshots=True)
                tracing_started = True
            else:
                hooks["event"](
                    "run.security", {"message": "Sensitive run disabled screenshots and Trace"}
                )
            try:
                for index, step in enumerate(steps):
                    if hooks.get("signal") and hooks["signal"].is_set():
                        raise RuntimeError("RUN_CANCELED")
                    # W0-4 心跳：每步开始即上报进度，watchdog 依据其新鲜度判定，
                    # 长跑但健康的 run 不再因 updated_at 停滞被误杀。
                    progress = hooks.get("progress")
                    if callable(progress):
                        progress(index)
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
            finally:
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
    except Exception as error:
        canceled = _is_canceled(hooks, error)
        return {
            "status": "canceled" if canceled else "failed",
            "completedSteps": completed_steps,
            "totalSteps": len(steps),
            "elapsedMs": int((time.time() - started) * 1000),
            "error": "RUN_CANCELED" if canceled else str(error),
            "flowOutputs": outputs,
            "assertions": assertions,
        }


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
    environment = input.get("environment", {})
    element = input.get("element", {})
    started = time.time()
    try:
        with _BrowserSession(
            hooks,
            environment,
            storage_state=input.get("storage_state"),
        ) as context:
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
        canceled = _is_canceled(hooks, error)
        return {
            "status": "canceled" if canceled else "failed",
            "count": 0,
            "elapsedMs": int((time.time() - started) * 1000),
            "error": "VALIDATION_CANCELED" if canceled else str(error),
        }
