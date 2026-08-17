"""Recording Phase 0 PoC: capture -> normalize -> replay -> sensitive safety."""

import json
import threading
import time
from functools import partial
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

import pytest

from autoflow.recorder import (
    RECORDER_INIT_SCRIPT,
    RecorderNormalizer,
    sanitize_url,
)
from autoflow.runner import execute_browser_run

FIXTURES = Path(__file__).parent.parent / "fixtures" / "recorder"
PASSWORD = "Sup3rSecretValue!42"


@pytest.fixture(scope="module")
def fixture_server():
    handler = partial(SimpleHTTPRequestHandler, directory=str(FIXTURES))
    server = HTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


def test_normalizer_pure_merge_causality_and_sensitive():
    normalizer = RecorderNormalizer("https://app.test/login")
    element = {
        "tag": "input",
        "type": "text",
        "name": "username",
        "id": "user",
        "label": "用户名",
        "role": "textbox",
        "accessibleName": "用户名",
        "testid": "login-username",
        "text": "",
        "css": "input#user",
    }
    for value in ("t", "te", "tes", "tester"):
        normalizer.append({"kind": "input", "element": element, "value": value, "at": 100})
    normalizer.append({"kind": "change", "element": element, "value": "tester", "at": 150})
    password_element = {
        **element,
        "name": "password",
        "type": "password",
        "label": "密码",
        "testid": "login-password",
        "id": "pwd",
    }
    normalizer.append({"kind": "input", "element": password_element, "value": None, "sensitive": True, "at": 200})
    button = {"tag": "button", "type": "button", "label": "登录", "role": "button",
              "accessibleName": "登录", "testid": "login-submit", "text": "登录", "css": "button#s"}
    normalizer.append({"kind": "click", "element": button, "at": 300})
    normalizer.note_navigation("https://app.test/home?token=abc#/x", at=400)
    normalizer.note_navigation("https://app.test/list", at=10_000)
    normalizer.append({"kind": "keydown", "key": "Enter", "element": None, "at": 10_050})

    result = normalizer.result()
    actions = [(step["action"], step.get("value")) for step in result["steps"]]
    assert actions == [
        ("打开页面", "/login"),
        ("填写", "tester"),
        ("填写", None),
        ("点击", None),
        ("打开页面", "/list"),
        ("键盘按键", "Enter"),
    ]
    assert [step["id"] for step in result["steps"]] == [
        f"rec-{index}" for index in range(1, len(actions) + 1)
    ]
    sensitive_steps = [
        step for step in result["steps"]
        if step["action"] == "填写" and step.get("value") is None
    ]
    assert len(sensitive_steps) == 1
    assert result["requiredBindings"] == [
        {"stepId": sensitive_steps[0]["id"], "fieldHint": "password"}
    ]
    assert {element["name"] for element in result["elements"]} >= {"用户名", "登录"}
    username = next(e for e in result["elements"] if e["name"] == "用户名")
    assert username["method"] == "testid" and username["value"] == "login-username"


def test_normalizer_suppresses_select_click_and_flags_iframe():
    normalizer = RecorderNormalizer("https://app.test/form")
    select = {"tag": "select", "type": "", "name": "role", "label": "角色",
              "role": "combobox", "accessibleName": "角色", "testid": "login-role",
              "text": "", "css": "select"}
    normalizer.append({"kind": "click", "element": select, "at": 100})
    normalizer.append({"kind": "change", "element": select, "selectedValue": "tester", "at": 200})
    checkbox = {"tag": "input", "type": "checkbox", "name": "remember", "label": "记住我",
                "role": "checkbox", "accessibleName": "记住我", "testid": "login-remember",
                "text": "", "css": "input[type=checkbox]"}
    normalizer.append({"kind": "click", "element": checkbox, "at": 300})
    normalizer.append({"kind": "change", "element": checkbox, "checked": True, "at": 320})
    normalizer.append({"kind": "click", "frame": "child", "element": checkbox, "at": 400})

    result = normalizer.result()
    assert [(step["action"], step.get("value")) for step in result["steps"]] == [
        ("打开页面", "/form"),
        ("选择下拉项", "tester"),
        ("勾选", None),
    ]
    assert any("iframe" in warning for warning in result["warnings"])


def test_capture_normalize_replay_and_sensitive_never_leaves_page(fixture_server, tmp_path):
    from playwright.sync_api import sync_playwright

    start_url = f"{fixture_server}/page1.html"
    normalizer = RecorderNormalizer(start_url)
    raw_payloads: list[dict] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            context = browser.new_context(locale="zh-CN")
            context.add_init_script(RECORDER_INIT_SCRIPT)

            def on_event(_source, payload):
                raw_payloads.append(payload)
                normalizer.append(payload)
                return None

            context.expose_binding("__autoflowRecorderEvent", on_event)
            page = context.new_page()

            def on_navigated(frame):
                if frame == page.main_frame:
                    normalizer.note_navigation(
                        sanitize_url(frame.url), int(time.time() * 1000)
                    )

            page.on("framenavigated", on_navigated)
            page.goto(start_url, wait_until="domcontentloaded")

            page.get_by_test_id("login-username").click()
            page.get_by_test_id("login-username").type("tester")
            page.get_by_test_id("login-password").type(PASSWORD)
            page.get_by_test_id("login-role").select_option("tester")
            page.get_by_test_id("login-remember").check()
            page.frame_locator("iframe").get_by_test_id("iframe-button").click()
            page.wait_for_timeout(50)
            page.get_by_test_id("login-submit").click()
            page.wait_for_url("**/page2.html", timeout=5_000)

            page.get_by_test_id("search-input").type("订单")
            page.get_by_test_id("search-input").press("Enter")
            page.get_by_test_id("search-go").click()
            page.get_by_test_id("spa-input").type("录制后仍可输入")
            page.wait_for_timeout(100)
        finally:
            browser.close()

    result = normalizer.result()
    actions = [step["action"] for step in result["steps"]]
    assert actions == [
        "打开页面",
        "填写",
        "填写",
        "选择下拉项",
        "勾选",
        "点击",
        "填写",
        "键盘按键",
        "点击",
        "填写",
    ]
    values = {
        index: step.get("value")
        for index, step in enumerate(result["steps"])
    }
    assert values[1] == "tester"
    assert values[2] is None  # 密码：值不进入事件与步骤
    assert values[3] == "tester"
    assert values[6] == "订单"
    assert values[7] == "Enter"
    assert values[9] == "录制后仍可输入"
    assert result["requiredBindings"], "敏感输入必须要求绑定 secret 变量"
    assert any("iframe" in warning for warning in result["warnings"])
    for payload in raw_payloads:
        assert PASSWORD not in json.dumps(payload, ensure_ascii=False), (
            "敏感值不得出现在任何浏览器事件 payload 中"
        )

    elements_by_name = {element["name"]: element for element in result["elements"]}
    assert elements_by_name["用户名"] == {
        "id": "element-rec-1",
        "name": "用户名",
        "path": "/page1.html",
        "method": "testid",
        "value": "login-username",
        "environment": "",
        "description": "",
        "validation": "unverified",
    }

    # 绑定 secret 后重放：验证生成的步骤/元素无需扩展 FlowStep 契约即可被现有 runner 执行。
    replay_steps = []
    for step in result["steps"]:
        replay = {key: value for key, value in step.items()}
        if step["id"] == result["requiredBindings"][0]["stepId"]:
            replay["value"] = "{{secret.password}}"
        replay_steps.append(replay)
    replay_input = {
        "environment": {
            "baseUrl": fixture_server,
            "testIdAttribute": "data-testid",
            "headless": True,
        },
        "flow": {"id": "flow-rec-poc", "name": "录制回放", "steps": replay_steps},
        "elements": result["elements"],
        "variables": {},
        "data": {},
        "secrets": {"password": PASSWORD},
    }
    events: list[tuple[str, dict]] = []
    hooks = {
        "browser": lambda browser, context: None,
        "event": lambda kind, data: events.append((kind, data)),
        "artifact_path": lambda name, extension: str(tmp_path / f"{name}.{extension}"),
        "artifact": lambda payload: None,
    }

    replay_result = execute_browser_run(replay_input, hooks)
    assert replay_result["status"] == "success", replay_result
    assert replay_result["completedSteps"] == len(replay_steps)
    assert replay_result["totalSteps"] == len(replay_steps)
