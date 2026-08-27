"""Stage W1-3: 元素校验恢复/收割/取消单测。

契约：
- 重启恢复：queued/running 校验 → failed(VALIDATION_SERVICE_RESTARTED)；
- 运行期收割：updated_at 超窗的 running → failed(VALIDATION_WATCHDOG_TIMEOUT)，
  queued 不受影响；
- 取消：queued/running 幂等取消为 canceled(VALIDATION_CANCELED)，终态原样返回；
  已取消行的迟来完成回调不得回写（状态守卫）。
"""

from __future__ import annotations

import uuid

import pytest

from autoflow.services import AuthUser, PlatformServices


def _setup(tmp_path, monkeypatch):
    monkeypatch.setenv("PLATFORM_SECRET_KEY", "test-key-valid")
    services = PlatformServices(str(tmp_path))
    user = AuthUser("owner-val", "owner-val@example.test", "Owner")
    services.database.execute(
        """
        INSERT INTO platform_users (id, email, name, created_at)
        VALUES (?, ?, ?, ?)
        """,
        (user.id, user.email, user.name, "2026-08-24T00:00:00.000Z"),
    )
    workspace = services.create_workspace(user, "Val workspace")
    workspace_id = workspace["id"]
    project_id = "project-val"
    created = "2026-08-24T00:00:00.000Z"
    services.database.execute(
        """
        INSERT INTO platform_projects (
          id, workspace_id, slug, name, description, created_at, updated_at
        ) VALUES (?, ?, ?, ?, '', ?, ?)
        """,
        (project_id, workspace_id, project_id, "Project", created, created),
    )
    services.database.execute(
        """
        INSERT INTO agents (
          id, workspace_id, name, credential_hash, status, browser_version,
          os, max_concurrency, created_at
        ) VALUES ('agent-val', ?, 'a', 'x', 'active', 'stable', 'linux', 1, ?)
        """,
        (workspace_id, created),
    )
    return services, project_id


def _insert_validation(services, project_id: str, *, status: str, updated_at: str) -> str:
    validation_id = f"val-{uuid.uuid4().hex[:8]}"
    services.database.execute(
        """
        INSERT INTO element_validations (
          id, project_id, environment_id, agent_id, status,
          element_snapshot, error, created_by, created_at, updated_at
        ) VALUES (?, ?, 'env-1', 'agent-val', ?, '{}', NULL, 'owner',
                  '2026-08-24T00:00:00.000Z', ?)
        """,
        (validation_id, project_id, status, updated_at),
    )
    return validation_id


def _row(services, validation_id: str):
    return services.database.execute(
        "SELECT status, error FROM element_validations WHERE id = ?",
        (validation_id,),
    ).fetchone()


def test_recover_interrupted_validations_fails_stale_rows(tmp_path, monkeypatch):
    services, project_id = _setup(tmp_path, monkeypatch)
    try:
        queued = _insert_validation(
            services, project_id, status="queued", updated_at="2026-08-24T00:01:00.000Z"
        )
        running = _insert_validation(
            services, project_id, status="running", updated_at="2026-08-24T00:02:00.000Z"
        )
        done = _insert_validation(
            services, project_id, status="success", updated_at="2026-08-24T00:03:00.000Z"
        )

        services.recover_interrupted_validations()

        assert _row(services, queued)[0] == "failed"
        assert _row(services, queued)[1] == "VALIDATION_SERVICE_RESTARTED"
        assert _row(services, running)[0] == "failed"
        assert _row(services, done)[0] == "success"  # 终态不受重启恢复影响
    finally:
        services.close()


def test_reap_only_stale_running(tmp_path, monkeypatch):
    services, project_id = _setup(tmp_path, monkeypatch)
    try:
        stuck = _insert_validation(
            services,
            project_id,
            status="running",
            updated_at="2026-08-24T00:00:00.000Z",
        )
        fresh_running = _insert_validation(
            services, project_id, status="running", updated_at="2099-01-01T00:00:00.000Z"
        )
        waiting_in_queue = _insert_validation(
            services, project_id, status="queued", updated_at="2026-08-24T00:00:00.000Z"
        )

        assert services.reap_stale_element_validations() == 1

        assert _row(services, stuck) == ("failed", "VALIDATION_WATCHDOG_TIMEOUT")
        assert _row(services, fresh_running)[0] == "running"
        assert _row(services, waiting_in_queue)[0] == "queued"
    finally:
        services.close()


def test_cancel_is_idempotent_and_guarded_against_late_completion(
    tmp_path, monkeypatch
):
    services, project_id = _setup(tmp_path, monkeypatch)
    try:
        cancels: list[str] = []
        original_runner_cancel = services.managed_runner.cancel
        monkeypatch.setattr(
            services.managed_runner,
            "cancel",
            lambda item_id: (cancels.append(item_id), True)[1],
        )

        active = _insert_validation(
            services,
            project_id,
            status="running",
            updated_at="2026-08-24T00:05:00.000Z",
        )
        first = services.cancel_element_validation(active, project_id)
        assert first["status"] == "canceled"
        assert first["error"] == "VALIDATION_CANCELED"
        assert cancels == [active]

        # 幂等重放：终态直接返回，不再触碰 runner。
        again = services.cancel_element_validation(active, project_id)
        assert again["status"] == "canceled"
        assert cancels == [active]

        # 状态守卫：迟到的完成结果不得把 canceled 覆盖成 success。
        artifact_row = None
        payload_rows_before = services.database.execute(
            "SELECT status FROM element_validations WHERE id = ?", (active,)
        ).fetchone()
        assert payload_rows_before[0] == "canceled"

        captured: dict[str, object] = {}

        def fake_enqueue(item_id, input_data, callbacks, kind=None, workspace_id=None):
            captured["completed"] = callbacks["completed"]

        monkeypatch.setattr(services.managed_runner, "enqueue", fake_enqueue)
        services.enqueue_managed_validation(
            {"id": active, "projectId": project_id, "element": {"id": "e1"}},
            {"baseUrl": "https://env.test"},
            None,
        )
        captured["completed"]({"status": "success", "count": 3})

        assert _row(services, active)[0] == "canceled"  # 未被覆盖
        del artifact_row
        del original_runner_cancel
    finally:
        services.close()
