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
from autoflow.managed_runner import ManagedRunner
from autoflow.core import now
from autoflow.services import AuthUser, PlatformServices

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
            page.get_by_test_id("recording-help-label").click()
            page.get_by_test_id("login-submit-icon").click()
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
    assert values[7] == "订单"
    assert values[8] == "Enter"
    assert values[10] == "录制后仍可输入"
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
    assert elements_by_name["recording-help"]["method"] == "testid"
    assert elements_by_name["recording-help"]["value"] == "recording-help"
    assert elements_by_name["login-submit"]["method"] == "testid"
    assert elements_by_name["login-submit"]["value"] == "login-submit"
    assert result["steps"][5]["element"] == "recording-help"
    assert result["steps"][6]["element"] == "login-submit"

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
    completed = threading.Event()
    result_holder: list[dict] = []
    managed_runner = ManagedRunner(tmp_path / "managed-artifacts")
    try:
        # This is the same immutable flow/environment/elements shape persisted
        # by a published revision. Exercise the production ManagedRunner queue,
        # rather than calling the runner core directly.
        managed_runner.enqueue(
            "saved-recording-run",
            replay_input,
            {
                "started": lambda: None,
                "event": lambda kind, data: events.append((kind, data)),
                "artifact": lambda payload: None,
                "completed": lambda result: (result_holder.append(result), completed.set()),
            },
        )
        assert completed.wait(20), "ManagedRunner did not complete the saved recording replay"
    finally:
        managed_runner.stop()

    assert result_holder
    replay_result = result_holder[0]
    assert replay_result["status"] == "success", replay_result
    assert replay_result["completedSteps"] == len(replay_steps)
    assert replay_result["totalSteps"] == len(replay_steps)


def test_saved_recording_revision_replays_through_platform_managed_runner(fixture_server, tmp_path):
    services = PlatformServices(str(tmp_path / "platform-data"))
    user = AuthUser("recording-owner", "recording-owner@example.test", "Recording Owner")
    project_id = "recording-project"
    timestamp = now()
    services.database.execute(
        "INSERT INTO platform_users (id, email, name, created_at) VALUES (?, ?, ?, ?)",
        (user.id, user.email, user.name, timestamp),
    )
    workspace = services.create_workspace(user, "Recording replay workspace")
    services.database.execute(
        """
        INSERT INTO platform_projects (
          id, workspace_id, slug, name, description, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (project_id, workspace["id"], project_id, "Recording project", "", timestamp, timestamp),
    )
    environment = {
        "id": "recording-env",
        "name": "Recording fixture",
        "baseUrl": fixture_server,
        "browser": "Chromium",
        "headless": True,
        "testIdAttribute": "data-testid",
    }
    flow = {
        "id": "recorded-flow",
        "name": "Saved recording",
        "steps": [
            {"id": "open", "title": "Open", "action": "打开页面", "value": "/page1.html", "timeout": 10, "failurePolicy": "立即失败"},
            {"id": "username", "title": "Fill username", "action": "填写", "element": "用户名", "value": "tester", "timeout": 10, "failurePolicy": "立即失败"},
            {"id": "submit", "title": "Submit", "action": "点击", "element": "登录", "value": "", "timeout": 10, "failurePolicy": "立即失败"},
        ],
        "secretNames": [],
    }
    elements = [
        {"id": "recorded-user", "name": "用户名", "path": "/page1.html", "method": "testid", "value": "login-username", "environment": environment["id"]},
        {"id": "recorded-submit", "name": "登录", "path": "/page1.html", "method": "testid", "value": "login-submit", "environment": environment["id"]},
    ]
    services.database.execute(
        """
        INSERT INTO flow_revisions (
          id, project_id, flow_id, flow_name, environment_id,
          revision_number, status, flow_snapshot, environment_snapshot,
          element_snapshot, dataset_snapshot, checksum, created_by,
          created_at, published_at
        ) VALUES (?, ?, ?, ?, ?, 1, 'published', ?, ?, ?, 'null', ?, ?, ?, ?)
        """,
        (
            "recorded-revision",
            project_id,
            flow["id"],
            flow["name"],
            environment["id"],
            json.dumps(flow),
            json.dumps(environment),
            json.dumps(elements),
            "recorded-revision-checksum",
            user.id,
            timestamp,
            timestamp,
        ),
    )
    try:
        queued = services.queue_published_runs({
            "projectId": project_id,
            "flowId": flow["id"],
            "environmentId": environment["id"],
            "createdBy": user.id,
            "source": "manual",
        })
        assert len(queued["runIds"]) == 1
        run_id = queued["runIds"][0]
        deadline = time.time() + 20
        while time.time() < deadline:
            run = services.run_by_id(run_id)
            if run["status"] in {"success", "failed", "canceled"}:
                break
            time.sleep(0.1)
        run = services.run_by_id(run_id)
        assert run["status"] == "success", run
        assert run["result"]["completedSteps"] == 3
        assert run["result"]["totalSteps"] == 3
        event_kinds = [row[0] for row in services.database.execute(
            "SELECT kind FROM platform_run_events WHERE run_id = ? ORDER BY id", (run_id,)
        ).fetchall()]
        assert "run.complete" in event_kinds
    finally:
        services.close()
