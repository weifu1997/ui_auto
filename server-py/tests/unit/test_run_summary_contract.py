"""P1-5: run list / dispatch must return lean server-computed summaries.

Bug under test (audit P1-5): GET /runs and POST /runs (dispatch) build each row
through ``run_response``/``run_by_id`` — one full-row query plus agent +
artifacts + events + flow_outputs lookups per run, embedding the whole frozen
snapshot and up to 500 events per item into the JSON body. For a page of 100 or
a dataset dispatch of up to 1000 rows this is 4N queries and a huge payload,
even though the frontend derives only flowName / totalSteps / completedSteps /
progress / screenshotCount from that data and discards the rest (the detail page
re-fetches full state via GET /runs/{id}).

Fix contract (user-approved): GET /runs and POST /runs return per-run summaries
computed server-side with a constant number of queries (no N+1); detail stays
full. Summary items carry identity/status/time fields plus flowName,
environmentName, totalSteps, completedSteps, progress, screenshotCount — and do
NOT embed ``snapshot`` / ``events`` / ``artifacts`` / ``flowOutputs`` / ``result``.
"""

from autoflow.core import json, now
from autoflow.services import AuthUser, PlatformServices


def _setup(services) -> str:
    user = AuthUser("owner-summary", "owner@summary.test", "Owner")
    services.database.execute(
        """
        INSERT INTO platform_users (id, email, name, created_at)
        VALUES (?, ?, ?, ?)
        """,
        (user.id, user.email, user.name, "2026-08-22T00:00:00.000Z"),
    )
    workspace = services.create_workspace(user, "Summary workspace")
    project_id = "project-summary"
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
            "2026-08-22T00:00:00.000Z",
            "2026-08-22T00:00:00.000Z",
        ),
    )
    flow_steps = [
        {"id": f"step-{index}"} for index in range(1, 4)  # totalSteps = 3
    ]
    services.database.execute(
        """
        INSERT INTO flow_revisions (
          id, project_id, flow_id, flow_name, environment_id,
          revision_number, status, flow_snapshot, environment_snapshot,
          element_snapshot, dataset_snapshot, checksum, created_by,
          created_at, published_at
        ) VALUES (?, ?, ?, ?, ?, 1, 'published', ?, ?, '[]', '{}', ?, ?, ?, ?)
        """,
        (
            "revision-summary",
            project_id,
            "flow-1",
            "Flow flow-1",
            "env-1",
            json({"id": "flow-1", "name": "Flow flow-1", "steps": flow_steps}),
            json({"id": "env-1", "name": "Env", "browser": "Chromium"}),
            "checksum-revision-summary",
            "owner-summary",
            "2026-08-22T00:00:00.000Z",
            "2026-08-22T00:00:00.000Z",
        ),
    )
    services.enqueue_managed_run = lambda run_id: None  # type: ignore[method-assign]
    return project_id


def _dispatch_one(services, project_id, dispatch_key) -> str:
    return services.queue_published_runs(
        {
            "projectId": project_id,
            "flowId": "flow-1",
            "environmentId": "env-1",
            "createdBy": "owner-summary",
            "source": "manual",
            "dispatchKey": dispatch_key,
        }
    )["runIds"][0]


def _add_event(services, run_id, kind) -> None:
    services.database.execute(
        """
        INSERT INTO platform_run_events (run_id, kind, data, created_at)
        VALUES (?, ?, ?, ?)
        """,
        (run_id, kind, "{}", now()),
    )


def _add_artifact(services, run_id, project_id, content_type) -> None:
    services.database.execute(
        """
        INSERT INTO platform_artifacts (
          id, run_id, project_id, name, content_type, path, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            f"artifact-{run_id}-{content_type}",
            run_id,
            project_id,
            "screenshot.png",
            content_type,
            "/tmp/screenshot.png",
            now(),
        ),
    )


def test_run_summaries_are_lean_and_ordered(tmp_path):
    services = PlatformServices(str(tmp_path))
    try:
        project_id = _setup(services)
        run_a = _dispatch_one(services, project_id, "k-a")
        run_b = _dispatch_one(services, project_id, "k-b")
        run_c = _dispatch_one(services, project_id, "k-c")

        # run_a: success + 2 completed steps + 1 image artifact
        _add_event(services, run_a, "step.completed")
        _add_event(services, run_a, "step.completed")
        _add_artifact(services, run_a, project_id, "image/png")
        services.database.execute(
            "UPDATE platform_runs SET status = 'success' WHERE id = ?", (run_a,)
        )
        # run_b: still running + 1 completed step + 1 non-image artifact
        _add_event(services, run_b, "step.completed")
        _add_artifact(services, run_b, project_id, "text/plain")
        services.database.execute(
            "UPDATE platform_runs SET status = 'running' WHERE id = ?", (run_b,)
        )
        # run_c: queued, nothing else

        summaries = services.run_summaries(project_id, [run_c, run_b, run_a])

        # order is preserved, lean shape, and derived progress is server-side.
        assert [item["id"] for item in summaries] == [run_c, run_b, run_a]

        by_id = {item["id"]: item for item in summaries}
        for item in summaries:
            assert "events" not in item
            assert "artifacts" not in item
            assert "flowOutputs" not in item
            assert "snapshot" not in item
            assert "result" not in item
            assert item["flowName"] == "Flow flow-1"
            assert item["environmentName"] == "Env"
            assert item["totalSteps"] == 3

        # success → completed == total; running → live event count; queued → 0.
        assert by_id[run_a]["completedSteps"] == 3
        assert by_id[run_a]["progress"] == 100
        assert by_id[run_a]["screenshotCount"] == 1
        assert by_id[run_b]["completedSteps"] == 1
        assert by_id[run_b]["progress"] == 33
        assert by_id[run_b]["screenshotCount"] == 0
        assert by_id[run_c]["completedSteps"] == 0
        assert by_id[run_c]["progress"] == 0
        assert by_id[run_c]["screenshotCount"] == 0
    finally:
        services.close()
