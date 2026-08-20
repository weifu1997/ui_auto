#!/usr/bin/env python3
"""Platform API contract smoke that can target TS or Python services."""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request


def request(
    base_url: str,
    method: str,
    path: str,
    body: dict | None = None,
    token: str | None = None,
) -> tuple[int, dict]:
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
    status, health = request(base_url, "GET", "/health")
    assert status == 200 and health.get("ok") is True

    email = os.environ.get("AUTOFLOW_SMOKE_EMAIL", "").strip().lower()
    password = os.environ.get("AUTOFLOW_SMOKE_PASSWORD", "")
    if not email or not password:
        raise AssertionError(
            "AUTOFLOW_SMOKE_EMAIL and AUTOFLOW_SMOKE_PASSWORD are required; "
            "bootstrap the controlled super-admin with npm run bootstrap:super-admin first"
        )
    status, logged_in = request(
        base_url,
        "POST",
        "/api/auth/login",
        {"email": email, "password": password},
    )
    assert status == 200
    token = logged_in["token"]

    status, workspace_response = request(
        base_url,
        "POST",
        "/api/workspaces",
        {"name": f"Contract smoke {int(time.time() * 1000)}"},
        token,
    )
    assert status == 201
    workspace_id = workspace_response["workspace"]["id"]

    status, project_response = request(
        base_url,
        "POST",
        f"/api/workspaces/{workspace_id}/projects",
        {"name": "Smoke project"},
        token,
    )
    assert status == 201
    project_id = project_response["project"]["id"]

    status, secret_response = request(
        base_url,
        "POST",
        f"/api/platform/projects/{project_id}/secrets",
        {"name": "api-key", "value": "secret-value"},
        token,
    )
    assert status == 201 and secret_response["secret"]["keyVersion"] == 1

    status, analytics = request(
        base_url,
        "GET",
        f"/api/platform/projects/{project_id}/analytics",
        token=token,
    )
    assert status == 200
    assert "summary" in analytics["analytics"]
    print("platform contract smoke ok")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: platform_contract_smoke.py <base-url>")
    run(sys.argv[1])
