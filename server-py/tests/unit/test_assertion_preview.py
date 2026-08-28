"""Stage H3: 断言试跑通道（preview channel）单测。

- `upToStepId` 执行到该步（含），之后的步骤不执行；
- 不写 `platform_runs` / `platform_run_events` / artifacts；
- 返回 result 含 `assertions`，且 `step.asserted` 事件恒在 `step.completed` 之前；
- `upToStepId` 不存在时复用既有 `RUN_STEP_NOT_FOUND`；
- 服务端解析项目 secret 注入执行输入，返回载荷统一脱敏。
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from autoflow.http import PlatformError
from autoflow.services import AuthUser, PlatformServices

SECRET = "super-secret-token-123"
FIXTURE_HTML = f"""<!doctype html>
<html lang="zh-CN"><body>
  <div id="status">{SECRET} authenticated</div>
  <div id="count">2 items</div>
</body></html>"""


@pytest.fixture(scope="module")
def fixture_server():
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


def _step(step_id: str, action: str, *, element: str = "", value: str = "", **fields) -> dict:
    return {
        "id": step_id,
        "action": action,
        "title": action,
        "element": element,
        "value": value,
        "timeout": 5,
        "failurePolicy": "继续执行",
        "status": "pending",
        **fields,
    }


def _preview_input(base_url: str, *, up_to_step_id: str | None = None) -> dict:
    steps = [
        _step("s-open", "打开页面", element="", value="/", timeout=30),
        _step(
            "s-assert",
            "文本断言",
            element="status",
            value="authenticated",
            assertMatch="contains",
        ),
        _step("s-count", "数量断言", element="count", value="5", assertOperator="="),
    ]
    elements = [
        {"id": "e-status", "name": "status", "path": "/", "method": "css",
         "value": "#status", "environment": ""},
        {"id": "e-count", "name": "count", "path": "/", "method": "css",
         "value": "#count", "environment": ""},
    ]
    return {
        "environment": {"baseUrl": base_url, "headless": True, "timeout": 30},
        "flow": {"id": "flow-1", "name": "Preview flow", "steps": steps},
        "elements": elements,
        "variables": {},
        "data": {},
        "upToStepId": up_to_step_id,
    }


def _setup_services(tmp_path, monkeypatch):
    monkeypatch.setenv("PLATFORM_SECRET_KEY", "test-key-for-assertion-preview")
    services = PlatformServices(str(tmp_path))
    user = AuthUser("owner-1", "owner@example.test", "Owner")
    services.database.execute(
        """
        INSERT INTO platform_users (id, email, name, created_at)
        VALUES (?, ?, ?, ?)
        """,
        (user.id, user.email, user.name, "2026-08-23T00:00:00.000Z"),
    )
    workspace = services.create_workspace(user, "Preview workspace")
    project_id = "project-1"
    services.database.execute(
        """
        INSERT INTO platform_projects (
          id, workspace_id, slug, name, description, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            project_id,
            workspace["id"],
            project_id,
            "Project",
            "",
            "2026-08-23T00:00:00.000Z",
            "2026-08-23T00:00:00.000Z",
        ),
    )
    return services, project_id


def _seed_secret(services, project_id):
    encrypted = services.encrypt(SECRET)
    services.database.execute(
        """
        INSERT INTO project_secrets (
          id, project_id, name, key_version, iv, tag, ciphertext,
          created_at, updated_at
        ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
        """,
        (
            "secret-1",
            project_id,
            "token",
            encrypted["iv"],
            encrypted["tag"],
            encrypted["ciphertext"],
            "2026-08-23T00:00:00.000Z",
            "2026-08-23T00:00:00.000Z",
        ),
    )


def _event_kinds(preview: dict) -> dict[str, list[dict]]:
    events: dict[str, list[dict]] = {}
    for item in preview["events"]:
        events.setdefault(item["kind"], []).append(item["data"])
    return events


def test_preview_executes_to_assertion_step_inclusive(
    tmp_path, monkeypatch, fixture_server
):
    """upToStepId 指向断言步骤时执行到该步（含），后续步骤不跑、不落库。"""
    services, project_id = _setup_services(tmp_path, monkeypatch)
    try:
        preview = services.preview_run(
            project_id, _preview_input(fixture_server, up_to_step_id="s-assert")
        )
        result = preview["result"]
        assert result["status"] == "success"
        assertions = result["assertions"]
        assert len(assertions) == 1
        assert assertions[0]["stepId"] == "s-assert"
        assert assertions[0]["type"] == "text"
        assert assertions[0]["passed"] is True

        by_kind = _event_kinds(preview)
        completed_ids = [event["stepId"] for event in by_kind["step.completed"]]
        assert completed_ids == ["s-open", "s-assert"]
        # 后续步骤不执行。
        assert "s-count" not in completed_ids

        # 顺序契约：step.asserted 恒在对应 step.completed 之前。
        asserted_at = next(
            index
            for index, event in enumerate(preview["events"])
            if event["kind"] == "step.asserted"
            and event["data"].get("stepId") == "s-assert"
        )
        completed_at = next(
            index
            for index, event in enumerate(preview["events"])
            if event["kind"] == "step.completed"
            and event["data"].get("stepId") == "s-assert"
        )
        assert asserted_at < completed_at

        # 不写 platform_runs / platform_run_events。
        assert services.database.execute("SELECT COUNT(*) FROM platform_runs").fetchone()[0] == 0
        assert (
            services.database.execute("SELECT COUNT(*) FROM platform_run_events").fetchone()[0]
            == 0
        )
    finally:
        services.close()


def test_preview_full_run_returns_all_assertions(
    tmp_path, monkeypatch, fixture_server
):
    """不带 upToStepId 时跑完全程，返回全部断言（含失败但继续执行的步）。"""
    services, project_id = _setup_services(tmp_path, monkeypatch)
    try:
        preview = services.preview_run(project_id, _preview_input(fixture_server))
        result = preview["result"]
        assert result["status"] == "success"
        assertions = result["assertions"]
        assert len(assertions) == 2
        text, count = assertions
        assert text["stepId"] == "s-assert"
        assert text["passed"] is True
        assert count["stepId"] == "s-count"
        assert count["type"] == "count"
        assert count["passed"] is False
        assert count["expected"] == "5"
        assert count["actual"] == "1"

        by_kind = _event_kinds(preview)
        asserted_ids = [event["stepId"] for event in by_kind["step.asserted"]]
        assert asserted_ids == ["s-assert", "s-count"]
        assert services.database.execute("SELECT COUNT(*) FROM platform_runs").fetchone()[0] == 0
        assert (
            services.database.execute("SELECT COUNT(*) FROM platform_run_events").fetchone()[0]
            == 0
        )
    finally:
        services.close()


def test_preview_missing_up_to_step_returns_run_step_not_found(
    tmp_path, monkeypatch
):
    """upToStepId 不存在时复用 RUN_STEP_NOT_FOUND（无需启动浏览器）。"""
    services, project_id = _setup_services(tmp_path, monkeypatch)
    try:
        with pytest.raises(PlatformError) as error:
            services.preview_run(
                project_id, _preview_input("http://127.0.0.1:1", up_to_step_id="nope")
            )
        assert error.value.status == 400
        assert error.value.code == "RUN_STEP_NOT_FOUND"
    finally:
        services.close()


def test_preview_resolves_secrets_and_redacts(tmp_path, monkeypatch, fixture_server):
    """服务端解析 {{secret.token}} 注入执行输入，返回载荷统一脱敏。"""
    services, project_id = _setup_services(tmp_path, monkeypatch)
    _seed_secret(services, project_id)
    try:
        preview_input = _preview_input(fixture_server)
        assert_step = preview_input["flow"]["steps"][1]
        assert_step["value"] = "{{secret.token}} authenticated"
        preview = services.preview_run(project_id, preview_input)

        result = preview["result"]
        record = result["assertions"][0]
        # 前提：占位符确被服务端注入的 secret 解析（expected 不再是含
        # {{secret.token}} 字面量的原始值，而是解析后的「SECRET authenticated」），
        # 随后整体脱敏为「*** authenticated」。
        assert record["expected"] == "*** authenticated"
        assert record["actual"] == "*** authenticated"

        # 返回载荷（result + events）全部脱敏，无 secret 明文泄漏。
        payload = json.dumps(preview, ensure_ascii=False)
        assert SECRET not in payload
        # 事件载荷同样脱敏。
        asserted_event = next(
            event
            for event in preview["events"]
            if event["kind"] == "step.asserted"
            and event["data"].get("stepId") == "s-assert"
        )
        assert asserted_event["data"]["expected"] == "*** authenticated"
        assert asserted_event["data"]["actual"] == "*** authenticated"
        assert SECRET not in json.dumps(asserted_event, ensure_ascii=False)
    finally:
        services.close()
