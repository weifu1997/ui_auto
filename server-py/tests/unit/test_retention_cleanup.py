from datetime import datetime, timedelta, timezone

from autoflow.core import now
from autoflow.services import PlatformServices


def _old(days: int) -> str:
    return (
        datetime.now(timezone.utc) - timedelta(days=days)
    ).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _seed(services: PlatformServices) -> str:
    services.database.execute(
        """
        INSERT INTO workspaces (id, name, created_at) VALUES ('ws-ret', 'Ret', ?)
        """,
        (now(),),
    )
    services.database.execute(
        """
        INSERT INTO platform_projects (
          id, workspace_id, slug, name, description, created_at, updated_at
        ) VALUES ('proj-ret', 'ws-ret', 'proj-ret', 'Ret', '', ?, ?)
        """,
        (now(), now()),
    )
    services.database.execute(
        """
        INSERT INTO agents (
          id, workspace_id, name, credential_hash, status, browser_version,
          os, max_concurrency, created_at
        ) VALUES ('agent-ret', 'ws-ret', 'Agent', 'hash', 'online', 'Chromium',
                  'linux', 1, ?)
        """,
        (now(),),
    )
    services.database.execute(
        """
        INSERT INTO flow_revisions (
          id, project_id, revision_number, status, flow_snapshot,
          environment_snapshot, element_snapshot, dataset_snapshot,
          checksum, created_by, created_at
        ) VALUES ('rev-ret', 'proj-ret', 1, 'published', '{}', '{}', '[]',
                  '{}', 'checksum', 'user-ret', ?)
        """,
        (now(),),
    )
    services.database.execute(
        """
        INSERT INTO platform_runs (
          id, project_id, revision_id, environment_id, agent_id, executor_type,
          status, snapshot, created_by, created_at, updated_at
        ) VALUES ('run-ret', 'proj-ret', 'rev-ret', 'env-1', 'agent-ret',
                  'managed', 'success', '{}', 'user-ret', ?, ?)
        """,
        (_old(100), _old(100)),
    )
    return "run-ret"


def test_retention_cleanup_dry_run_does_not_delete(tmp_path):
    services = PlatformServices(str(tmp_path))
    try:
        run_id = _seed(services)
        artifact_dir = services.managed_runner.artifact_directory
        artifact_dir.mkdir(parents=True, exist_ok=True)
        artifact_path = artifact_dir / "expired.png"
        artifact_path.write_bytes(b"artifact")
        services.database.execute(
            """
            INSERT INTO platform_artifacts (
              id, run_id, project_id, name, content_type, path, created_at
            ) VALUES ('art-ret', ?, 'proj-ret', 'expired', 'image/png', ?, ?)
            """,
            (run_id, str(artifact_path), _old(30)),
        )
        services.database.execute(
            """
            INSERT INTO audit_events (
              id, workspace_id, actor_type, actor_id, action, target_type,
              target_id, detail, created_at
            ) VALUES ('audit-ret', 'ws-ret', 'user', 'u', 'act', 't', 'id',
                      '{}', ?)
            """,
            (_old(200),),
        )
        services.database.execute(
            """
            INSERT INTO platform_run_events (
              run_id, kind, data, created_at
            ) VALUES (?, 'run.complete', '{}', ?)
            """,
            (run_id, _old(100)),
        )
        services.database.execute(
            """
            INSERT INTO flow_outputs (
              id, run_id, name, value, source, created_at
            ) VALUES ('out-ret', ?, 'name', 'value', 'flow', ?)
            """,
            (run_id, _old(100)),
        )

        summary = services.retention_cleanup(
            audit_days=180, run_days=90, artifact_days=15, dry_run=True
        )
        assert summary["artifacts"] == 1
        assert summary["runs"] == 1
        assert summary["auditEvents"] == 1
        assert summary["runEvents"] == 0  # dry-run does not cascade-delete
        assert artifact_path.exists()
        assert services.database.execute(
            "SELECT COUNT(*) FROM platform_runs WHERE id = ?", (run_id,)
        ).fetchone()[0] == 1
    finally:
        services.close()


def test_retention_cleanup_removes_expired_rows_and_files(tmp_path):
    services = PlatformServices(str(tmp_path))
    try:
        run_id = _seed(services)
        artifact_dir = services.managed_runner.artifact_directory
        artifact_dir.mkdir(parents=True, exist_ok=True)
        artifact_path = artifact_dir / "expired.png"
        artifact_path.write_bytes(b"artifact")
        services.database.execute(
            """
            INSERT INTO platform_artifacts (
              id, run_id, project_id, name, content_type, path, created_at
            ) VALUES ('art-ret', ?, 'proj-ret', 'expired', 'image/png', ?, ?)
            """,
            (run_id, str(artifact_path), _old(30)),
        )
        services.database.execute(
            """
            INSERT INTO audit_events (
              id, workspace_id, actor_type, actor_id, action, target_type,
              target_id, detail, created_at
            ) VALUES ('audit-ret', 'ws-ret', 'user', 'u', 'act', 't', 'id',
                      '{}', ?)
            """,
            (_old(200),),
        )
        services.database.execute(
            """
            INSERT INTO platform_run_events (
              run_id, kind, data, created_at
            ) VALUES (?, 'run.complete', '{}', ?)
            """,
            (run_id, _old(100)),
        )
        services.database.execute(
            """
            INSERT INTO flow_outputs (
              id, run_id, name, value, source, created_at
            ) VALUES ('out-ret', ?, 'name', 'value', 'flow', ?)
            """,
            (run_id, _old(100)),
        )

        summary = services.retention_cleanup(
            audit_days=180, run_days=90, artifact_days=15, dry_run=False
        )
        assert summary["artifacts"] == 1
        assert summary["runs"] == 1
        assert summary["auditEvents"] == 1
        assert summary["runEvents"] == 1
        assert summary["flowOutputs"] == 1
        assert not artifact_path.exists()
        assert services.database.execute(
            "SELECT COUNT(*) FROM platform_runs WHERE id = ?", (run_id,)
        ).fetchone()[0] == 0
        assert services.database.execute(
            "SELECT COUNT(*) FROM platform_artifacts WHERE id = 'art-ret'"
        ).fetchone()[0] == 0
        assert services.database.execute(
            "SELECT COUNT(*) FROM audit_events WHERE id = 'audit-ret'"
        ).fetchone()[0] == 0
    finally:
        services.close()
