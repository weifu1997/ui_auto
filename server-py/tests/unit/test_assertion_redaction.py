"""Stage C2: 断言 actual 若含 secret 明文，必须沿既有 redact_run_value 路径脱敏。

验证 `services.enqueue_managed_run` 的两个回调路径对断言载荷生效：
- event 回调（runs.py:760 附近）：step.asserted 事件数据先过 redact_run_value 再落库；
- completed 回调（runs.py:793 附近）：result（含 result.assertions）先过
  redact_run_value 再写 platform_runs.result。

用真实 execute_browser_run 产出断言载荷，再走与回调完全相同的调用，
保证「敏感断言值不落明文」在真实链路形状下成立。
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from autoflow.runner import execute_browser_run
from autoflow.services import AuthUser, PlatformServices

SECRET = "super-secret-token-123"
FIXTURE_HTML = f"""<!doctype html>
<html lang="zh-CN"><body>
  <div id="status">{SECRET} authenticated</div>
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


def _step(step_id: str, action: str, *, element: str, value: str = "", **fields) -> dict:
    return {
        "id": step_id,
        "action": action,
        "title": action,
        "element": element,
        "value": value,
        "timeout": 5,
        "failurePolicy": "立即失败",
        "status": "pending",
        **fields,
    }


def _run_assertions(base_url: str) -> dict:
    """真实执行：打开页面 → 文本断言 actual 命中含 SECRET 的页面文本。"""
    hooks = {
        "signal": threading.Event(),
        "artifact_path": lambda name, extension: f"/tmp/redaction-{name}.{extension}",
        "artifact": lambda _data: None,
        "event": lambda _kind, _data: None,
        "browser": lambda *_args: None,
    }
    steps = [
        _step("s-open", "打开页面", element="", value="/", timeout=30),
        _step(
            "s-assert",
            "文本断言",
            element="status",
            value="authenticated",
            assertMatch="contains",
        ),
    ]
    elements = [
        {"id": "e-status", "name": "status", "path": "/", "method": "css",
         "value": "#status", "environment": "env-1"}
    ]
    return execute_browser_run(
        {
            "environment": {"baseUrl": base_url, "headless": True, "timeout": 30},
            "flow": {"id": "flow-1", "name": "Redaction flow", "steps": steps},
            "elements": elements,
            "variables": {},
            "data": {},
            "secrets": {},
        },
        hooks,
    )


def _setup_services(tmp_path, monkeypatch):
    monkeypatch.setenv("PLATFORM_SECRET_KEY", "test-key-for-assertion-redaction")
    services = PlatformServices(str(tmp_path))
    user = AuthUser("owner-1", "owner@example.test", "Owner")
    services.database.execute(
        """
        INSERT INTO platform_users (id, email, name, created_at)
        VALUES (?, ?, ?, ?)
        """,
        (user.id, user.email, user.name, "2026-08-23T00:00:00.000Z"),
    )
    workspace = services.create_workspace(user, "Redaction workspace")
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
    return services, project_id


def test_assertion_actual_with_secret_is_redacted(tmp_path, monkeypatch, fixture_server):
    services, project_id = _setup_services(tmp_path, monkeypatch)
    try:
        result = _run_assertions(fixture_server)
        assert result["status"] == "success"
        record = result["assertions"][0]
        # 前提：actual 确实含 secret 明文，否则本测试无意义。
        assert SECRET in record["actual"]

        run = {"id": "run-1", "projectId": project_id}

        # completed 回调路径：result 先脱敏再入库。
        safe_result = services.redact_run_value(run, result)
        assert SECRET not in json.dumps(safe_result, ensure_ascii=False)
        redacted_actual = safe_result["assertions"][0]["actual"]
        assert "***" in redacted_actual
        assert "authenticated" in redacted_actual  # 非敏感部分保留
        assert safe_result["assertions"][0]["passed"] is True
        assert safe_result["assertions"][0]["expected"] == "authenticated"

        # event 回调路径：step.asserted 事件数据先脱敏再落库。
        asserted_event = {
            "index": 1,
            "stepId": "s-assert",
            "title": "文本断言",
            "type": "text",
            "passed": True,
            "expected": "authenticated",
            "actual": record["actual"],
            "durationMs": 12,
        }
        safe_event = services.redact_run_value(run, asserted_event)
        assert SECRET not in json.dumps(safe_event, ensure_ascii=False)
        assert safe_event["actual"] == redacted_actual
        assert safe_event["type"] == "text"
        assert safe_event["passed"] is True
    finally:
        services.close()
