from autoflow.core import json
from autoflow.http import PlatformError
from autoflow.services import AuthUser, PlatformServices


def _setup_services(tmp_path):
    services = PlatformServices(str(tmp_path))
    user = AuthUser("owner-1", "owner@example.test", "Owner")
    services.database.execute(
        """
        INSERT INTO platform_users (id, email, name, created_at)
        VALUES (?, ?, ?, ?)
        """,
        (user.id, user.email, user.name, "2026-08-16T00:00:00.000Z"),
    )
    workspace = services.create_workspace(user, "Revision workspace")
    project_id = "project-1"
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
            "2026-08-16T00:00:00.000Z",
            "2026-08-16T00:00:00.000Z",
        ),
    )
    services.enqueue_managed_run = lambda run_id: None
    return services, project_id


def _insert_revision(
    services,
    project_id,
    revision_id,
    flow_id,
    environment_id="env-1",
    status="published",
    published_at="2026-08-16T00:00:00.000Z",
    revision_number=None,
    steps=(),
):
    if revision_number is None:
        revision_number = 1 + services.database.execute(
            "SELECT COUNT(*) FROM flow_revisions WHERE project_id = ?",
            (project_id,),
        ).fetchone()[0]
    services.database.execute(
        """
        INSERT INTO flow_revisions (
          id, project_id, flow_id, flow_name, environment_id,
          revision_number, status, flow_snapshot, environment_snapshot,
          element_snapshot, dataset_snapshot, checksum, created_by,
          created_at, published_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            revision_id,
            project_id,
            flow_id,
            f"Flow {flow_id}",
            environment_id,
            revision_number,
            status,
            json({"id": flow_id, "name": f"Flow {flow_id}", "steps": list(steps)}),
            json({"id": environment_id, "name": "Env", "browser": "Chromium"}),
            "[]",
            "{}",
            f"checksum-{revision_id}",
            "owner-1",
            published_at,
            published_at,
        ),
    )


def _run_count(services, project_id):
    return services.database.execute(
        "SELECT COUNT(*) FROM platform_runs WHERE project_id = ?",
        (project_id,),
    ).fetchone()[0]


def _queued_flow_id(queued):
    assert len(queued["runIds"]) == 1
    return queued["revision"]["id"]


def test_flow_scoped_run_selects_entry_flow_revision(tmp_path):
    services, project_id = _setup_services(tmp_path)
    try:
        _insert_revision(
            services, project_id, "revision-a", "flow-a",
            published_at="2026-08-16T10:00:00.000Z",
            steps=[{"id": "a-1"}],
        )
        _insert_revision(
            services, project_id, "revision-b", "flow-b",
            published_at="2026-08-16T11:00:00.000Z",
            steps=[{"id": "b-1"}],
        )
        queued_a = services.queue_published_runs(
            {"projectId": project_id, "flowId": "flow-a", "environmentId": "env-1",
             "createdBy": "owner-1", "source": "manual"}
        )
        assert _queued_flow_id(queued_a) == "revision-a"
        run = services.run_by_id(queued_a["runIds"][0])
        snapshot = json.loads(run["snapshot"]) if isinstance(run["snapshot"], str) else run["snapshot"]
        assert snapshot["flow"]["id"] == "flow-a"
        assert snapshot["flowRevisionId"] == "revision-a"

        queued_b = services.queue_published_runs(
            {"projectId": project_id, "flowId": "flow-b", "environmentId": "env-1",
             "createdBy": "owner-1", "source": "manual"}
        )
        assert _queued_flow_id(queued_b) == "revision-b"
    finally:
        services.close()


def test_run_without_flow_context_or_revision_rejected(tmp_path):
    services, project_id = _setup_services(tmp_path)
    try:
        _insert_revision(services, project_id, "revision-a", "flow-a")
        try:
            services.queue_published_runs(
                {"projectId": project_id, "environmentId": "env-1",
                 "createdBy": "owner-1", "source": "manual"}
            )
            raise AssertionError("missing flow context must be rejected")
        except PlatformError as exc:
            assert exc.status == 400
            assert exc.code == "FLOW_ID_REQUIRED"
        assert _run_count(services, project_id) == 0
    finally:
        services.close()


def test_revision_flow_mismatch_rejected(tmp_path):
    services, project_id = _setup_services(tmp_path)
    try:
        _insert_revision(services, project_id, "revision-b", "flow-b")
        try:
            services.queue_published_runs(
                {"projectId": project_id, "revisionId": "revision-b",
                 "flowId": "flow-a", "environmentId": "env-1",
                 "createdBy": "owner-1", "source": "manual"}
            )
            raise AssertionError("flow/revision mismatch must be rejected")
        except PlatformError as exc:
            assert exc.status == 409
            assert exc.code == "REVISION_FLOW_MISMATCH"
        assert _run_count(services, project_id) == 0
    finally:
        services.close()


def test_flow_without_published_revision_in_environment_rejected(tmp_path):
    services, project_id = _setup_services(tmp_path)
    try:
        _insert_revision(services, project_id, "revision-a", "flow-a")
        _insert_revision(
            services, project_id, "revision-b2", "flow-b", environment_id="env-2"
        )
        try:
            services.queue_published_runs(
                {"projectId": project_id, "flowId": "flow-b", "environmentId": "env-1",
                 "createdBy": "owner-1", "source": "manual"}
            )
            raise AssertionError("no published revision must be rejected")
        except PlatformError as exc:
            assert exc.status == 409
            assert exc.code == "PUBLISHED_REVISION_REQUIRED"

        try:
            services.queue_published_runs(
                {"projectId": project_id, "flowId": "flow-c", "environmentId": "env-1",
                 "createdBy": "owner-1", "source": "manual"}
            )
            raise AssertionError("unknown flow must be rejected")
        except PlatformError as exc:
            assert exc.status == 409
            assert exc.code == "PUBLISHED_REVISION_REQUIRED"
        assert _run_count(services, project_id) == 0
    finally:
        services.close()


def test_retry_uses_original_superseded_revision_snapshot(tmp_path):
    services, project_id = _setup_services(tmp_path)
    try:
        _insert_revision(
            services, project_id, "revision-a1", "flow-a",
            status="superseded", published_at="2026-08-16T10:00:00.000Z",
            revision_number=1, steps=[{"id": "a-1"}],
        )
        _insert_revision(
            services, project_id, "revision-a2", "flow-a",
            published_at="2026-08-16T11:00:00.000Z",
            revision_number=2, steps=[{"id": "a-1"}, {"id": "a-2"}],
        )
        try:
            services.queue_published_runs(
                {"projectId": project_id, "revisionId": "revision-a1",
                 "environmentId": "env-1", "createdBy": "owner-1", "source": "manual"}
            )
            raise AssertionError("superseded revision must stay blocked by default")
        except PlatformError as exc:
            assert exc.status == 409
            assert exc.code == "PUBLISHED_REVISION_REQUIRED"

        queued = services.queue_published_runs(
            {"projectId": project_id, "revisionId": "revision-a1",
             "environmentId": "env-1", "createdBy": "owner-1", "source": "manual",
             "allowSuperseded": True}
        )
        assert queued["revision"]["id"] == "revision-a1"
        run = services.run_by_id(queued["runIds"][0])
        snapshot = json.loads(run["snapshot"]) if isinstance(run["snapshot"], str) else run["snapshot"]
        assert snapshot["flowRevisionId"] == "revision-a1"
        assert len(snapshot["flow"]["steps"]) == 1
    finally:
        services.close()


def test_up_to_step_must_belong_to_resolved_flow(tmp_path):
    services, project_id = _setup_services(tmp_path)
    try:
        _insert_revision(
            services, project_id, "revision-a", "flow-a",
            steps=[{"id": "a-1"}],
        )
        _insert_revision(
            services, project_id, "revision-b", "flow-b",
            steps=[{"id": "b-1"}],
        )
        try:
            services.queue_published_runs(
                {"projectId": project_id, "flowId": "flow-b", "environmentId": "env-1",
                 "upToStepId": "a-1", "createdBy": "owner-1", "source": "manual"}
            )
            raise AssertionError("cross-flow step id must be rejected")
        except PlatformError as exc:
            assert exc.status == 400
            assert exc.code == "RUN_STEP_NOT_FOUND"
        assert _run_count(services, project_id) == 0
    finally:
        services.close()


def test_explicit_revision_environment_mismatch_still_rejected(tmp_path):
    services, project_id = _setup_services(tmp_path)
    try:
        _insert_revision(services, project_id, "revision-a", "flow-a")
        try:
            services.queue_published_runs(
                {"projectId": project_id, "revisionId": "revision-a",
                 "environmentId": "env-2", "createdBy": "owner-1", "source": "manual"}
            )
            raise AssertionError("environment mismatch must be rejected")
        except PlatformError as exc:
            assert exc.status == 409
            assert exc.code == "REVISION_ENVIRONMENT_MISMATCH"
        assert _run_count(services, project_id) == 0
    finally:
        services.close()


def test_legacy_revision_flow_id_falls_back_to_snapshot(tmp_path):
    services, project_id = _setup_services(tmp_path)
    try:
        services.database.execute(
            """
            INSERT INTO flow_revisions (
              id, project_id, flow_id, flow_name, environment_id,
              revision_number, status, flow_snapshot, environment_snapshot,
              element_snapshot, dataset_snapshot, checksum, created_by,
              created_at, published_at
            ) VALUES (?, ?, NULL, NULL, ?, 1, 'published', ?, ?, '[]', '{}', ?, ?, ?, ?)
            """,
            (
                "revision-legacy",
                project_id,
                "env-1",
                json({"id": "flow-legacy", "name": "Legacy", "steps": [{"id": "s-1"}]}),
                json({"id": "env-1", "name": "Env", "browser": "Chromium"}),
                "checksum-legacy",
                "owner-1",
                "2026-08-16T00:00:00.000Z",
                "2026-08-16T00:00:00.000Z",
            ),
        )
        revision = services.published_revision_for(
            project_id, "revision-legacy", flow_id="flow-legacy"
        )
        assert revision["id"] == "revision-legacy"
        try:
            services.published_revision_for(
                project_id, "revision-legacy", flow_id="flow-other"
            )
            raise AssertionError("snapshot-derived flow mismatch must be rejected")
        except PlatformError as exc:
            assert exc.status == 409
            assert exc.code == "REVISION_FLOW_MISMATCH"
    finally:
        services.close()
