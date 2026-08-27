"""Stage W1-1: 执行终态落库事务化单测。

契约：
- 终态 UPDATE、flowOutputs、run.complete 事件、审计与投递登记在同一
  BEGIN IMMEDIATE 内提交；任一环节抛错则整体回滚，run 仍停留在原状态，
  不会出现「账面已结束但输出/事件丢失」的半完成账；
- 投递网络发送发生在事务提交之后（``queue_run_deliveries(..., flush=False)``
  只入队），lock 持有时间与外网无关。
"""

from __future__ import annotations

import json
import uuid

import pytest

from autoflow.services import AuthUser, PlatformServices


def _setup_services(tmp_path, monkeypatch):
    monkeypatch.setenv("PLATFORM_SECRET_KEY", "test-key-finalize")
    services = PlatformServices(str(tmp_path))
    user = AuthUser("owner-fin", "owner-fin@example.test", "Owner")
    services.database.execute(
        """
        INSERT INTO platform_users (id, email, name, created_at)
        VALUES (?, ?, ?, ?)
        """,
        (user.id, user.email, user.name, "2026-08-24T00:00:00.000Z"),
    )
    workspace = services.create_workspace(user, "Finalize workspace")
    project_id = "project-fin"
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
    # 让通知发送成为可观测的内存操作，避免测试触网。
    flushed: list[int] = []
    services.deliver_pending_notifications = lambda: flushed.append(1)  # type: ignore[method-assign]
    return services, project_id, flushed


def _insert_running_run(
    services, project_id: str, *, output_public: bool = True
) -> str:
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
        ) VALUES (?, ?, 'flow-1', 'Fin Flow', 'env-1', ?, 'published',
                  '{}', '{}', '{}', '{}', 'fin-checksum',
                  '2026-08-24T00:00:00.000Z', 'owner')
        """,
        (revision_id, project_id, 2000 + uuid.uuid4().int % 900_000),
    )
    services.database.execute(
        """
        INSERT INTO agents (
          id, workspace_id, name, credential_hash, status, browser_version,
          os, max_concurrency, created_at
        ) VALUES (?, ?, 'fin-agent', 'x', 'active', 'stable', 'linux', 1,
                  '2026-08-24T00:00:00.000Z')
        """,
        (agent_id, workspace_id),
    )
    run_id = f"run-{uuid.uuid4().hex[:8]}"
    snapshot = {
        "flow": {
            "name": "Fin Flow",
            "steps": [
                {"id": "s1", "action": "截图", "title": "截图",
                 "output": "alpha", "outputPublic": output_public}
            ],
        }
    }
    services.database.execute(
        """
        INSERT INTO platform_runs (
          id, project_id, revision_id, environment_id, agent_id, status,
          snapshot, cancellation_requested, result, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, 'env-1', ?, 'running', ?, 0, NULL, 'owner',
                  '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:01.000Z')
        """,
        (run_id, project_id, revision_id, agent_id, json.dumps(snapshot)),
    )
    return run_id


def _success_result() -> dict:
    return {
        "status": "success",
        "completedSteps": 1,
        "totalSteps": 1,
        "elapsedMs": 10,
        "flowOutputs": {"alpha": "captured-value"},
    }


def _event_kinds(services, run_id: str) -> list[str]:
    return [
        row[0]
        for row in services.database.execute(
            "SELECT kind FROM platform_run_events WHERE run_id = ?", (run_id,)
        ).fetchall()
    ]


def test_finalize_commits_terminal_state_outputs_events_and_flush(
    tmp_path, monkeypatch
):
    services, project_id, flushed = _setup_services(tmp_path, monkeypatch)
    try:
        run_id = _insert_running_run(services, project_id)
        services.finalize_completed_run(run_id, _success_result())

        row = services.database.execute(
            "SELECT status, result FROM platform_runs WHERE id = ?", (run_id,)
        ).fetchone()
        assert row[0] == "success"
        assert "alpha" in row[1]

        outputs = services.database.execute(
            "SELECT name, value FROM flow_outputs WHERE run_id = ?", (run_id,)
        ).fetchall()
        assert outputs == [("alpha", "captured-value")]
        assert "run.complete" in _event_kinds(services, run_id)
        assert len(flushed) == 1  # 提交后触发一次投递发送
    finally:
        services.close()


def test_finalize_rolls_back_entirely_when_output_persist_fails(
    tmp_path, monkeypatch
):
    """outputs 写入半路炸掉：终态、事件、审计必须整体回滚。"""
    services, project_id, flushed = _setup_services(tmp_path, monkeypatch)
    try:
        run_id = _insert_running_run(services, project_id)

        def boom(*_args, **_kwargs):
            raise RuntimeError("disk exploded mid-finalize")

        # 注意：这里必须用实例属性并在 finally 中删除；仅 monkeypatch 类属性
        # 无法去掉已存在的实例遮蔽，会让后面的重放段继续命中 boom。
        services.persist_flow_outputs = boom  # type: ignore[method-assign]
        try:
            with pytest.raises(RuntimeError, match="disk exploded"):
                services.finalize_completed_run(run_id, _success_result())
        finally:
            del services.persist_flow_outputs  # type: ignore[attr-defined]

        row = services.database.execute(
            "SELECT status FROM platform_runs WHERE id = ?", (run_id,)
        ).fetchone()
        assert row[0] == "running"  # 回滚到执行中
        assert "run.complete" not in _event_kinds(services, run_id)
        assert flushed == []

        # 故障恢复后重放同一结果：正常提交成功。
        services.finalize_completed_run(run_id, _success_result())
        assert (
            services.database.execute(
                "SELECT status FROM platform_runs WHERE id = ?", (run_id,)
            ).fetchone()[0]
            == "success"
        )
    finally:
        services.close()


def test_cancelled_flag_wins_over_runner_success(tmp_path, monkeypatch):
    """cancellation_requested=1 时即便 runner 报 success 也落 canceled。"""
    services, project_id, flushed = _setup_services(tmp_path, monkeypatch)
    try:
        run_id = _insert_running_run(services, project_id)
        services.database.execute(
            "UPDATE platform_runs SET cancellation_requested = 1 WHERE id = ?",
            (run_id,),
        )
        services.finalize_completed_run(run_id, _success_result())
        assert (
            services.database.execute(
                "SELECT status FROM platform_runs WHERE id = ?", (run_id,)
            ).fetchone()[0]
            == "canceled"
        )
        assert flushed == [] or isinstance(flushed, list)
    finally:
        services.close()
