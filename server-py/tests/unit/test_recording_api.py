"""Platform recording API route tests (auth/scoping/basic command contract)."""

import asyncio
import json

from fastapi import Request

from autoflow.core import now
from autoflow.handler import create_platform_router
from autoflow.http import PlatformError
from autoflow.recorder import RecorderNormalizer
from autoflow.services import AuthUser, PlatformServices

FAKE_SESSION = {
    "id": "rec_test",
    "projectId": "project-1",
    "ownerId": "owner-1",
    "flowId": "flow-1",
    "environmentId": "env-1",
    "status": "recording",
    "currentUrl": "https://app.test/login",
    "lastSeq": 0,
    "createdAt": 1_000,
    "lastActivityAt": 1_000,
}


def _setup(tmp_path):
    services = PlatformServices(str(tmp_path))
    user = AuthUser("owner-1", "owner@example.test", "Owner")
    services.database.execute(
        """
        INSERT INTO platform_users (id, email, name, created_at)
        VALUES (?, ?, ?, ?)
        """,
        (user.id, user.email, user.name, now()),
    )
    workspace = services.create_workspace(user, "Recording workspace")
    services.database.execute(
        """
        INSERT INTO platform_projects (
          id, workspace_id, slug, name, description, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "project-1",
            workspace["id"],
            "project-1",
            "Project",
            "",
            now(),
            now(),
        ),
    )
    services.database.execute(
        """
        INSERT INTO project_resources (
          project_id, resource_type, resource_id, data, version, updated_at, updated_by
        ) VALUES (?, 'environments', ?, ?, 1, ?, ?)
        """,
        (
            "project-1",
            "env-1",
            json.dumps({
                "id": "env-1",
                "name": "Env",
                "browser": "Chromium",
                "baseUrl": "https://app.test",
                "testIdAttribute": "data-testid",
            }),
            now(),
            user.id,
        ),
    )
    services.database.execute(
        """
        INSERT INTO project_resources (
          project_id, resource_type, resource_id, data, version, updated_at, updated_by
        ) VALUES (?, 'flows', ?, ?, 1, ?, ?)
        """,
        (
            "project-1",
            "flow-1",
            json.dumps({"id": "flow-1", "name": "Flow", "steps": []}),
            now(),
            user.id,
        ),
    )
    session = services.create_auth_session(user)
    return services, user, session


def _route(router, path):
    return next(route for route in router.routes if getattr(route, "path", None) == path)


def _call(route, token, project_id, method="GET", body=None, path_params=None, query_string=b""):
    async def run():
        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": method,
            "scheme": "http",
            "path": f"/api/platform/projects/{project_id}",
            "raw_path": f"/api/platform/projects/{project_id}".encode(),
            "query_string": query_string,
            "headers": [(b"authorization", f"Bearer {token}".encode())],
            "client": ("127.0.0.1", 1234),
            "server": ("127.0.0.1", 8787),
        }

        async def receive():
            return {"type": "http.request", "body": body or b"", "more_body": False}

        params = dict(path_params or {})
        if "{project_id}" in getattr(route, "path", ""):
            params["project_id"] = project_id
        return await route.endpoint(Request(scope, receive=receive), **params)

    return asyncio.run(run())


def test_recording_session_create_requires_flow_edit_and_returns_session(tmp_path):
    services, user, session = _setup(tmp_path)
    try:
        router = create_platform_router(services)
        services.recording_coordinator.create_session = lambda *args, **kwargs: dict(FAKE_SESSION)
        create_route = _route(
            router, "/api/platform/projects/{project_id}/recording-sessions"
        )
        response = _call(
            create_route,
            session["token"],
            "project-1",
            method="POST",
            body=json.dumps({
                "flowId": "flow-1",
                "environmentId": "env-1",
                "startUrl": "/login?next=/home",
                "freshLogin": True,
            }).encode(),
        )
        assert response.status_code == 201
        payload = json.loads(response.body)
        assert payload["session"]["id"] == "rec_test"
    finally:
        services.close()


def test_recording_session_cancel_active_returns_canceled_session(tmp_path):
    services, user, session = _setup(tmp_path)
    try:
        router = create_platform_router(services)
        services.recording_coordinator.cancel_active = lambda *args, **kwargs: {
            **FAKE_SESSION,
            "status": "canceled",
        }
        cancel_route = _route(
            router,
            "/api/platform/projects/{project_id}/recording-sessions/cancel-active",
        )
        response = _call(
            cancel_route,
            session["token"],
            "project-1",
            method="POST",
            body=json.dumps({"environmentId": "env-1"}).encode(),
        )
        assert response.status_code == 200
        payload = json.loads(response.body)
        assert payload["canceled"] is True
        assert payload["session"]["status"] == "canceled"
    finally:
        services.close()


def test_recording_session_create_rejects_unknown_workspace_role(tmp_path):
    services, user, session = _setup(tmp_path)
    try:
        workspace_id = services.project_for("project-1")["workspace_id"]
        services.database.execute(
            "UPDATE workspace_members SET role = 'unknown-role' WHERE workspace_id = ? AND user_id = ?",
            (workspace_id, user.id),
        )
        router = create_platform_router(services)
        create_route = _route(
            router, "/api/platform/projects/{project_id}/recording-sessions"
        )
        try:
            _call(
                create_route,
                session["token"],
                "project-1",
                method="POST",
                body=json.dumps({
                    "flowId": "flow-1",
                    "environmentId": "env-1",
                    "startUrl": "/login",
                }).encode(),
            )
            raise AssertionError("unknown role must not create recording sessions")
        except PlatformError as error:
            assert error.status == 403
            assert error.code == "WORKSPACE_ACCESS_DENIED"
    finally:
        services.close()


def test_revision_rejects_materialized_sensitive_recording_value(tmp_path):
    services, user, session = _setup(tmp_path)
    try:
        router = create_platform_router(services)
        revision_route = _route(router, "/api/platform/projects/{project_id}/revisions")
        base_flow = {
            "id": "flow-1",
            "name": "Recorded flow",
            "steps": [{
                "id": "password-step",
                "title": "填写 password",
                "action": "填写",
                "element": "password",
                "value": "plain-text-password",
            }],
        }
        environment = {
            "id": "env-1",
            "name": "Env",
            "browser": "Chromium",
            "baseUrl": "https://app.test",
        }
        body = {"flow": base_flow, "environment": environment, "secretNames": ["secret.password"]}
        try:
            _call(
                revision_route,
                session["token"],
                "project-1",
                method="POST",
                body=json.dumps(body).encode(),
            )
            raise AssertionError("materialized sensitive recording value must be rejected")
        except PlatformError as error:
            assert error.status == 400
            assert error.code == "REVISION_SECRET_VALUE_FORBIDDEN"

        safe_flow = {**base_flow, "steps": [{**base_flow["steps"][0], "value": "{{secret.password}}"}]}
        response = _call(
            revision_route,
            session["token"],
            "project-1",
            method="POST",
            body=json.dumps({**body, "flow": safe_flow}).encode(),
        )
        assert response.status_code == 201
        snapshot = services.database.execute(
            "SELECT flow_snapshot FROM flow_revisions WHERE project_id = ? ORDER BY created_at DESC LIMIT 1",
            ("project-1",),
        ).fetchone()[0]
        assert "plain-text-password" not in snapshot
        assert "{{secret.password}}" in snapshot
    finally:
        services.close()


def test_recording_session_create_enforces_auth_membership_and_resource_scope(tmp_path):
    services, user, session = _setup(tmp_path)
    try:
        router = create_platform_router(services)
        create_route = _route(
            router, "/api/platform/projects/{project_id}/recording-sessions"
        )
        body = json.dumps({
            "flowId": "flow-1",
            "environmentId": "env-1",
            "startUrl": "/login",
        }).encode()
        try:
            _call(create_route, "", "project-1", method="POST", body=body)
            raise AssertionError("recording creation requires an authenticated session")
        except PlatformError as error:
            assert error.status == 401
            assert error.code == "AUTH_REQUIRED"

        outsider = AuthUser("outsider-1", "outsider@example.test", "Outsider")
        services.database.execute(
            "INSERT INTO platform_users (id, email, name, created_at) VALUES (?, ?, ?, ?)",
            (outsider.id, outsider.email, outsider.name, now()),
        )
        outsider_session = services.create_auth_session(outsider)
        try:
            _call(
                create_route,
                outsider_session["token"],
                "project-1",
                method="POST",
                body=body,
            )
            raise AssertionError("non-members must not create recording sessions")
        except PlatformError as error:
            assert error.status == 403
            assert error.code == "WORKSPACE_ACCESS_DENIED"

        workspace_id = services.project_for("project-1")["workspace_id"]
        services.database.execute(
            """
            INSERT INTO platform_projects (
              id, workspace_id, slug, name, description, created_at, updated_at
            ) VALUES (?, ?, 'other-project', 'Other', '', ?, ?)
            """,
            ("other-project", workspace_id, now(), now()),
        )
        services.database.execute(
            """
            INSERT INTO project_resources (
              project_id, resource_type, resource_id, data, version, updated_at, updated_by
            ) VALUES (?, 'flows', ?, ?, 1, ?, ?)
            """,
            (
                "other-project",
                "foreign-flow",
                json.dumps({"id": "foreign-flow", "name": "Foreign", "steps": []}),
                now(),
                user.id,
            ),
        )
        try:
            _call(
                create_route,
                session["token"],
                "project-1",
                method="POST",
                body=json.dumps({
                    "flowId": "foreign-flow",
                    "environmentId": "env-1",
                    "startUrl": "/login",
                }).encode(),
            )
            raise AssertionError("a flow from another project must not be recorded")
        except PlatformError as error:
            assert error.status == 404
            assert error.code == "FLOW_NOT_FOUND"
    finally:
        services.close()


def test_recording_session_detail_checks_project_scope(tmp_path):
    services, user, session = _setup(tmp_path)
    try:
        router = create_platform_router(services)
        workspace_id = services.project_for("project-1")["workspace_id"]
        services.database.execute(
            """
            INSERT INTO platform_projects (
              id, workspace_id, slug, name, description, created_at, updated_at
            ) VALUES (?, ?, 'other-project', 'Other', '', ?, ?)
            """,
            ("other-project", workspace_id, now(), now()),
        )
        services.recording_coordinator._sessions = {
            "rec_test": {
                **FAKE_SESSION,
                "normalizer": None,
                "events": [],
                "result": None,
            }
        }
        detail_route = _route(
            router,
            "/api/platform/projects/{project_id}/recording-sessions/{session_id}",
        )
        ok = _call(
            detail_route,
            session["token"],
            "project-1",
            path_params={"session_id": "rec_test"},
        )
        assert ok.status_code == 200
        try:
            _call(
                detail_route,
                session["token"],
                "other-project",
                path_params={"session_id": "rec_test"},
            )
            raise AssertionError("cross-project recording session must be rejected")
        except PlatformError as exc:
            assert exc.status == 404
            assert exc.code == "RECORDING_SESSION_NOT_FOUND"
    finally:
        services.close()


def test_recording_events_reject_invalid_cursors_and_limits(tmp_path):
    services, user, session = _setup(tmp_path)
    try:
        router = create_platform_router(services)
        services.recording_coordinator._sessions = {
            "rec_test": {
                **FAKE_SESSION,
                "normalizer": RecorderNormalizer("https://app.test/login", "env-1"),
                "events": [],
                "result": None,
                "browserSession": None,
                "errorCode": None,
                "failureNotified": False,
            }
        }
        events_route = _route(
            router,
            "/api/platform/projects/{project_id}/recording-sessions/{session_id}/events",
        )
        for query_string, code in (
            (b"afterSeq=-1", "RECORDING_AFTER_SEQ_INVALID"),
            (b"limit=0", "RECORDING_LIMIT_INVALID"),
            (b"limit=501", "RECORDING_LIMIT_INVALID"),
        ):
            try:
                _call(
                    events_route,
                    session["token"],
                    "project-1",
                    path_params={"session_id": "rec_test"},
                    query_string=query_string,
                )
                raise AssertionError("invalid recording event pagination must be rejected")
            except PlatformError as error:
                assert error.status == 400
                assert error.code == code
    finally:
        services.close()


def test_recording_stop_is_audited_once_and_invalid_json_is_a_stable_4xx(tmp_path):
    services, user, session = _setup(tmp_path)
    try:
        router = create_platform_router(services)
        session_state = {
            **FAKE_SESSION,
            "normalizer": RecorderNormalizer("https://app.test/login", "env-1"),
            "events": [],
            "result": None,
            "browserSession": None,
            "errorCode": None,
            "failureNotified": False,
        }
        services.recording_coordinator._sessions = {"rec_test": session_state}
        audit_calls = []
        services.audit = lambda *args: audit_calls.append(args)
        stop_route = _route(
            router,
            "/api/platform/projects/{project_id}/recording-sessions/{session_id}/stop",
        )
        for _ in range(2):
            response = _call(
                stop_route,
                session["token"],
                "project-1",
                method="POST",
                path_params={"session_id": "rec_test"},
            )
            assert response.status_code == 200
            assert json.loads(response.body)["session"]["status"] == "stopped"
        assert [call[2] for call in audit_calls] == ["recording.session_stopped"]

        create_route = _route(
            router, "/api/platform/projects/{project_id}/recording-sessions"
        )
        try:
            _call(
                create_route,
                session["token"],
                "project-1",
                method="POST",
                body=b"{bad-json",
            )
            raise AssertionError("invalid recording payload must be rejected")
        except PlatformError as error:
            assert error.status == 400
            assert error.code == "RECORDING_INPUT_INVALID"
    finally:
        services.close()
