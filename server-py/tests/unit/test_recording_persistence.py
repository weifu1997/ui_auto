"""阶段2-C：D6 录制会话元数据落库 / 重启「已中断」终态 / 列表端点。

覆盖：迁移 v15 建表、协调器在创建/状态迁移/事件时同步元数据、recover_interrupted、
_require_session 对持久化会话的 DB 回退、list_sessions 分页与 owner 作用域、
GET 列表端点；以及无数据库提供者时持久化为 no-op（既有行为保持）。
"""

import json
import sqlite3

import pytest

from autoflow.http import PlatformError
from autoflow.migrations import run_platform_migrations
from autoflow.recorder import RecordingCoordinator

MINIMAL_LEGACY_SCHEMA = """
  CREATE TABLE IF NOT EXISTS webhook_triggers (id TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS datasets (id TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS notification_channels (id TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS agent_bindings (project_id TEXT, environment_id TEXT, agent_id TEXT);
  CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, workspace_id TEXT);
  CREATE TABLE IF NOT EXISTS platform_projects (id TEXT PRIMARY KEY, workspace_id TEXT);
  CREATE TABLE IF NOT EXISTS platform_users (id TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS project_documents (project_id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS flow_revisions (
    id TEXT PRIMARY KEY,
    flow_snapshot TEXT NOT NULL,
    environment_snapshot TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS platform_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
"""


class _StubFuture:
    def __init__(self, value):
        self._value = value

    def result(self, timeout=None):
        return self._value


class _ImmediateSubmit:
    """同步执行提交，模拟专用 Playwright 线程。"""

    def __call__(self, function, *args):
        return _StubFuture(function(*args))


class _StubContext:
    def __init__(self):
        self.init_scripts = []
        self.bindings = {}
        self.closed = False

    def add_init_script(self, script):
        self.init_scripts.append(script)

    def expose_binding(self, name, callback):
        self.bindings[name] = callback

    def close(self):
        self.closed = True


class _StubBrowser:
    def __init__(self):
        self.closed = False
        self.handlers = {}

    def on(self, event, handler):
        self.handlers[event] = handler

    def close(self):
        self.closed = True


class _StubPlaywright:
    def __init__(self):
        self.stopped = False

    def stop(self):
        self.stopped = True


class _StubPage:
    def __init__(self, context):
        self.context = context
        self.goto_targets = []
        self.handlers = {}
        self.url = ""

    @property
    def main_frame(self):
        return self

    def on(self, event, handler):
        self.handlers[event] = handler

    def goto(self, target, **_kwargs):
        self.goto_targets.append(target)
        self.url = target
        handler = self.handlers.get("framenavigated")
        if handler:
            handler(self)


def _stub_launch(state):
    context = _StubContext()
    return {
        "playwright": _StubPlaywright(),
        "browser": _StubBrowser(),
        "context": context,
        "page": _StubPage(context),
        "state": state,
    }


ENVIRONMENT = {
    "id": "env-1",
    "name": "测试环境",
    "browser": "Chromium",
    "baseUrl": "https://app.test",
    "testIdAttribute": "data-testid",
}


def _make_db() -> sqlite3.Connection:
    database = sqlite3.connect(":memory:")
    database.isolation_level = None
    database.execute("PRAGMA foreign_keys = ON")
    run_platform_migrations(database, MINIMAL_LEGACY_SCHEMA)
    # recording_sessions.project_id REFERENCES platform_projects(id)；FK 开启时
    # 协调器持久化路径需要一条项目行。
    database.execute(
        "INSERT INTO platform_projects (id, workspace_id) VALUES ('project-1', 'ws-1')"
    )
    return database


def _make_coordinator(database, clock=None):
    def launch(headless, storage_state=None):
        return _stub_launch({"headless": headless, "storage": storage_state})

    return RecordingCoordinator(
        submit=_ImmediateSubmit(),
        launch=launch,
        idle_ms=1000,
        max_ms=100_000,
        now_ms=lambda: clock["now"] if clock is not None else 1_000_000,
        database=lambda: database,
    )


def _row(database, session_id):
    return database.execute(
        """
        SELECT status, current_url, last_seq, event_count, step_count,
               created_at, last_activity_at, expires_at, error_code
        FROM recording_sessions WHERE id = ?
        """,
        (session_id,),
    ).fetchone()


# ---------- 迁移 v15 ----------


def test_migration_v15_creates_recording_sessions_table():
    database = _make_db()
    columns = {
        row[1] for row in database.execute("PRAGMA table_info(recording_sessions)")
    }
    assert {
        "id",
        "project_id",
        "owner_id",
        "flow_id",
        "environment_id",
        "status",
        "current_url",
        "last_seq",
        "event_count",
        "step_count",
        "created_at",
        "last_activity_at",
        "expires_at",
        "error_code",
    } <= columns


# ---------- 协调器持久化 ----------


def test_create_and_transitions_persist_metadata():
    database = _make_db()
    clock = {"now": 1_000_000}
    coordinator = _make_coordinator(database, clock)
    created = coordinator.create_session(
        "project-1", "flow-1", ENVIRONMENT, "/login", owner_id="owner-1", headless=True
    )
    session_id = created["id"]
    assert _row(database, session_id)[0] == "recording"

    coordinator.pause(session_id)
    assert _row(database, session_id)[0] == "paused"

    clock["now"] = 1_001_000
    coordinator.resume(session_id)
    assert _row(database, session_id)[0] == "recording"

    coordinator.stop(session_id)
    row = _row(database, session_id)
    assert row[0] == "stopped"
    assert row[1] == "https://app.test/login"  # current_url
    assert row[5] == 1_000_000  # created_at (epoch ms)
    # 重启后新协调器从 DB 还原已停会话（不依赖 create 期间的内存对象）。
    restarted = _make_coordinator(database, clock)
    reloaded = restarted._require_session(session_id)
    assert reloaded["status"] == "stopped"
    assert reloaded["currentUrl"] == "https://app.test/login"


def test_events_persist_throttled_last_seq_and_counts():
    database = _make_db()
    clock = {"now": 1_000_000}
    coordinator = _make_coordinator(database, clock)
    created = coordinator.create_session(
        "project-1", "flow-1", ENVIRONMENT, "/login", owner_id="owner-1", headless=True
    )
    session_id = created["id"]
    session = coordinator._require_session(session_id)
    # create 阶段的首导航已落库（last_seq=1）并把 lastPersistedAt 刷到创建时刻。
    assert _row(database, session_id)[2] == 1

    def event(at):
        return {
            "kind": "click",
            "url": "https://app.test/login",
            "element": {"tag": "button", "testid": "go", "text": "登录", "role": "button"},
            "at": at,
        }

    # 距上次落库 0ms：事件元数据限频跳过，last_seq 仍为 1。
    coordinator._on_browser_event(session, event(0))
    assert _row(database, session_id)[2] == 1
    # t=+1000：限频通过，navigate + 2 个 click 落库。
    clock["now"] = 1_001_000
    coordinator._on_browser_event(session, event(1000))
    row = _row(database, session_id)
    assert row[2] == 3  # last_seq
    assert row[3] == 3  # event_count
    # t=+500：限频跳过。
    clock["now"] = 1_001_500
    coordinator._on_browser_event(session, event(1500))
    assert _row(database, session_id)[2] == 3
    # t=+2000：限频通过。
    clock["now"] = 1_003_000
    coordinator._on_browser_event(session, event(3000))
    assert _row(database, session_id)[2] == 5
    # 导航更新 currentUrl 并落库（含 navigate 事件）。
    clock["now"] = 1_004_000
    coordinator._on_navigation(session, "https://app.test/home")
    row = _row(database, session_id)
    assert row[1] == "https://app.test/home"
    assert row[2] == 6


# ---------- 重启恢复 + DB 回退 ----------


def test_recover_interrupted_marks_leftover_and_keeps_terminal():
    database = _make_db()
    db = database
    for sid, status in (
        ("rec-1", "recording"),
        ("rec-2", "paused"),
        ("rec-3", "starting"),
        ("rec-4", "stopped"),
        ("rec-5", "failed"),
    ):
        db.execute(
            """
            INSERT INTO recording_sessions (
                id, project_id, owner_id, flow_id, environment_id, status,
                current_url, last_seq, event_count, step_count,
                created_at, last_activity_at, expires_at
            ) VALUES (?, 'project-1', 'owner-1', 'flow-1', 'env-1', ?, '/', 0, 0, 0, 1, 1, 1)
            """,
            (sid, status),
        )
    coordinator = _make_coordinator(database)
    affected = coordinator.recover_interrupted()
    assert affected == 3
    assert _row(database, "rec-1")[0] == "interrupted"
    assert _row(database, "rec-2")[0] == "interrupted"
    assert _row(database, "rec-3")[0] == "interrupted"
    assert _row(database, "rec-1")[8] == "SERVICE_RESTARTED"
    assert _row(database, "rec-4")[0] == "stopped"
    assert _row(database, "rec-5")[0] == "failed"


def test_require_session_falls_back_to_persisted_metadata():
    database = _make_db()
    db = database
    db.execute(
        """
        INSERT INTO recording_sessions (
            id, project_id, owner_id, flow_id, environment_id, status,
            current_url, last_seq, event_count, step_count,
            created_at, last_activity_at, expires_at
        ) VALUES ('rec-persisted', 'project-1', 'owner-1', 'flow-1', 'env-1',
                  'recording', 'https://app.test/login', 3, 5, 2,
                  1000000, 1000000, 9999999)
        """
    )
    clock = {"now": 1_000_000}
    # 模拟重启：新协调器实例（内存空）+ 恢复 → 已中断。
    restarted = _make_coordinator(database, clock)
    restarted.recover_interrupted()

    with pytest.raises(PlatformError) as error:
        restarted.session_response(restarted._require_session("does-not-exist"))
    assert error.value.code == "RECORDING_SESSION_NOT_FOUND"

    session = restarted._require_session("rec-persisted")
    response = restarted.session_response(session)
    assert response["status"] == "interrupted"
    assert response["projectId"] == "project-1"
    assert response["currentUrl"] == "https://app.test/login"
    assert response["startedAt"] == 1_000_000
    # 无归并器 → recordedStepCount 用持久化 step_count（非归并器）。
    assert response["recordedStepCount"] == 2
    result = restarted.session_result("rec-persisted")
    assert result["session"]["status"] == "interrupted"
    assert result["result"] == {
        "steps": [],
        "elements": [],
        "requiredBindings": [],
        "warnings": [],
        "lastSeq": 0,
    }


# ---------- 列表端点（协调器层） ----------


def test_list_sessions_owner_scoped_paginated_newest_first():
    database = _make_db()
    db = database
    inserted = 0
    for i in range(5):
        for owner in ("owner-1", "owner-2"):
            inserted += 1
            db.execute(
                """
                INSERT INTO recording_sessions (
                    id, project_id, owner_id, flow_id, environment_id, status,
                    current_url, last_seq, event_count, step_count,
                    created_at, last_activity_at, expires_at
                ) VALUES (?, 'project-1', ?, 'flow-1', 'env-1', 'interrupted', '/', 0, 0, 0, 1, ?, 1)
                """,
                (f"rec-{inserted}", owner, 1_000_000 + inserted),
            )
    coordinator = _make_coordinator(database)
    page1 = coordinator.list_sessions("project-1", "owner-1", 1, 3)
    assert page1["total"] == 5  # 仅 owner-1 的 5 行被计数
    assert len(page1["sessions"]) == 3
    # 最近活动优先：owner-1 行 id 为 rec-1/3/5/7/9，最新 3 条按倒序。
    assert [s["id"] for s in page1["sessions"]] == ["rec-9", "rec-7", "rec-5"]
    page2 = coordinator.list_sessions("project-1", "owner-1", 2, 3)
    assert len(page2["sessions"]) == 2
    assert [s["id"] for s in page2["sessions"]] == ["rec-3", "rec-1"]
    # 其他 owner 互不可见。
    assert coordinator.list_sessions("project-1", "someone-else", 1, 20)["total"] == 0
    assert coordinator.list_sessions("project-other", "owner-1", 1, 20)["total"] == 0


# ---------- 无数据库提供者 = no-op ----------


def test_without_database_provider_persists_nothing():
    def launch(headless, storage_state=None):
        return _stub_launch({"headless": headless, "storage": storage_state})

    coordinator = RecordingCoordinator(
        submit=_ImmediateSubmit(),
        launch=launch,
        now_ms=lambda: 1_000_000,
    )
    created = coordinator.create_session(
        "project-1", "flow-1", ENVIRONMENT, "/login", owner_id="owner-1", headless=True
    )
    # 无数据库提供者：持久化路径全部 no-op，不抛错。
    assert coordinator._db() is None
    assert coordinator._load_session(created["id"]) is None
    assert coordinator.recover_interrupted() == 0
    assert coordinator.list_sessions("project-1", "owner-1", 1, 20)["sessions"] == []
    # 内存会话照常工作（含 DB 回退缺失时的 404）。
    with pytest.raises(PlatformError) as error:
        coordinator._require_session("does-not-exist")
    assert error.value.code == "RECORDING_SESSION_NOT_FOUND"
    assert coordinator._require_session(created["id"])["status"] == "recording"
    stopped = coordinator.stop(created["id"])
    assert stopped["status"] == "stopped"
    result = coordinator.session_result(created["id"])
    assert result["session"]["status"] == "stopped"


# ---------- GET 列表端点（路由层） ----------

def _setup_services(tmp_path):
    from fastapi import Request

    from autoflow.core import now
    from autoflow.handler import create_platform_router
    from autoflow.services import AuthUser, PlatformServices

    services = PlatformServices(str(tmp_path))
    user = AuthUser("owner-1", "owner@example.test", "Owner")
    services.database.execute(
        "INSERT INTO platform_users (id, email, name, created_at) VALUES (?, ?, ?, ?)",
        (user.id, user.email, user.name, now()),
    )
    workspace = services.create_workspace(user, "Recording workspace")
    services.database.execute(
        """
        INSERT INTO platform_projects (
          id, workspace_id, slug, name, description, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        ("project-1", workspace["id"], "project-1", "Project", "", now(), now()),
    )
    session = services.create_auth_session(user)
    return services, user, session, create_platform_router(services)


def _route(router, path, method="GET"):
    return next(
        route
        for route in router.routes
        if getattr(route, "path", None) == path
        and method.upper()
        in {m.upper() for m in getattr(route, "methods", set()) or {"GET"}}
    )


def _call(route, token, project_id, query_string=b""):
    import asyncio

    from fastapi import Request

    async def run():
        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": f"/api/platform/projects/{project_id}",
            "raw_path": f"/api/platform/projects/{project_id}".encode(),
            "query_string": query_string,
            "headers": [(b"authorization", f"Bearer {token}".encode())],
            "client": ("127.0.0.1", 1234),
            "server": ("127.0.0.1", 8787),
        }

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        return await route.endpoint(Request(scope, receive=receive), project_id=project_id)

    return asyncio.run(run())


def test_get_recording_sessions_endpoint_returns_persisted(tmp_path):
    services, user, session, router = _setup_services(tmp_path)
    try:
        services.database.execute(
            """
            INSERT INTO recording_sessions (
                id, project_id, owner_id, flow_id, environment_id, status,
                current_url, last_seq, event_count, step_count,
                created_at, last_activity_at, expires_at, error_code
            ) VALUES ('rec-1', 'project-1', 'owner-1', 'flow-1', 'env-1', 'interrupted', '/', 3, 5, 2, 100, 200, 9999, 'SERVICE_RESTARTED')
            """
        )
        route = _route(
            router, "/api/platform/projects/{project_id}/recording-sessions"
        )
        response = _call(route, session["token"], "project-1", b"page=1&pageSize=10")
        assert response.status_code == 200
        payload = json.loads(response.body)
        assert payload["total"] == 1
        assert payload["page"] == 1
        assert payload["pageSize"] == 10
        item = payload["sessions"][0]
        assert item["id"] == "rec-1"
        assert item["status"] == "interrupted"
        assert item["errorCode"] == "SERVICE_RESTARTED"
        assert item["recordedStepCount"] == 2
        assert item["lastActivityAt"] == 200
        # 分页参数非法 → PAGINATION_INVALID。
        with pytest.raises(PlatformError) as error:
            _call(route, session["token"], "project-1", b"page=not-a-number")
        assert error.value.status == 400
        assert error.value.code == "PAGINATION_INVALID"
    finally:
        services.close()
