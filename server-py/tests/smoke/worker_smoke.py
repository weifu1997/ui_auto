#!/usr/bin/env python3
"""Python worker smoke matching server/worker-smoke.ts core scenarios."""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request


def request(base_url: str, path: str, method: str = "GET", body: dict | None = None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"{base_url}{path}",
        data=data,
        headers={"content-type": "application/json"},
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            payload = response.read().decode("utf-8")
            return response.status, json.loads(payload) if payload else {}
    except urllib.error.HTTPError as error:
        payload = error.read().decode("utf-8")
        return error.code, json.loads(payload) if payload else {}


def wait_terminal(base_url: str, path: str) -> dict:
    for _ in range(120):
        _, task = request(base_url, path)
        if task["status"] in ("success", "failed", "canceled"):
            return task
        time.sleep(0.25)
    raise RuntimeError("worker task timed out")


def run(base_url: str) -> None:
    status, health = request(base_url, "/health")
    assert status == 200 and health.get("ok") is True

    environment = {
        "id": "fixture",
        "name": "Worker fixture",
        "baseUrl": base_url,
        "browser": "Chromium",
        "timeout": 10,
    }
    element = {
        "id": "promo",
        "name": "候选按钮",
        "path": "/__fixture/multiple",
        "method": "CSS",
        "value": ".candidate",
        "environment": "fixture",
    }
    status, created = request(
        base_url,
        "/api/projects/fixture-project/validations",
        "POST",
        {"environment": environment, "element": element},
    )
    assert status == 202
    validation = wait_terminal(
        base_url,
        f"/api/projects/fixture-project/validations/{created['validationId']}",
    )
    assert validation["status"] == "success"
    assert validation["result"]["count"] == 3

    elements = [
        {**element, "id": "account", "name": "账号", "path": "/__fixture/login", "method": "testid", "value": "login-account"},
        {**element, "id": "password", "name": "密码", "path": "/__fixture/login", "method": "testid", "value": "login-password"},
        {**element, "id": "submit", "name": "登录", "path": "/__fixture/login", "method": "testid", "value": "login-submit"},
        {**element, "id": "welcome", "name": "欢迎", "path": "/__fixture/login", "method": "testid", "value": "welcome"},
    ]
    flow = {
        "id": "fixture-login",
        "name": "Fixture 登录",
        "steps": [
            {"id": "open", "title": "打开", "action": "打开页面", "value": "/__fixture/login", "timeout": 10, "failurePolicy": "立即失败", "status": "pending"},
            {"id": "account", "title": "填写账号", "action": "填写", "element": "账号", "value": "demo", "timeout": 10, "failurePolicy": "立即失败", "status": "pending"},
            {"id": "password", "title": "填写密码", "action": "填写", "element": "密码", "value": "secret", "timeout": 10, "failurePolicy": "立即失败", "status": "pending"},
            {"id": "login", "title": "登录", "action": "点击", "element": "登录", "value": "", "timeout": 10, "failurePolicy": "立即失败", "status": "pending"},
            {"id": "assert", "title": "断言欢迎", "action": "可见性断言", "element": "欢迎", "value": "", "timeout": 10, "failurePolicy": "立即失败", "status": "pending"},
        ],
    }
    status, run_response = request(
        base_url,
        "/api/projects/fixture-project/runs",
        "POST",
        {"environment": environment, "flow": flow, "elements": elements},
    )
    assert status == 202
    run = wait_terminal(base_url, f"/api/projects/fixture-project/runs/{run_response['runId']}")
    assert run["status"] == "success"
    assert run["result"]["completedSteps"] == 5
    assert run["artifactIds"]
    print("worker smoke ok")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: worker_smoke.py <base-url>")
    run(sys.argv[1])
