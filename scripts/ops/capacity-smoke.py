#!/usr/bin/env python3
"""Capacity smoke skeleton (CAP-01).

Runs a bootstrap-account driven load profile against a real deployment and prints
timing + success/failure counts. It does not fabricate P95 evidence; those numbers
must come from a controlled run on declared hardware.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request


def request(base_url, path, method="GET", body=None, token=None):
    headers = {"content-type": "application/json"}
    if token:
        headers["authorization"] = f"Bearer {token}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"{base_url}{path}", data=data, headers=headers, method=method
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            payload = response.read().decode("utf-8")
            return response.status, json.loads(payload) if payload else {}
    except urllib.error.HTTPError as error:
        payload = error.read().decode("utf-8")
        return error.code, json.loads(payload) if payload else {}


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: capacity-smoke.py <base-url>")
    base_url = sys.argv[1]
    email = os.environ.get("AUTOFLOW_SMOKE_EMAIL", "").strip().lower()
    password = os.environ.get("AUTOFLOW_SMOKE_PASSWORD", "")
    if not email or not password:
        print("AUTOFLOW_SMOKE_EMAIL and AUTOFLOW_SMOKE_PASSWORD are required", file=sys.stderr)
        return 2

    status, logged_in = request(base_url, "/api/auth/login", "POST", {"email": email, "password": password})
    if status != 200:
        print(f"login failed: {status}", file=sys.stderr)
        return 1
    token = logged_in["token"]

    workspace_count = int(os.environ.get("AUTOFLOW_CAPACITY_WORKSPACES", "10"))
    run_count = int(os.environ.get("AUTOFLOW_CAPACITY_RUNS", "20"))
    results = {"workspaces": 0, "runs": 0, "failed": 0, "durations_ms": []}
    started = time.monotonic()
    for index in range(workspace_count):
        start = time.monotonic()
        status, payload = request(base_url, "/api/workspaces", "POST", {"name": f"Capacity {int(time.time() * 1000)}-{index}"}, token)
        if status == 201:
            results["workspaces"] += 1
            workspace_id = payload["workspace"]["id"]
            status, project = request(base_url, f"/api/workspaces/{workspace_id}/projects", "POST", {"name": "Capacity"}, token)
            if status == 201:
                project_id = project["project"]["id"]
                for _ in range(run_count // workspace_count):
                    run_start = time.monotonic()
                    status, run_payload = request(
                        base_url,
                        f"/api/platform/projects/{project_id}/runs",
                        "POST",
                        {"environmentId": "env-1"},
                        token,
                    )
                    results["durations_ms"].append(int((time.monotonic() - run_start) * 1000))
                    if status in (202, 200):
                        results["runs"] += 1
                    else:
                        results["failed"] += 1
        else:
            results["failed"] += 1
        results["durations_ms"].append(int((time.monotonic() - start) * 1000))

    elapsed = time.monotonic() - started
    durations = sorted(results["durations_ms"])
    p95 = durations[int(len(durations) * 0.95)] if durations else 0
    print(json.dumps(
        {
            "elapsedSeconds": round(elapsed, 2),
            "workspaces": results["workspaces"],
            "runs": results["runs"],
            "failed": results["failed"],
            "p95Ms": p95,
        },
        ensure_ascii=False,
    ))
    return 0 if results["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
