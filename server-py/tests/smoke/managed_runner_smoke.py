#!/usr/bin/env python3
"""Python managed-runner smoke matching server/managed-runner-smoke.ts."""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request


def request(
    base_url: str,
    path: str,
    method: str = "GET",
    body: dict | None = None,
    token: str | None = None,
):
    headers = {"content-type": "application/json"}
    if token:
        headers["authorization"] = f"Bearer {token}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"{base_url}{path}",
        data=data,
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            payload = response.read().decode("utf-8")
            return response.status, json.loads(payload) if payload else {}
    except urllib.error.HTTPError as error:
        payload = error.read().decode("utf-8")
        return error.code, json.loads(payload) if payload else {}


def run(base_url: str) -> None:
    email = f"managed-{int(time.time() * 1000)}@example.test"
    status, registered = request(
        base_url,
        "/api/auth/register",
        "POST",
        {"email": email, "password": "password-123", "name": "Managed"},
    )
    assert status == 201
    token = registered["token"]
    _, workspaces = request(base_url, "/api/workspaces", token=token)
    workspace_id = workspaces["workspaces"][0]["id"]
    status, project_response = request(
        base_url,
        f"/api/workspaces/{workspace_id}/projects",
        "POST",
        {"name": "Managed smoke"},
        token,
    )
    assert status == 201
    project_id = project_response["project"]["id"]

    environment = {
        "id": "env-1",
        "name": "Env",
        "browser": "Chromium",
        "baseUrl": base_url,
        "timeout": 10,
    }
    elements = [
        {"id": "account", "name": "账号", "path": "/__fixture/login", "method": "testid", "value": "login-account", "environment": "env-1"},
        {"id": "password", "name": "密码", "path": "/__fixture/login", "method": "testid", "value": "login-password", "environment": "env-1"},
        {"id": "submit", "name": "登录", "path": "/__fixture/login", "method": "testid", "value": "login-submit", "environment": "env-1"},
        {"id": "welcome", "name": "欢迎", "path": "/__fixture/login", "method": "testid", "value": "welcome", "environment": "env-1"},
    ]
    flow = {
        "id": "flow-1",
        "name": "Login",
        "steps": [
            {"id": "open", "title": "打开", "action": "打开页面", "value": "/__fixture/login", "timeout": 10, "failurePolicy": "立即失败", "status": "pending"},
            {"id": "account", "title": "填写账号", "action": "填写", "element": "账号", "value": "demo", "timeout": 10, "failurePolicy": "立即失败", "status": "pending"},
            {"id": "password", "title": "填写密码", "action": "填写", "element": "密码", "value": "secret", "timeout": 10, "failurePolicy": "立即失败", "status": "pending"},
            {"id": "login", "title": "登录", "action": "点击", "element": "登录", "value": "", "timeout": 10, "failurePolicy": "立即失败", "status": "pending"},
            {"id": "assert", "title": "断言欢迎", "action": "可见性断言", "element": "欢迎", "value": "", "timeout": 10, "failurePolicy": "立即失败", "status": "pending"},
        ],
    }
    status, revision_response = request(
        base_url,
        f"/api/platform/projects/{project_id}/revisions",
        "POST",
        {
            "flowId": "flow-1",
            "environmentId": "env-1",
            "flow": flow,
            "environment": environment,
            "elements": elements,
        },
        token,
    )
    assert status == 201
    revision_id = revision_response["revision"]["id"]

    status, run_response = request(
        base_url,
        f"/api/platform/projects/{project_id}/runs",
        "POST",
        {"revisionId": revision_id, "environmentId": "env-1"},
        token,
    )
    assert status == 202
    run_id = run_response["runIds"][0]
    run = None
    for _ in range(120):
        _, detail = request(
            base_url,
            f"/api/platform/projects/{project_id}/runs/{run_id}",
            token=token,
        )
        run = detail["run"]
        if run["status"] in ("success", "failed", "canceled"):
            break
        time.sleep(0.25)
    assert run is not None and run["status"] == "success"
    assert run["result"]["completedSteps"] == 5
    print("managed runner smoke ok")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: managed_runner_smoke.py <base-url>")
    run(sys.argv[1])
