"""Stage W1-2: 孤儿产物文件清扫单测。

契约：
- ``_sweep_orphan_artifact_files`` 只删除「磁盘存在且 platform_artifacts
  无行引用、mtime 超过窗口」的文件；
- 已登记的文件即使超龄也保留（超龄删除仍由 artifacts retention 段负责）；
- 新写入（窗口内）的无引用文件保留，避免误删正在落盘的半途截图；
- dry_run 只统计不删除。
"""

from __future__ import annotations

import os
import time

from autoflow.services import AuthUser, PlatformServices


def _services(tmp_path, monkeypatch):
    monkeypatch.setenv("PLATFORM_SECRET_KEY", "test-key-orphan")
    services = PlatformServices(str(tmp_path))
    user = AuthUser("owner-orphan", "owner-orphan@example.test", "Owner")
    services.database.execute(
        """
        INSERT INTO platform_users (id, email, name, created_at)
        VALUES (?, ?, ?, ?)
        """,
        (user.id, user.email, user.name, "2026-08-24T00:00:00.000Z"),
    )
    workspace = services.create_workspace(user, "Orphan workspace")
    return services, workspace["id"]


def test_orphan_sweep_removes_only_unreferenced_stale_files(tmp_path, monkeypatch):
    services, _ = _services(tmp_path, monkeypatch)
    try:
        base = services.managed_runner.artifact_directory
        base.mkdir(parents=True, exist_ok=True)

        orphan_old = base / "artifact_orphan-old.png"
        orphan_new = base / "artifact_orphan-new.png"
        referenced = base / "artifact_referenced.png"
        for path in (orphan_old, orphan_new, referenced):
            path.write_bytes(b"png-bytes")

        # referenced：造一行 platform_artifacts 记录指向它（借 audit_events 的
        # 轻量路径不可行——直接插入一个合法 run 太重；用项目隔离允许的最小
        # 组合：先补 project 再 run 会拖入 agent/revision。这里改为绕开：
        # orphan 判定只看 path 字符串集合，因此造一条 run 无关的行不行，
        # FK 约束要求 run 存在——所以本测试走真实链条：复用 finalize 测试
        # 的种子逻辑太重，改为将 referenced 文件记到一个已存在表不现实。
        # 结论：referenced 行为通过 dry_run 分支与新鲜窗口分支共同覆盖。
        del referenced

        # 让 orphan_old 落到 24h 窗口之外。
        stale_ts = time.time() - 25 * 3600
        os.utime(orphan_old, (stale_ts, stale_ts))

        removed = services._sweep_orphan_artifact_files(
            base, max_age_hours=24, dry_run=False
        )
        assert removed == 1
        assert not orphan_old.exists()
        assert orphan_new.exists()  # 窗口内，正在写盘的半途文件受保护

        # 再次清扫：没有任何可删项。
        assert (
            services._sweep_orphan_artifact_files(
                base, max_age_hours=24, dry_run=False
            )
            == 0
        )
    finally:
        services.close()


def test_orphan_sweep_keeps_rows_referenced_paths(tmp_path, monkeypatch):
    """有行引用的路径即使 mtime 很老也不能被孤儿清扫删除。"""
    services, workspace_id = _services(tmp_path, monkeypatch)
    try:
        from datetime import datetime, timezone

        created = (
            datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
        )
        user_id = "owner-orphan"
        project_id = "project-orp"
        services.database.execute(
            """
            INSERT INTO platform_projects (
              id, workspace_id, slug, name, description, created_at, updated_at
            ) VALUES (?, ?, ?, ?, '', ?, ?)
            """,
            (project_id, workspace_id, project_id, "Project", created, created),
        )
        revision_id = "rev-orp"
        agent_id = "agent-orp"
        services.database.execute(
            """
            INSERT INTO flow_revisions (
              id, project_id, flow_id, flow_name, environment_id,
              revision_number, status, flow_snapshot, environment_snapshot,
              element_snapshot, dataset_snapshot, checksum, created_at, created_by
            ) VALUES (?, ?, 'f', 'F', 'e', 5001, 'published',
                      '{}', '{}', '{}', '{}', 'c', ?, 'owner')
            """,
            (revision_id, project_id, created),
        )
        services.database.execute(
            """
            INSERT INTO agents (
              id, workspace_id, name, credential_hash, status, browser_version,
              os, max_concurrency, created_at
            ) VALUES (?, ?, 'a', 'x', 'active', 'stable', 'linux', 1, ?)
            """,
            (agent_id, workspace_id, created),
        )
        run_id = "run-orp"
        services.database.execute(
            """
            INSERT INTO platform_runs (
              id, project_id, revision_id, environment_id, agent_id, status,
              snapshot, cancellation_requested, result, created_by, created_at, updated_at
            ) VALUES (?, ?, ?, 'env', ?, 'running', '{}', 0, NULL, 'owner', ?, ?)
            """,
            (run_id, project_id, revision_id, agent_id, created, created),
        )

        base = services.managed_runner.artifact_directory
        base.mkdir(parents=True, exist_ok=True)
        kept = base / "artifact_registered.png"
        kept.write_bytes(b"trace-zip")
        stale_ts = time.time() - 48 * 3600
        os.utime(kept, (stale_ts, stale_ts))
        services.database.execute(
            """
            INSERT INTO platform_artifacts (
              id, run_id, project_id, name, content_type, path, created_at
            ) VALUES ('art-1', ?, ?, 't.zip', 'application/zip', ?, ?)
            """,
            (run_id, project_id, str(kept.resolve()), created),
        )

        removed = services._sweep_orphan_artifact_files(
            base, max_age_hours=24, dry_run=False
        )
        assert removed == 0
        assert kept.exists()
    finally:
        services.close()


def test_orphan_sweep_dry_run_counts_without_deleting(tmp_path, monkeypatch):
    services, _ = _services(tmp_path, monkeypatch)
    try:
        base = services.managed_runner.artifact_directory
        base.mkdir(parents=True, exist_ok=True)
        orphan = base / "artifact_x.png"
        orphan.write_bytes(b"x")
        stale_ts = time.time() - 30 * 3600
        os.utime(orphan, (stale_ts, stale_ts))

        counted = services._sweep_orphan_artifact_files(
            base, max_age_hours=24, dry_run=True
        )
        assert counted == 1
        assert orphan.exists()
    finally:
        services.close()
