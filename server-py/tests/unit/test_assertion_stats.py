"""Stage G3: 断言聚合视图端点（GET .../assertion-stats）与 batch detail 断言计数。

覆盖（对应 implement.md G3 gate）：
- 聚合查询：含/不含断言 run、混合状态；
- 口径校验：断言端点结果与全量 run 一致，不随分页参数变化（端点无分页概念，
  全量扫描；显式带 page/pageSize 参数响应不变）；
- windowDays 窗口过滤 + 非法 windowDays 400；
- batch detail 跨子 run 断言计数（口径同全项目，只统计含断言的子 run）；
- 403 / 404。
"""

from __future__ import annotations

import asyncio
import json

import pytest
from fastapi import Request

from autoflow.core import days_ago_iso, now
from autoflow.handler import create_platform_router
from autoflow.http import PlatformError
from autoflow.services import AuthUser, PlatformServices

PROJECT_ID = "proj-stats"
STATS_ROUTE = "/api/platform/projects/{project_id}/assertion-stats"
BATCH_DETAIL_ROUTE = (
    "/api/platform/projects/{project_id}/run-batches/{batch_id}"
)


def _seed_services(tmp_path) -> tuple[PlatformServices, dict]:
    services = PlatformServices(str(tmp_path))
    admin = services.bootstrap_super_admin(
        "stats-admin@example.test", "Stats Admin", "stats-password"
    )
    session = services.create_auth_session(admin)
    workspace = services.create_workspace(admin, "Stats workspace")
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
            "Stats project",
            "",
            now(),
            now(),
        ),
    )
    services.database.execute(
        """
        INSERT INTO agents (
          id, workspace_id, name, credential_hash, status, browser_version,
          os, max_concurrency, created_at
        ) VALUES ('agent-stats', ?, 'Stats agent', 'hash', 'online', 'Chromium',
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
        ) VALUES ('rev-stats', ?, 1, 'published', '{}', '{}', '[]',
                  '{}', 'checksum', 'user-stats', ?)
        """,
        (PROJECT_ID, now()),
    )
    return services, session


def _seed_run(
    services: PlatformServices,
    run_id: str,
    *,
    status: str = "success",
    assertions: list[dict] | None = None,
    created_at: str | None = None,
    batch_id: str | None = None,
    batch_item_index: int | None = None,
) -> None:
    result = {"status": status}
    if assertions is not None:
        result["assertions"] = assertions
    batch_sql = ""
    batch_params: list = []
    if batch_id is not None:
        batch_sql = ", batch_id, batch_item_index"
        batch_params = [batch_id, batch_item_index]
    services.database.execute(
        f"""
        INSERT INTO platform_runs (
          id, project_id, revision_id, environment_id, agent_id, executor_type,
          status, snapshot, result, created_by, created_at, updated_at
          {batch_sql}
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                  {", ?, ?" if batch_id is not None else ""})
        """,
        (
            run_id,
            PROJECT_ID,
            "rev-stats",
            "env-stats",
            "agent-stats",
            "managed",
            status,
            json.dumps({"flow": {"name": "Flow"}}, ensure_ascii=False),
            json.dumps(result, ensure_ascii=False),
            "user-stats",
            created_at or now(),
            created_at or now(),
            *batch_params,
        ),
    )


def _route(services: PlatformServices, path: str):
    router = create_platform_router(services)
    return next(
        route for route in router.routes if getattr(route, "path", None) == path
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


def _assertion(passed: bool) -> dict:
    return {
        "stepIndex": 0,
        "stepId": "s1",
        "title": "断言",
        "type": "text",
        "passed": passed,
        "expected": "x",
        "actual": "y",
        "durationMs": 1,
    }


def test_assertion_stats_mixed_runs(tmp_path):
    """聚合：含断言 run 计数 + 混合状态；无断言 run 不进分子分母。"""
    services, session = _seed_services(tmp_path)
    try:
        _seed_run(services, "run-a", assertions=[_assertion(True), _assertion(False)])
        _seed_run(services, "run-b", assertions=[_assertion(True)])
        _seed_run(services, "run-c", status="failed")  # 无断言
        _seed_run(services, "run-d", assertions=[])  # 空断言数组
        _seed_run(services, "run-e", status="canceled")  # 无断言

        response = _call(
            _route(services, STATS_ROUTE),
            token=session["token"],
            project_id=PROJECT_ID,
        )
        assert response.status_code == 200
        stats = json.loads(response.body)
        assert stats["runsWithAssertions"] == 2
        assert stats["totalAssertions"] == 3
        assert stats["passedAssertions"] == 2
        assert stats["failedAssertions"] == 1
        assert stats["windowDays"] is None
    finally:
        services.close()


def test_assertion_stats_not_page_dependent(tmp_path):
    """口径校验：端点全量扫描，分页参数不影响结果。"""
    services, session = _seed_services(tmp_path)
    try:
        for index in range(4):
            passed = index % 2 == 0
            _seed_run(
                services,
                f"run-page-{index}",
                assertions=[_assertion(passed), _assertion(True)],
            )

        route = _route(services, STATS_ROUTE)
        baseline = json.loads(
            _call(route, token=session["token"], project_id=PROJECT_ID).body
        )
        # 带任意分页参数：响应与不带分页完全一致（端点不消费分页参数）。
        paged = json.loads(
            _call(
                route,
                token=session["token"],
                query_string=b"page=1&pageSize=1",
                project_id=PROJECT_ID,
            ).body
        )
        assert paged == baseline
        assert baseline["runsWithAssertions"] == 4
        assert baseline["totalAssertions"] == 8
        assert baseline["passedAssertions"] == 6  # 4 条 (passed) + 4 条 (True)
    finally:
        services.close()


def test_assertion_stats_window_days(tmp_path):
    """windowDays 窗口过滤 + 非法值 400。"""
    services, session = _seed_services(tmp_path)
    try:
        old_created = days_ago_iso(30)
        _seed_run(services, "run-old", assertions=[_assertion(True)], created_at=old_created)
        _seed_run(services, "run-new", assertions=[_assertion(True), _assertion(False)])

        route = _route(services, STATS_ROUTE)
        # 全量：2 runs / 3 断言。
        full = json.loads(_call(route, token=session["token"], project_id=PROJECT_ID).body)
        assert full["runsWithAssertions"] == 2
        assert full["totalAssertions"] == 3

        # 7 天窗口：只剩新 run。
        scoped = json.loads(
            _call(
                route,
                token=session["token"],
                query_string=b"windowDays=7",
                project_id=PROJECT_ID,
            ).body
        )
        assert scoped["runsWithAssertions"] == 1
        assert scoped["totalAssertions"] == 2
        assert scoped["passedAssertions"] == 1
        assert scoped["failedAssertions"] == 1
        assert scoped["windowDays"] == 7

        # 非法窗口：0 / 负数 / 非数字 → 400。
        for bad in (b"windowDays=0", b"windowDays=-1", b"windowDays=abc"):
            with pytest.raises(PlatformError) as error:
                _call(
                    route,
                    token=session["token"],
                    query_string=bad,
                    project_id=PROJECT_ID,
                )
            assert error.value.status == 400
            assert error.value.code == "WINDOW_DAYS_INVALID"
    finally:
        services.close()


def test_assertion_stats_status_codes(tmp_path):
    """403（无工作区访问权）/ 404（项目不存在）。"""
    services, session = _seed_services(tmp_path)
    try:
        stranger = AuthUser("stranger-stats", "stranger-stats@example.test", "Stranger")
        services.database.execute(
            """
            INSERT INTO platform_users (id, email, name, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (stranger.id, stranger.email, stranger.name, now()),
        )
        stranger_session = services.create_auth_session(stranger)
        route = _route(services, STATS_ROUTE)
        with pytest.raises(PlatformError) as error:
            _call(route, token=stranger_session["token"], project_id=PROJECT_ID)
        assert error.value.status == 403

        with pytest.raises(PlatformError) as error:
            _call(route, token=session["token"], project_id="proj-missing")
        assert error.value.status == 404
    finally:
        services.close()


def test_batch_detail_assertion_stats(tmp_path):
    """batch detail：跨子 run 断言计数（口径同全项目，只统计含断言的子 run）
    + 失败断言明细（actual 脱敏）。"""
    services, session = _seed_services(tmp_path)
    try:
        services.database.execute(
            """
            INSERT INTO run_batches (
              id, project_id, environment_id, client_request_id, source,
              retry_of_batch_id, requested_flow_ids, cancellation_requested,
              created_by, created_at, updated_at
            ) VALUES (?, ?, 'env-stats', 'batch-client-1', 'manual',
                      NULL, '["flow-1","flow-2"]', 0, 'user-stats', ?, ?)
            """,
            ("batch-stats", PROJECT_ID, now(), now()),
        )
        encrypted = services.encrypt("batch-secret-99")
        services.database.execute(
            """
            INSERT INTO project_secrets (
              id, project_id, name, key_version, iv, tag, ciphertext,
              created_at, updated_at
            ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
            """,
            (
                "secret-stats",
                PROJECT_ID,
                "TOKEN",
                encrypted["iv"],
                encrypted["tag"],
                encrypted["ciphertext"],
                now(),
                now(),
            ),
        )
        failed_assertion = dict(
            _assertion(False),
            title="失败断言",
            expected="expect-val",
            actual="token=batch-secret-99 leak",
        )
        _seed_run(
            services,
            "sub-run-1",
            assertions=[_assertion(True), failed_assertion],
            batch_id="batch-stats",
            batch_item_index=0,
        )
        _seed_run(
            services,
            "sub-run-2",
            assertions=[_assertion(True)],
            batch_id="batch-stats",
            batch_item_index=1,
        )
        _seed_run(
            services,
            "sub-run-3",
            status="failed",  # 无断言，不进分子分母
            batch_id="batch-stats",
            batch_item_index=2,
        )

        response = _call(
            _route(services, BATCH_DETAIL_ROUTE),
            token=session["token"],
            project_id=PROJECT_ID,
            batch_id="batch-stats",
        )
        assert response.status_code == 200
        body = json.loads(response.body)
        assert body["assertionStats"] == {
            "runsWithAssertions": 2,
            "totalAssertions": 3,
            "passedAssertions": 2,
            "failedAssertions": 1,
        }
        failures = body["assertionFailures"]
        assert len(failures) == 1
        assert failures[0]["runId"] == "sub-run-1"
        assert failures[0]["flowName"] == "Flow"
        assert failures[0]["title"] == "失败断言"
        assert failures[0]["expected"] == "expect-val"
        assert failures[0]["actual"] == "token=*** leak"  # 脱敏
        assert "batch-secret-99" not in json.dumps(body, ensure_ascii=False)
    finally:
        services.close()
