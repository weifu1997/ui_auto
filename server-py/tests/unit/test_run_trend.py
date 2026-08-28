"""阶段4-R4-1：运行趋势端点（GET .../runs/trend）与 run_trend 聚合。

覆盖：
- 逐日聚合：success/failed 按 created_at 日期分桶，run 计数与断言计数正确；
- 口径一致：仅 success/failed 终态 run 纳入；无断言 run 不进断言分子分母；
  canceled/queued/running 不纳入；
- 窗口：window_days 含无数据日（连续 x 轴）；全量窗口返回所有历史日；
- 空库：points 为空列表；
- 鉴权：403 无项目访问权 / 404 项目不存在；
- payload 只聚合计数，不落 actual/secret 值。
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import Request

from autoflow.core import now
from autoflow.handler import create_platform_router
from autoflow.http import PlatformError
from autoflow.services import AuthUser, PlatformServices

PROJECT_ID = "proj-trend"
TREND_ROUTE = "/api/platform/projects/{project_id}/runs/trend"


def _seed_services(tmp_path) -> tuple[PlatformServices, dict]:
    services = PlatformServices(str(tmp_path))
    admin = services.bootstrap_super_admin(
        "trend-admin@example.test", "Trend Admin", "trend-password"
    )
    session = services.create_auth_session(admin)
    workspace = services.create_workspace(admin, "Trend workspace")
    services.database.execute(
        """
        INSERT INTO platform_projects (
          id, workspace_id, slug, name, description, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            PROJECT_ID,
            workspace["id"],
            PROJECT_ID,
            "Trend project",
            "",
            now(),
            now(),
        ),
    )
    # platform_runs 外键：agent / revision / environment 需先存在。
    services.database.execute(
        """
        INSERT INTO agents (
          id, workspace_id, name, credential_hash, status, browser_version,
          os, max_concurrency, created_at
        ) VALUES ('agent-trend', ?, 'Trend agent', 'hash', 'online', 'Chromium',
                  'linux', 1, ?)
        """,
        (workspace["id"], now()),
    )
    services.database.execute(
        """
        INSERT INTO flow_revisions (
          id, project_id, revision_number, status, flow_snapshot,
          environment_snapshot, element_snapshot, dataset_snapshot,
          checksum, created_by, created_at
        ) VALUES ('rev-trend', ?, 1, 'published', '{}', '{}', '[]',
                  '{}', 'checksum', 'user-trend', ?)
        """,
        (PROJECT_ID, now()),
    )
    return services, session


def _iso(days_ago: int, hour: int = 10) -> str:
    value = datetime.now(timezone.utc) - timedelta(days=days_ago)
    value = value.replace(hour=hour, minute=0, second=0, microsecond=0)
    return value.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _seed_run(
    services: PlatformServices,
    run_id: str,
    status: str,
    created_at: str,
    *,
    assertions: list[dict] | None = None,
) -> None:
    result: dict = {"status": status}
    if assertions is not None:
        result["assertions"] = assertions
    services.database.execute(
        """
        INSERT INTO platform_runs (
          id, project_id, revision_id, environment_id, agent_id, executor_type,
          status, snapshot, result, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            run_id,
            PROJECT_ID,
            "rev-trend",
            "env-trend",
            "agent-trend",
            "managed",
            status,
            json.dumps({"flow": {"id": "f", "name": "流程"}, "environment": {"id": "e", "name": "环境"}}, ensure_ascii=False),
            json.dumps(result, ensure_ascii=False),
            "user-trend",
            created_at,
            created_at,
        ),
    )


def _route(services: PlatformServices):
    router = create_platform_router(services)
    return next(
        route for route in router.routes if getattr(route, "path", None) == TREND_ROUTE
    )


def _call(route, *, token: str, query_string: bytes = b"", **path_params):
    async def run():
        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": "/api",
            "raw_path": b"/api",
            "query_string": query_string,
            "headers": [(b"authorization", f"Bearer {token}".encode())],
            "client": ("127.0.0.1", 1234),
            "server": ("127.0.0.1", 8787),
        }
        return await route.endpoint(Request(scope, receive=receive), **path_params)

    return asyncio.run(run())


def _seed_mixed_timeline(services: PlatformServices) -> None:
    """两天内的混合数据：成功/失败/取消/排队 run + 断言/无断言。"""
    _seed_run(
        services,
        "trend-run-1",
        "success",
        _iso(1, hour=9),
        assertions=[
            {"stepIndex": 0, "title": "文本", "type": "text", "passed": True},
            {"stepIndex": 1, "title": "数量", "type": "count", "passed": False},
        ],
    )
    _seed_run(
        services,
        "trend-run-2",
        "failed",
        _iso(1, hour=15),
        assertions=[{"stepIndex": 0, "title": "URL", "type": "url", "passed": True}],
    )
    # 无断言 run：进 run 计数，不进断言分子分母。
    _seed_run(services, "trend-run-3", "success", _iso(1, hour=18))
    # 非终态 run：不纳入（取消/排队/运行中）。
    _seed_run(services, "trend-run-canceled", "canceled", _iso(0, hour=1))
    _seed_run(services, "trend-run-queued", "queued", _iso(0, hour=2))
    _seed_run(services, "trend-run-running", "running", _iso(0, hour=3))
    # 今天：一个成功断言 run + 一个失败 run（无断言）。
    _seed_run(
        services,
        "trend-run-today",
        "success",
        _iso(0, hour=11),
        assertions=[{"stepIndex": 0, "title": "可见", "type": "visibility", "passed": True}],
    )
    _seed_run(services, "trend-run-today-fail", "failed", _iso(0, hour=20))


def test_run_trend_full_window_buckets(tmp_path):
    """全量窗口：按日分桶，仅终态 run 纳入；断言口径与 assertion_stats 一致。"""
    services, session = _seed_services(tmp_path)
    try:
        _seed_mixed_timeline(services)
        response = _call(_route(services), token=session["token"], project_id=PROJECT_ID)
        assert response.status_code == 200
        body = json.loads(response.body)
        assert body["windowDays"] is None
        assert len(body["points"]) == 2  # 昨天 + 今天，各一桶

        yesterday = body["points"][0]
        # 昨天：run-1(success, 2 断言) + run-2(failed, 1 断言) + run-3(success, 无断言)。
        assert yesterday["runTotal"] == 3
        assert yesterday["runPassed"] == 2
        assert yesterday["runFailed"] == 1
        assert yesterday["assertionTotal"] == 3
        assert yesterday["assertionPassed"] == 2

        today = body["points"][1]
        # 今天：run-today(success, 1 断言) + run-today-fail(failed, 无断言)。
        assert today["runTotal"] == 2
        assert today["runPassed"] == 1
        assert today["runFailed"] == 1
        assert today["assertionTotal"] == 1
        assert today["assertionPassed"] == 1
    finally:
        services.close()


def test_run_trend_window_includes_empty_days(tmp_path):
    """近 N 天窗口：含无数据日（连续 x 轴），返回 N 个桶。"""
    services, session = _seed_services(tmp_path)
    try:
        _seed_mixed_timeline(services)
        response = _call(
            _route(services),
            token=session["token"],
            query_string=b"window_days=7",
            project_id=PROJECT_ID,
        )
        assert response.status_code == 200
        body = json.loads(response.body)
        assert body["windowDays"] == 7
        assert len(body["points"]) == 7
        dates = [point["date"] for point in body["points"]]
        assert dates == sorted(dates)
        # 昨天/今天有数据，其余桶全零。
        zero = [point for point in body["points"] if point["runTotal"] == 0]
        assert len(zero) == 5
    finally:
        services.close()


def test_run_trend_window_excludes_day_before_calendar_start(tmp_path):
    """now-N*24h would include the previous calendar day; the axis must not."""
    services, session = _seed_services(tmp_path)
    try:
        _seed_run(services, "trend-too-old", "success", _iso(8, hour=18))
        _seed_run(services, "trend-today", "success", _iso(0, hour=12))
        response = _call(
            _route(services),
            token=session["token"],
            query_string=b"window_days=7",
            project_id=PROJECT_ID,
        )
        assert response.status_code == 200
        body = json.loads(response.body)
        dates = [point["date"] for point in body["points"]]
        assert len(dates) == 7
        assert _iso(8, hour=18)[:10] not in dates
        assert _iso(0, hour=12)[:10] in dates
    finally:
        services.close()


def test_run_trend_empty_project(tmp_path):
    """空库/无 run：points 为空列表。"""
    services, session = _seed_services(tmp_path)
    try:
        response = _call(_route(services), token=session["token"], project_id=PROJECT_ID)
        assert response.status_code == 200
        body = json.loads(response.body)
        assert body["points"] == []
    finally:
        services.close()


def test_run_trend_payload_has_no_actual_or_secret(tmp_path):
    """payload 只聚合计数：不落断言 actual / secret 明文。"""
    services, session = _seed_services(tmp_path)
    try:
        _seed_run(
            services,
            "trend-run-secret",
            "failed",
            _iso(0, hour=8),
            assertions=[
                {"stepIndex": 0, "title": "含密钥", "type": "text",
                 "passed": False, "actual": "token=s3cret-plaintext"}
            ],
        )
        response = _call(_route(services), token=session["token"], project_id=PROJECT_ID)
        assert response.status_code == 200
        payload = response.body.decode("utf-8")
        assert "s3cret-plaintext" not in payload
        assert "actual" not in payload
    finally:
        services.close()


def test_run_trend_validation_and_auth(tmp_path):
    """400 非法 window_days / 404 项目不存在 / 403 无项目访问权。"""
    services, session = _seed_services(tmp_path)
    try:
        route = _route(services)
        with pytest.raises(PlatformError) as error:
            _call(
                route,
                token=session["token"],
                query_string=b"window_days=abc",
                project_id=PROJECT_ID,
            )
        assert error.value.status == 400
        assert error.value.code == "WINDOW_DAYS_INVALID"

        with pytest.raises(PlatformError) as error:
            _call(route, token=session["token"], project_id="proj-missing")
        assert error.value.status == 404

        stranger = AuthUser("stranger-trend", "stranger@example.test", "Stranger")
        services.database.execute(
            """
            INSERT INTO platform_users (id, email, name, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (stranger.id, stranger.email, stranger.name, now()),
        )
        stranger_session = services.create_auth_session(stranger)
        with pytest.raises(PlatformError) as error:
            _call(
                route,
                token=stranger_session["token"],
                project_id=PROJECT_ID,
            )
        assert error.value.status == 403
    finally:
        services.close()
