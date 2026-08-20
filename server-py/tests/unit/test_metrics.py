from autoflow.core import now
from autoflow.services import PlatformServices


def _seed_runs(services: PlatformServices) -> None:
    services.database.execute(
        "INSERT INTO workspaces (id, name, created_at) VALUES ('ws-m', 'Metrics', ?)",
        (now(),),
    )
    services.database.execute(
        """
        INSERT INTO platform_projects (
          id, workspace_id, slug, name, description, created_at, updated_at
        ) VALUES ('proj-m', 'ws-m', 'proj-m', 'Metrics', '', ?, ?)
        """,
        (now(), now()),
    )
    services.database.execute(
        """
        INSERT INTO agents (
          id, workspace_id, name, credential_hash, status, browser_version,
          os, max_concurrency, created_at
        ) VALUES ('agent-m', 'ws-m', 'Agent', 'hash', 'online', 'Chromium',
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
        ) VALUES ('rev-m', 'proj-m', 1, 'published', '{}', '{}', '[]',
                  '{}', 'checksum', 'user-m', ?)
        """,
        (now(),),
    )
    for run_id, status in (("run-1", "queued"), ("run-2", "running"), ("run-3", "success")):
        services.database.execute(
            """
            INSERT INTO platform_runs (
              id, project_id, revision_id, environment_id, agent_id, executor_type,
              status, snapshot, created_by, created_at, updated_at
            ) VALUES (?, 'proj-m', 'rev-m', 'env-1', 'agent-m', 'managed',
                      ?, '{}', 'user-m', ?, ?)
            """,
            (run_id, status, now(), now()),
        )


def test_metrics_reports_run_and_delivery_counts(tmp_path):
    services = PlatformServices(str(tmp_path))
    try:
        _seed_runs(services)
        metrics = services.metrics()
        assert metrics["runs"] == {"queued": 1, "running": 1, "success": 1}
        assert metrics["deliveries"] == {}
        assert metrics["disk"] is not None
        assert "artifactBytes" in metrics
    finally:
        services.close()
