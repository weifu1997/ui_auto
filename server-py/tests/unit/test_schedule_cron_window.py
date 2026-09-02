"""Regression tests for the cron-advance window and schedule fire storms.

Two bugs reproduced here feed each other:

1. ``next_cron_time`` scans forward minute-by-minute but gives up after 5000
   minutes (~3.47 days). Weekly/monthly crons — next fire a week or more out —
   therefore raise ``SCHEDULE_CRON_INVALID`` even though the expression is
   perfectly valid.

2. ``process_due_schedules`` queues a run *first* and only then advances the
   schedule. When advancing raises (as in 1), its fallback pushes
   ``next_run_at`` forward by a flat 60s. The dispatch key embeds
   ``next_run_at``, so every subsequent tick mints a fresh key and bypasses the
   ``(dispatch_key, project_id)`` dedup in ``insert_run_from_spec`` — one brand
   new run per tick, forever, with the schedule never disabled.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from autoflow.core import cron_matches, json, next_cron_time
from autoflow.http import PlatformError
from autoflow.services import AuthUser, PlatformServices


def _iso(value: datetime) -> str:
    return value.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _iso_from(value: datetime) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _upcoming_monday_0900_utc() -> datetime:
    """A Monday 09:00 UTC that is strictly in the future."""
    today = datetime.now(timezone.utc).date()
    days_ahead = (0 - today.weekday()) % 7  # datetime: Monday == 0
    if days_ahead == 0:
        days_ahead = 7
    day = today + timedelta(days=days_ahead)
    return datetime(day.year, day.month, day.day, 9, 0, tzinfo=timezone.utc)


def test_next_cron_time_weekly_cron_resolves_next_week():
    """A weekly schedule must advance to next week, not raise as 'invalid'."""
    base = _upcoming_monday_0900_utc()  # e.g. a fire that just happened
    got = next_cron_time("0 9 * * 1", "UTC", from_time=base)
    expected = base + timedelta(days=7)
    assert got == _iso(expected)
    assert cron_matches("0 9 * * 1", _iso_from(got), "UTC")


def _setup_services(tmp_path):
    services = PlatformServices(str(tmp_path))
    user = AuthUser("owner-1", "owner@example.test", "Owner")
    services.database.execute(
        """
        INSERT INTO platform_users (id, email, name, created_at)
        VALUES (?, ?, ?, ?)
        """,
        (user.id, user.email, user.name, "2026-08-22T00:00:00.000Z"),
    )
    workspace = services.create_workspace(user, "Schedule workspace")
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
            "2026-08-22T00:00:00.000Z",
            "2026-08-22T00:00:00.000Z",
        ),
    )
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
            "revision-a",
            project_id,
            "flow-1",
            "Flow flow-1",
            "env-1",
            json({"id": "flow-1", "name": "Flow flow-1", "steps": [{"id": "a-1"}]}),
            json({"id": "env-1", "name": "Env", "browser": "Chromium"}),
            "checksum-revision-a",
            "owner-1",
            "2026-08-22T00:00:00.000Z",
            "2026-08-22T00:00:00.000Z",
        ),
    )
    services.enqueue_managed_run = lambda run_id: None
    return services, project_id


def _insert_due_schedule(services, project_id, *, next_run_at: str) -> None:
    services.database.execute(
        """
        INSERT INTO schedules (
          id, project_id, revision_id, environment_id, dataset_version_id,
          name, cron_expression, timezone, enabled, next_run_at,
          created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 1, ?, ?, ?, ?)
        """,
        (
            "sched-1",
            project_id,
            "revision-a",
            "env-1",
            "Weekly schedule",
            "0 9 * * 1",
            "UTC",
            next_run_at,
            "owner-1",
            "2026-08-22T00:00:00.000Z",
            "2026-08-22T00:00:00.000Z",
        ),
    )


def _run_count(services, project_id) -> int:
    return services.database.execute(
        "SELECT COUNT(*) FROM platform_runs WHERE project_id = ?",
        (project_id,),
    ).fetchone()[0]


def _schedule_enabled(services) -> int:
    return services.database.execute(
        "SELECT enabled FROM schedules WHERE id = 'sched-1'"
    ).fetchone()[0]


def test_due_schedule_that_cannot_advance_is_disabled_not_stormed(monkeypatch, tmp_path):
    """When the next fire cannot be computed, one due tick must disable the
    schedule instead of minting a fresh dispatch key every 60s and queueing a
    new run each time (a run per tick that never stops)."""
    import autoflow.services.schedules as schedules_mod

    services, project_id = _setup_services(tmp_path)
    try:
        _insert_due_schedule(services, project_id, next_run_at="2000-01-01T00:00:00.000Z")

        # 用假时钟把“无法推进”变成确定性的：next_cron_time 总是抛错，
        # 代表一个永远到不了下一次触发的 cron。
        clock = {"t": datetime(2000, 1, 1, tzinfo=timezone.utc)}

        def fake_now() -> str:
            return _iso(clock["t"])

        def boom_advance(expression: str, time_zone: str, from_time=None) -> str:
            raise PlatformError(400, "SCHEDULE_CRON_INVALID")

        monkeypatch.setattr(schedules_mod, "now", fake_now)
        monkeypatch.setattr(schedules_mod, "next_cron_time", boom_advance)

        for _ in range(3):
            clock["t"] += timedelta(minutes=1)
            services.process_due_schedules()

        # 修复后的预期：第一个到期 tick 就禁用调度，一次也不排队。
        assert _run_count(services, project_id) == 0
        assert _schedule_enabled(services) == 0
    finally:
        services.close()
