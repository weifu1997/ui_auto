import asyncio
import json
import uuid

import pytest
from starlette.requests import Request

from autoflow.core import now
from autoflow.handler import create_platform_router
from autoflow.services import AuthUser, PlatformServices
from autoflow.templates import (
    extract_flow_element_references,
    extract_flow_variable_references,
    rewrite_flow_placeholders_and_elements,
    rewrite_template_references,
)


def test_templates_unit_rewrite_and_helpers():
    # 1. rewrite_template_references: pure recursive dictionary ID mapping
    ids = {"elem-1": "new-elem-1", "elem-2": "new-elem-2", "var-1": "new-var-1"}
    data = {
        "step": {"element": "btn_submit", "id": "elem-1", "value": "text"},
        "elements": ["elem-1", "elem-2"],
    }
    res = rewrite_template_references(data, ids)
    assert res["step"]["id"] == "new-elem-1"
    assert res["elements"] == ["new-elem-1", "new-elem-2"]

    # 2. Extract flow element references
    flow = {
        "id": "flow-1",
        "name": "Test Flow",
        "steps": [
            {"element": "btn_submit", "value": "{{project.apiKey}}"},
            {"element": "input_user", "value": "hello {{env.baseUrl}} and {{token}}"},
        ],
        "secretNames": ["project.apiKey"],
    }
    elem_refs = extract_flow_element_references(flow)
    assert elem_refs == {"btn_submit", "input_user"}

    var_refs = extract_flow_variable_references(flow)
    # env.baseUrl is runtime namespace and excluded; project.apiKey and token are included
    assert "project.apiKey" in var_refs
    assert "token" in var_refs
    assert "env.baseUrl" not in var_refs

    # 3. Rewrite flow placeholders and elements
    ref_renames = {"project.apiKey": "project.apiKey_2", "token": "token_2"}
    elem_renames = {"btn_submit": "btn_submit_2", "input_user": "target_user_input"}
    rewritten_flow = rewrite_flow_placeholders_and_elements(flow, ref_renames, elem_renames)
    assert rewritten_flow["secretNames"] == ["project.apiKey_2"]
    assert rewritten_flow["steps"][0]["element"] == "btn_submit_2"
    assert rewritten_flow["steps"][0]["value"] == "{{project.apiKey_2}}"
    assert rewritten_flow["steps"][1]["element"] == "target_user_input"
    assert rewritten_flow["steps"][1]["value"] == "hello {{env.baseUrl}} and {{token_2}}"


def test_templates_api_full_lifecycle(tmp_path):
    services = PlatformServices(str(tmp_path))
    router = create_platform_router(services)

    user = AuthUser("user-tmpl-1", "tmpl@example.test", "Tmpl Owner")
    services.database.execute(
        """
        INSERT INTO platform_users (id, email, name, created_at)
        VALUES (?, ?, ?, ?)
        """,
        (user.id, user.email, user.name, now()),
    )
    workspace = services.create_workspace(user, "Tmpl Workspace")
    workspace_id = workspace["id"]

    # Source project
    services.database.execute(
        """
        INSERT INTO platform_projects (
          id, workspace_id, slug, name, description, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "proj-source",
            workspace_id,
            "proj-source",
            "Source Project",
            "",
            now(),
            now(),
        ),
    )

    # Target project
    services.database.execute(
        """
        INSERT INTO platform_projects (
          id, workspace_id, slug, name, description, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "proj-target",
            workspace_id,
            "proj-target",
            "Target Project",
            "",
            now(),
            now(),
        ),
    )

    session = services.create_auth_session(user)
    headers = {
        b"authorization": f"Bearer {session['token']}".encode(),
        b"content-type": b"application/json",
    }

    async def call(method: str, path: str, body: dict | None = None, query: str = ""):
        # Match router route
        for route in router.routes:
            match, child_scope = route.matches({
                "type": "http",
                "method": method,
                "path": path,
                "headers": list(headers.items()),
                "query_string": query.encode(),
            })
            if match.name == "FULL":
                scope = {
                    "type": "http",
                    "method": method,
                    "path": path,
                    "headers": list(headers.items()),
                    "query_string": query.encode(),
                    "path_params": child_scope.get("path_params", {}),
                }
                body_bytes = json.dumps(body).encode() if body is not None else b""

                async def receive():
                    return {"type": "http.request", "body": body_bytes, "more_body": False}

                req = Request(scope, receive)
                resp = await route.endpoint(req, **child_scope.get("path_params", {}))
                return resp.status_code, json.loads(resp.body.decode())
        raise RuntimeError(f"Route not found: {method} {path}")

    # 1. Setup published revision in source project (canonical snapshot with element name only)
    flow_data = {
        "id": "flow-source-1",
        "name": "Login Flow",
        "steps": [
            {"id": "step-1", "element": "btn_login", "value": "{{project.secret_token}}"},
            {"id": "step-2", "element": "input_user", "value": "admin"},
        ],
        "secretNames": ["project.secret_token"],
    }
    env_data = {"id": "env-source-1", "name": "Prod Env"}
    elements_data = [
        {"id": "elem-source-1", "name": "btn_login", "environment": "Prod Env", "method": "css", "value": "#btn"},
        {"id": "elem-source-2", "name": "input_user", "environment": "Prod Env", "method": "css", "value": "#user"},
    ]
    variables_data = [
        {"id": "var-source-1", "name": "secret_token", "scope": "项目", "secret": True, "value": ""},
        {"id": "var-source-2", "name": "timeout", "scope": "环境", "secret": False, "value": "30"},
    ]

    for v in variables_data:
        services.database.execute(
            """
            INSERT INTO project_resources (
              project_id, resource_type, resource_id, data, version, updated_at, updated_by
            ) VALUES (?, 'variables', ?, ?, 1, ?, ?)
            """,
            ("proj-source", v["id"], json.dumps(v), now(), user.id),
        )

    rev_id_1 = "rev-1"
    services.database.execute(
        """
        INSERT INTO flow_revisions (
          id, project_id, revision_number, status, flow_snapshot, environment_snapshot,
          element_snapshot, dataset_snapshot, checksum, created_at, created_by
        ) VALUES (?, ?, 1, 'published', ?, ?, ?, '{}', 'chk1', ?, ?)
        """,
        (
            rev_id_1,
            "proj-source",
            json.dumps(flow_data),
            json.dumps(env_data),
            json.dumps(elements_data),
            now(),
            user.id,
        ),
    )

    # 2. Publish Template
    status, res = asyncio.run(
        call(
            "POST",
            "/api/platform/templates",
            {
                "projectId": "proj-source",
                "revisionId": rev_id_1,
                "name": "Auth Template",
                "category": "认证",
                "description": "标准登录流程",
            },
            query=f"workspaceId={workspace_id}",
        )
    )
    assert status == 201
    template_id = res["template"]["id"]

    # 3. Add existing resources to Target Project to test conflict detection and element mapping
    target_existing_elem = {
        "id": "elem-target-1",
        "name": "target_login_button",
        "environment": "Target Env",
        "method": "xpath",
        "value": "//button[@id='submit']",
    }
    services.database.execute(
        """
        INSERT INTO project_resources (
          project_id, resource_type, resource_id, data, version, updated_at, updated_by
        ) VALUES (?, 'elements', ?, ?, 1, ?, ?)
        """,
        ("proj-target", target_existing_elem["id"], json.dumps(target_existing_elem), now(), user.id),
    )

    # Also add existing flow with same name "Login Flow" and variable with same (scope, name)
    existing_flow = {"id": "flow-target-orig", "name": "Login Flow"}
    services.database.execute(
        """
        INSERT INTO project_resources (
          project_id, resource_type, resource_id, data, version, updated_at, updated_by
        ) VALUES (?, 'flows', ?, ?, 1, ?, ?)
        """,
        ("proj-target", existing_flow["id"], json.dumps(existing_flow), now(), user.id),
    )
    existing_var = {"id": "var-target-orig", "name": "secret_token", "scope": "项目", "secret": True}
    services.database.execute(
        """
        INSERT INTO project_resources (
          project_id, resource_type, resource_id, data, version, updated_at, updated_by
        ) VALUES (?, 'variables', ?, ?, 1, ?, ?)
        """,
        ("proj-target", existing_var["id"], json.dumps(existing_var), now(), user.id),
    )

    # 4. Test apply-candidates endpoint
    status, cand_res = asyncio.run(
        call(
            "GET",
            f"/api/platform/templates/{template_id}/apply-candidates",
            query="projectId=proj-target",
        )
    )
    assert status == 200
    assert len(cand_res["candidates"]) == 1
    assert cand_res["candidates"][0]["id"] == "elem-target-1"
    assert cand_res["candidates"][0]["name"] == "target_login_button"

    # 5. Apply Template with Element Mapping, Selection, and Conflict Auto-renaming
    apply_payload = {
        "projectId": "proj-target",
        "selection": {
            "flow": True,
            "elements": ["elem-source-1", "elem-source-2"],
            "variables": ["var-source-1", "var-source-2"],
            "environments": False,
        },
        "elementMappings": {
            "elem-source-1": "elem-target-1",  # Map elem-source-1 (btn_login) to existing target element (target_login_button)
            "elem-source-2": None,             # Create elem-source-2 (input_user) as new element
        },
    }
    status, apply_res = asyncio.run(
        call("POST", f"/api/platform/templates/{template_id}/apply", apply_payload)
    )
    assert status == 201
    assert "conflicts" in apply_res
    conflicts = apply_res["conflicts"]

    # Flow should be renamed to Login Flow_2
    flow_conflict = next((c for c in conflicts if c["resourceType"] == "flows"), None)
    assert flow_conflict is not None
    assert flow_conflict["originalName"] == "Login Flow"
    assert flow_conflict["newName"] == "Login Flow_2"

    # Variable secret_token should be renamed to secret_token_2
    var_conflict = next((c for c in conflicts if c["resourceType"] == "variables"), None)
    assert var_conflict is not None
    assert var_conflict["originalName"] == "secret_token"
    assert var_conflict["newName"] == "secret_token_2"

    # Created resources check:
    created = apply_res["created"]
    assert len(created["flows"]) == 1
    # elem-source-1 was mapped, so only elem-source-2 was created (total 1 element created)
    assert len(created["elements"]) == 1
    assert len(created["variables"]) == 2
    assert len(created["environments"]) == 0

    # Verify flow step element and placeholder rewriting in DB
    created_flow_id = created["flows"][0]
    flow_row = services.database.execute(
        "SELECT data FROM project_resources WHERE project_id = 'proj-target' AND resource_id = ?",
        (created_flow_id,),
    ).fetchone()
    flow_in_db = json.loads(flow_row[0])
    assert flow_in_db["name"] == "Login Flow_2"
    assert flow_in_db["secretNames"] == ["project.secret_token_2"]
    # Step 1 should have rewritten element to target_login_button
    assert flow_in_db["steps"][0]["element"] == "target_login_button"
    assert flow_in_db["steps"][0]["value"] == "{{project.secret_token_2}}"
    # Step 2 element input_user was created new
    assert flow_in_db["steps"][1]["element"] == "input_user"

    # 6. Verify empty secret placeholder in project_secrets
    secret_row = services.database.execute(
        "SELECT name, ciphertext FROM project_secrets WHERE project_id = 'proj-target' AND name = 'project.secret_token_2'",
    ).fetchone()
    assert secret_row is not None
    assert secret_row[0] == "project.secret_token_2"

    # 7. Test re-publish endpoint
    rev_id_2 = "rev-2"
    flow_data_v2 = {**flow_data, "name": "Login Flow v2"}
    services.database.execute(
        """
        INSERT INTO flow_revisions (
          id, project_id, revision_number, status, flow_snapshot, environment_snapshot,
          element_snapshot, dataset_snapshot, checksum, created_at, created_by
        ) VALUES (?, ?, 2, 'published', ?, ?, ?, '{}', 'chk2', ?, ?)
        """,
        (
            rev_id_2,
            "proj-source",
            json.dumps(flow_data_v2),
            json.dumps(env_data),
            json.dumps(elements_data),
            now(),
            user.id,
        ),
    )

    status, repub_res = asyncio.run(
        call(
            "POST",
            f"/api/platform/templates/{template_id}/re-publish",
            {"revisionId": rev_id_2},
        )
    )
    assert status == 200
    assert repub_res["template"]["sourceRevisionId"] == rev_id_2
    assert repub_res["template"]["snapshot"]["flow"]["name"] == "Login Flow v2"


def test_templates_api_errors_and_edge_cases(tmp_path):
    services = PlatformServices(str(tmp_path))
    router = create_platform_router(services)

    owner = AuthUser("user-owner", "owner@example.test", "Owner")
    member = AuthUser("user-member", "member@example.test", "Member")
    services.database.execute(
        "INSERT INTO platform_users (id, email, name, created_at) VALUES (?, ?, ?, ?)",
        (owner.id, owner.email, owner.name, now()),
    )
    services.database.execute(
        "INSERT INTO platform_users (id, email, name, created_at) VALUES (?, ?, ?, ?)",
        (member.id, member.email, member.name, now()),
    )
    workspace = services.create_workspace(owner, "Edge Workspace")
    workspace_id = workspace["id"]

    services.database.execute(
        """
        INSERT INTO platform_projects (
          id, workspace_id, slug, name, description, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        ("proj-1", workspace_id, "proj-1", "Proj 1", "", now(), now()),
    )

    owner_session = services.create_auth_session(owner)
    member_session = services.create_auth_session(member)

    async def call(session_token: str, method: str, path: str, body: dict | None = None, query: str = ""):
        headers = {
            b"authorization": f"Bearer {session_token}".encode(),
            b"content-type": b"application/json",
        }
        for route in router.routes:
            match, child_scope = route.matches({
                "type": "http",
                "method": method,
                "path": path,
                "headers": list(headers.items()),
                "query_string": query.encode(),
            })
            if match.name == "FULL":
                scope = {
                    "type": "http",
                    "method": method,
                    "path": path,
                    "headers": list(headers.items()),
                    "query_string": query.encode(),
                    "path_params": child_scope.get("path_params", {}),
                }
                body_bytes = json.dumps(body).encode() if body is not None else b""

                async def receive():
                    return {"type": "http.request", "body": body_bytes, "more_body": False}

                req = Request(scope, receive)
                resp = await route.endpoint(req, **child_scope.get("path_params", {}))
                return resp.status_code, json.loads(resp.body.decode())
        raise RuntimeError(f"Route not found: {method} {path}")

    # Create published revision with an unmapped element reference that doesn't exist
    flow_data = {
        "id": "flow-broken",
        "name": "Broken Flow",
        "steps": [
            {"id": "s1", "element": "non_existent_elem", "value": "val"},
        ],
    }
    rev_id = "rev-broken"
    services.database.execute(
        """
        INSERT INTO flow_revisions (
          id, project_id, revision_number, status, flow_snapshot, environment_snapshot,
          element_snapshot, dataset_snapshot, checksum, created_at, created_by
        ) VALUES (?, ?, 1, 'published', ?, '{}', '[]', '{}', 'chk', ?, ?)
        """,
        (rev_id, "proj-1", json.dumps(flow_data), now(), owner.id),
    )

    # Publish template
    status, res = asyncio.run(
        call(
            owner_session["token"],
            "POST",
            "/api/platform/templates",
            {"projectId": "proj-1", "revisionId": rev_id, "name": "Broken Template"},
            query=f"workspaceId={workspace_id}",
        )
    )
    assert status == 201
    tmpl_id = res["template"]["id"]

    # 1. Dependency missing error: flow references non_existent_elem which is neither in template snapshot nor in target project
    with pytest.raises(Exception) as excinfo:
        asyncio.run(
            call(
                owner_session["token"],
                "POST",
                f"/api/platform/templates/{tmpl_id}/apply",
                {"projectId": "proj-1", "selection": {"flow": True}},
            )
        )
    assert "TEMPLATE_DEPENDENCY_MISSING" in str(excinfo.value)

    # 2. Invalid element mapping target error
    with pytest.raises(Exception) as excinfo:
        asyncio.run(
            call(
                owner_session["token"],
                "POST",
                f"/api/platform/templates/{tmpl_id}/apply",
                {
                    "projectId": "proj-1",
                    "elementMappings": {"some-elem": "target-elem-does-not-exist"},
                },
            )
        )
    assert "INVALID_ELEMENT_MAPPING" in str(excinfo.value)

    # 3. Missing variable reference test: should not throw 400, but generate warning
    flow_with_missing_var = {
        "id": "flow-var-warn",
        "name": "Var Warn Flow",
        "steps": [
            {"id": "s1", "action": "填写", "value": "{{project.unconfigured_var}}"},
        ],
    }
    rev_id_var = "rev-var-warn"
    services.database.execute(
        """
        INSERT INTO flow_revisions (
          id, project_id, revision_number, status, flow_snapshot, environment_snapshot,
          element_snapshot, dataset_snapshot, checksum, created_at, created_by
        ) VALUES (?, ?, 2, 'published', ?, '{}', '[]', '{}', 'chk_var', ?, ?)
        """,
        (rev_id_var, "proj-1", json.dumps(flow_with_missing_var), now(), owner.id),
    )
    status, res_var = asyncio.run(
        call(
            owner_session["token"],
            "POST",
            "/api/platform/templates",
            {"projectId": "proj-1", "revisionId": rev_id_var, "name": "Var Warn Template"},
            query=f"workspaceId={workspace_id}",
        )
    )
    assert status == 201
    tmpl_var_id = res_var["template"]["id"]

    status, apply_var_res = asyncio.run(
        call(
            owner_session["token"],
            "POST",
            f"/api/platform/templates/{tmpl_var_id}/apply",
            {"projectId": "proj-1", "selection": {"flow": True}},
        )
    )
    assert status == 201
    assert any("unconfigured_var" in w for w in apply_var_res.get("warnings", []))
