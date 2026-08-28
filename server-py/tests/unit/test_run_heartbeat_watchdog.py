"""Stage W0-4: run 心跳、watchdog 阈值与迟到成功结果兜底单测。

契约：
- ``touch_run_heartbeat`` 只刷新 running 行的 updated_at，其它状态不动；
- ManagedRunner 为 run 提供步骤级 progress 钩子；入队方未提供时安全降级；
- watchdog 判死窗口由 RUN_WATCHDOG_MINUTES 控制，默认 20，钳制 [5, 240]；
- 被误杀（failed）的 run 收到迟到的 success 结果时，
  ``absorb_late_completed_run`` 补齐 flowOutputs 与 run.lateCompletion 事件，
  状态保持 failed 不回改。
"""

from __future__ import annotations

import json
import threading
import uuid

import pytest

from autoflow import main as main_module
from autoflow.managed_runner import ManagedRunner
from autoflow.services import AuthUser, PlatformServices


def _setup_services(tmp_path, monkeypatch):
    monkeypatch.setenv("PLATFORM_SECRET_KEY", "test-key-heartbeat")
    services = PlatformServices(str(tmp_path))
    user = AuthUser("owner-hb", "owner-hb@example.test", "Owner")
    services.database.execute(
        """
        INSERT INTO platform_users (id, email, name, created_at)
        VALUES (?, ?, ?, ?)
        """,
        (user.id, user.email, user.name, "2026-08-24T00:00:00.000Z"),
    )
    workspace = services.create_workspace(user, "Heartbeat workspace")
    project_id = "project-hb"
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
            "2026-08-24T00:00:00.000Z",
            "2026-08-24T00:00:00.000Z",
        ),
    )
    return services, workspace, project_id


def _insert_run(services, project_id: str, *, status: str) -> str:
    workspace_id = services.database.execute(
        "SELECT workspace_id FROM platform_projects WHERE id = ?", (project_id,)
    ).fetchone()[0]
    revision_id = f"rev-{uuid.uuid4().hex[:8]}"
    agent_id = f"agent-{uuid.uuid4().hex[:8]}"
    services.database.execute(
        """
        INSERT INTO flow_revisions (
          id, project_id, flow_id, flow_name, environment_id,
          revision_number, status, flow_snapshot, environment_snapshot,
          element_snapshot, dataset_snapshot, checksum, created_at, created_by
        ) VALUES (?, ?, 'flow-1', 'HB Flow', 'env-1', ?, 'published',
                  '{}', '{}', '{}', '{}', 'hb-checksum',
                  '2026-08-24T00:00:00.000Z', 'owner')
        """,
        (revision_id, project_id, 1000 + uuid.uuid4().int % 900_000),
    )
    services.database.execute(
        """
        INSERT INTO agents (
          id, workspace_id, name, credential_hash, status, browser_version,
          os, max_concurrency, created_at
        ) VALUES (?, ?, 'hb-agent', 'x', 'active', 'stable', 'linux', 1,
                  '2026-08-24T00:00:00.000Z')
        """,
        (agent_id, workspace_id),
    )
    run_id = f"run-{uuid.uuid4().hex[:8]}"
    snapshot = {"flow": {"name": "HB Flow", "steps": []}}
    services.database.execute(
        """
        INSERT INTO platform_runs (
          id, project_id, revision_id, environment_id, agent_id, status,
          snapshot, cancellation_requested, result, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, 'env-1', ?, ?, ?, 0, NULL, 'owner',
                  '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:01.000Z')
        """,
        (run_id, project_id, revision_id, agent_id, status, json.dumps(snapshot)),
    )
    return run_id


# ---------- 心跳 ----------


def test_touch_run_heartbeat_updates_only_running_rows(tmp_path, monkeypatch):
    services, _, project_id = _setup_services(tmp_path, monkeypatch)
    try:
        running = _insert_run(services, project_id, status="running")
        canceled = _insert_run(services, project_id, status="canceled")

        before = dict(
            services.database.execute(
                "SELECT id, updated_at FROM platform_runs WHERE id IN (?, ?)",
                (running, canceled),
            ).fetchall()
        )
        old_running = before[running]
        old_canceled = before[canceled]

        services.touch_run_heartbeat(running)
        services.touch_run_heartbeat(canceled)

        new = dict(
            services.database.execute(
                "SELECT id, updated_at FROM platform_runs WHERE id IN (?, ?)",
                (running, canceled),
            ).fetchall()
        )
        # running 行被刷新为当前时间；canceled 行完全不受影响。
        assert new[running] > old_running
        assert new[canceled] == old_canceled
    finally:
        services.close()


# ---------- ManagedRunner progress 钩子 ----------


def test_managed_runner_invokes_progress_and_defaults_safely(
    tmp_path, monkeypatch
):
    from autoflow import managed_runner as runner_module

    captured: dict[str, object] = {}
    heartbeats: list[int] = []

    def fake_execute(input_data, hooks):
        captured["progress_callable"] = hooks.get("progress")
        callback = hooks.get("progress")
        if callable(callback):
            callback(0)
            callback(1)
        return {
            "status": "success",
            "completedSteps": 2,
            "totalSteps": 2,
            "elapsedMs": 1,
            "flowOutputs": {},
        }

    monkeypatch.setattr(runner_module, "execute_browser_run", fake_execute)

    runner = ManagedRunner(str(tmp_path / "artifacts"))
    try:
        done = threading.Event()

        runner.enqueue(
            "item-progress",
            {"flow": {"steps": [{}, {}]}},
            {
                "started": lambda: None,
                "event": lambda *_a: None,
                "artifact": lambda *_a: None,
                "completed": lambda _result: done.set(),
                "progress": lambda index: heartbeats.append(index),
            },
            kind="run",
        )
        assert done.wait(timeout=10)
        assert heartbeats == [0, 1]

        # 入队方未提供 progress：默认 no-op，不抛 KeyError。
        done2 = threading.Event()
        runner.enqueue(
            "item-noprogress",
            {"flow": {"steps": [{}]}},
            {
                "started": lambda: None,
                "event": lambda *_a: None,
                "artifact": lambda *_a: None,
                "completed": lambda _result: done2.set(),
            },
            kind="run",
        )
        assert done2.wait(timeout=10)
        assert callable(captured["progress_callable"])
    finally:
        runner.stop()


# ---------- watchdog 窗口 ----------


def test_run_watchdog_minutes_env_contract(monkeypatch):
    cases = [
        (None, 20),
        ("abc", 20),
        ("0", 5),
        ("3", 5),
        ("45", 45),
        ("9999", 240),
    ]
    for raw, expected in cases:
        if raw is None:
            monkeypatch.delenv("RUN_WATCHDOG_MINUTES", raising=False)
        else:
            monkeypatch.setenv("RUN_WATCHDOG_MINUTES", raw)
        assert main_module._run_watchdog_minutes() == expected


# ---------- 迟到成功兜底 ----------


def test_absorb_late_completed_run_keeps_failed_but_persists_outputs(
    tmp_path, monkeypatch
):
    services, _, project_id = _setup_services(tmp_path, monkeypatch)
    try:
        run_id = _insert_run(services, project_id, status="failed")

        current_run = services.run_by_id(run_id)
        safe_result = {
            "status": "success",
            "completedSteps": 2,
            "totalSteps": 2,
            "elapsedMs": 100,
            "flowOutputs": {},
        }
        services.absorb_late_completed_run(run_id, current_run, safe_result)

        status_after = services.database.execute(
            "SELECT status FROM platform_runs WHERE id = ?", (run_id,)
        ).fetchone()[0]
        assert status_after == "failed"  # 状态不回改

        kinds = [
            row[0]
            for row in services.database.execute(
                "SELECT kind FROM platform_run_events WHERE run_id = ?", (run_id,)
            ).fetchall()
        ]
        assert "run.lateCompletion" in kinds
    finally:
        services.close()
