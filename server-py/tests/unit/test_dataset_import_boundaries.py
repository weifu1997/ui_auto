"""Dataset import boundary tests (P2-10 coverage gap).

The dataset create/version happy path is exercised by
``test_handler_audit_analytics``; this file pins the import *boundaries* that
had no handler/DB coverage: row limit, empty/oversize/invalid payloads,
duplicate name conflict, header validation, xlsx, and the >100-row detail
truncation flag.
"""

from __future__ import annotations

import asyncio
import base64
import json

from starlette.requests import Request

from autoflow.core import now
from autoflow.handler import create_platform_router
from autoflow.http import PlatformError
from autoflow.services import AuthUser, PlatformServices


def _setup(tmp_path):
    services = PlatformServices(str(tmp_path))
    router = create_platform_router(services)
    user = AuthUser("ds-user", "ds@example.test", "DS")
    services.database.execute(
        """
        INSERT INTO platform_users (id, email, name, created_at)
        VALUES (?, ?, ?, ?)
        """,
        (user.id, user.email, user.name, now()),
    )
    workspace = services.create_workspace(user, "Dataset workspace")
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
            now(),
            now(),
        ),
    )
    session = services.create_auth_session(user)
    routes = {
        path: next(
            route
            for route in router.routes
            if getattr(route, "path", None) == path
        )
        for path in (
            "/api/platform/projects/{project_id}/datasets",
            "/api/platform/projects/{project_id}/datasets/{dataset_id}",
            "/api/platform/projects/{project_id}/datasets/{dataset_id}/versions",
            "/api/platform/projects/{project_id}/dataset-versions/{version_id}",
        )
    }
    return services, session, project_id, routes


def _make_call(session, project_id, routes):
    def call(
        path: str,
        method: str = "POST",
        body: bytes | None = None,
        **path_params,
    ):
        async def invoke():
            template = {
                "/datasets": routes["/api/platform/projects/{project_id}/datasets"],
                "/versions": routes[
                    "/api/platform/projects/{project_id}/datasets/{dataset_id}/versions"
                ],
                "/version-detail": routes[
                    "/api/platform/projects/{project_id}/dataset-versions/{version_id}"
                ],
            }[path]
            raw_path = template.path.format(project_id=project_id, **path_params)
            scope = {
                "type": "http",
                "asgi": {"version": "3.0"},
                "http_version": "1.1",
                "method": method,
                "scheme": "http",
                "path": raw_path,
                "raw_path": raw_path.encode(),
                "query_string": b"",
                "headers": [(b"authorization", f"Bearer {session['token']}".encode())],
                "client": ("127.0.0.1", 1234),
                "server": ("127.0.0.1", 8787),
            }

            async def receive():
                return {
                    "type": "http.request",
                    "body": body or b"",
                    "more_body": False,
                }

            endpoint_params = dict(path_params)
            endpoint_params["project_id"] = project_id
            return await template.endpoint(
                Request(scope, receive=receive), **endpoint_params
            )

        return asyncio.run(invoke())

    return call


def _b64(text: str) -> str:
    return base64.b64encode(text.encode()).decode()


def _expect(code: str, status: int):
    def wrap(fn):
        try:
            fn()
        except PlatformError as error:
            assert error.status == status, error
            assert error.code == code, error
        else:
            raise AssertionError(f"expected PlatformError {code} ({status})")
        return None

    return wrap


def _create_dataset(call, name: str = "Contacts", payload: str = "name,email\nAlice,a@example.test\n") -> str:
    response = call(
        "/datasets",
        body=json.dumps(
            {
                "name": name,
                "description": "",
                "fileName": "contacts.csv",
                "contentBase64": _b64(payload),
            }
        ).encode(),
    )
    assert response.status_code == 201
    return json.loads(response.body)["dataset"]["id"]


def test_import_row_limit_exceeded_is_413_before_any_write(tmp_path):
    """超过 1 万数据行的导入必须 413，且不得留下任何 dataset/version 行。"""
    services, session, project_id, routes = _setup(tmp_path)
    try:
        call = _make_call(session, project_id, routes)
        lines = ["name,email"] + [
            f"row-{i},row-{i}@example.test" for i in range(1, 10002)
        ]
        payload = "\n".join(lines)

        _expect("DATASET_ROW_LIMIT_EXCEEDED", 413)(
            lambda: call(
                "/datasets",
                body=json.dumps(
                    {
                        "name": "Huge",
                        "description": "",
                        "fileName": "huge.csv",
                        "contentBase64": _b64(payload),
                    }
                ).encode(),
            )
        )
        assert (
            services.database.execute(
                "SELECT COUNT(*) FROM datasets WHERE project_id = ?",
                (project_id,),
            ).fetchone()[0]
            == 0
        )
    finally:
        services.close()


def test_import_empty_and_oversize_and_bad_type_payloads(tmp_path):
    services, session, project_id, routes = _setup(tmp_path)
    try:
        call = _make_call(session, project_id, routes)

        # contentBase64 为空串是假值：被 handler 入参校验拦下，解析层根本不会跑。
        _expect("DATASET_IMPORT_INPUT_INVALID", 400)(
            lambda: call(
                "/datasets",
                body=json.dumps(
                    {
                        "name": "Empty",
                        "description": "",
                        "fileName": "e.csv",
                        "contentBase64": _b64(""),
                    }
                ).encode(),
            )
        )
        _expect("DATASET_FILE_TYPE_UNSUPPORTED", 400)(
            lambda: call(
                "/datasets",
                body=json.dumps(
                    {
                        "name": "Pdf",
                        "description": "",
                        "fileName": "file.pdf",
                        "contentBase64": _b64("a,b\n1,2\n"),
                    }
                ).encode(),
            )
        )
        _expect("DATASET_FILE_TOO_LARGE", 413)(
            lambda: call(
                "/datasets",
                body=json.dumps(
                    {
                        "name": "Big",
                        "description": "",
                        "fileName": "big.csv",
                        "contentBase64": base64.b64encode(b"x" * 12_000_001).decode(),
                    }
                ).encode(),
            )
        )
    finally:
        services.close()


def test_import_invalid_and_insufficient_payloads(tmp_path):
    services, session, project_id, routes = _setup(tmp_path)
    try:
        call = _make_call(session, project_id, routes)

        # 未闭合引号 → 非法 CSV。
        _expect("DATASET_FILE_INVALID", 400)(
            lambda: call(
                "/datasets",
                body=json.dumps(
                    {
                        "name": "Quoted",
                        "description": "",
                        "fileName": "q.csv",
                        "contentBase64": _b64('name,email\n"Alice,a@example.test\n'),
                    }
                ).encode(),
            )
        )
        # 只有表头没有数据行。
        _expect("DATASET_ROWS_REQUIRED", 400)(
            lambda: call(
                "/datasets",
                body=json.dumps(
                    {
                        "name": "HeadOnly",
                        "description": "",
                        "fileName": "h.csv",
                        "contentBase64": _b64("name,email\n"),
                    }
                ).encode(),
            )
        )
        # 重复表头。
        _expect("DATASET_HEADERS_DUPLICATE", 400)(
            lambda: call(
                "/datasets",
                body=json.dumps(
                    {
                        "name": "Dup",
                        "description": "",
                        "fileName": "d.csv",
                        "contentBase64": _b64("a,a\n1,2\n"),
                    }
                ).encode(),
            )
        )
        # 缺必需字段。
        _expect("DATASET_IMPORT_INPUT_INVALID", 400)(
            lambda: call(
                "/datasets",
                body=json.dumps({"name": "NoFile"}).encode(),
            )
        )
    finally:
        services.close()


def test_import_duplicate_name_conflicts_as_409(tmp_path):
    services, session, project_id, routes = _setup(tmp_path)
    try:
        call = _make_call(session, project_id, routes)
        _create_dataset(call, name="Contacts")
        _expect("DATASET_NAME_EXISTS", 409)(
            lambda: call(
                "/datasets",
                body=json.dumps(
                    {
                        "name": "Contacts",
                        "description": "",
                        "fileName": "contacts.csv",
                        "contentBase64": _b64("name,email\nBob,b@example.test\n"),
                    }
                ).encode(),
            )
        )
    finally:
        services.close()


def test_parse_empty_bytes_after_decode_raises_file_empty(tmp_path):
    """非空 b64 文本解码后为零字节 → 服务层报 DATASET_FILE_EMPTY。

    ``base64.b64decode`` 默认忽略空白符，``contentBase64=" "`` 是“非空串但空文件”，
    能穿过 handler 的入参校验，落在这条服务层分支上。
    """
    services, _session, _project_id, _routes = _setup(tmp_path)
    try:
        _expect("DATASET_FILE_EMPTY", 400)(
            lambda: services.parse_dataset_upload("e.csv", " ")
        )
    finally:
        services.close()


def test_version_upload_increments_and_rejects_unknown_dataset(tmp_path):
    services, session, project_id, routes = _setup(tmp_path)
    try:
        call = _make_call(session, project_id, routes)
        dataset_id = _create_dataset(call)  # version 1
        version_response = call(
            "/versions",
            dataset_id=dataset_id,
            body=json.dumps(
                {
                    "fileName": "contacts-v2.csv",
                    "contentBase64": _b64("name,email\nCarol,c@example.test\n"),
                }
            ).encode(),
        )
        assert version_response.status_code == 201
        version = json.loads(version_response.body)["version"]
        assert version["versionNumber"] == 2
        assert version["rowCount"] == 1

        _expect("DATASET_NOT_FOUND", 404)(
            lambda: call(
                "/versions",
                dataset_id="missing-dataset",
                body=json.dumps(
                    {
                        "fileName": "v.csv",
                        "contentBase64": _b64("name,email\nD,d@example.test\n"),
                    }
                ).encode(),
            )
        )
    finally:
        services.close()


def test_version_detail_truncates_over_one_hundred_rows(tmp_path):
    services, session, project_id, routes = _setup(tmp_path)
    try:
        call = _make_call(session, project_id, routes)
        payload = "\n".join(
            ["name,email"]
            + [f"row-{i},row-{i}@example.test" for i in range(1, 150)]
        )
        response = call(
            "/datasets",
            body=json.dumps(
                {
                    "name": "Many",
                    "description": "",
                    "fileName": "many.csv",
                    "contentBase64": _b64(payload),
                }
            ).encode(),
        )
        assert response.status_code == 201
        dataset_id = json.loads(response.body)["dataset"]["id"]
        version_id = json.loads(response.body)["version"]["id"]

        detail = call("/version-detail", version_id=version_id)
        assert detail.status_code == 200
        body = json.loads(detail.body)
        assert body["version"]["rowCount"] == 149
        assert len(body["rows"]) == 100
        assert body["truncated"] is True
    finally:
        services.close()
