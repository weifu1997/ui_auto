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
    timeout = max(1, int(environment.get("timeout", 30))) * 1000
    page.goto(
        _target_url(base_url, path),
        wait_until="domcontentloaded",
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
) -> None:
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
    try:
        action = step.get("action")
        if action == "打开页面":
            page.goto(
                _target_url(str(input.get("environment", {}).get("baseUrl", "")), value),
                wait_until="domcontentloaded",
                timeout=timeout,
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
        elif action == "可见性断言":
            _required(locator).wait_for(state="visible", timeout=timeout)
        elif action == "文本断言":
            actual = _required(locator).text_content(timeout=timeout) or ""
            if value not in actual:
                raise RuntimeError(
                    f"TEXT_ASSERTION_FAILED: expected {value}, received {actual}"
                )
        elif action != "截图":
            raise RuntimeError(f"UNSUPPORTED_ACTION: {action}")
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
                            _execute_step(page, step, input, outputs, hooks)
                        failure = None
                        break
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
                    if step.get("failurePolicy") != "继续执行":
                        raise failure
                else:
                    completed_steps += 1
                    hooks["event"](
                        "step.succeeded",
                        {
                            "index": index,
                            "stepId": step.get("id"),
                            "title": step.get("title"),
                            "durationMs": int((time.time() - step_started) * 1000),
                        },
                    )
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
                wait_until="domcontentloaded",
                timeout=30000,
            )
            if input.get("requiresLogin"):
                login_detected = page.evaluate(
                    """
                    () => /(login|signin|sign-in|auth|account)/i.test(location.pathname)
                        || !!document.querySelector('input[type=password]')
                    """
                )
                if login_detected:
                    raise RuntimeError("LOGIN_SESSION_INVALID")
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
