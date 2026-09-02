"""Internal template library routes."""
from __future__ import annotations

import uuid
from typing import Any
from fastapi import APIRouter, Request, Response
from ..core import json, now, parse_json
from ..http import PlatformError
from ..resources import as_record, public_resource_data
from ..templates import extract_flow_element_references, extract_flow_variable_references, rewrite_flow_placeholders_and_elements, rewrite_template_references
from ..services import PlatformServices
from ._shared import (
    _send,
    _text,
)


def register(router: APIRouter, services: PlatformServices) -> None:

    @router.api_route("/api/platform/templates", methods=["GET", "POST"])
    async def templates(request: Request) -> Response:
        user = services.session_user(dict(request.headers))
        workspace_id = request.query_params.get("workspaceId", "")
        services.require_workspace_role(
            workspace_id, user.id, request.method == "POST"
        )
        if request.method == "GET":
            q = request.query_params.get("q", "").strip()[:100]
            search = f"%{q}%"
            category = request.query_params.get("category")
            query = """
                SELECT t.id, t.name, t.description, t.category,
                       t.source_project_id, t.source_revision_id,
                       t.created_by, t.created_at, t.updated_at,
                       CASE WHEN f.user_id IS NULL THEN 0 ELSE 1 END favorite
                FROM internal_templates t
                LEFT JOIN template_favorites f
                  ON f.template_id = t.id AND f.user_id = ?
                WHERE t.workspace_id = ? AND t.deleted_at IS NULL
                  AND (t.name LIKE ? OR t.description LIKE ?)
            """
            params: list[Any] = [user.id, workspace_id, search, search]
            if category:
                query += " AND t.category = ?"
                params.append(category)
            query += " ORDER BY favorite DESC, t.updated_at DESC"
            rows = services.database.execute(query, tuple(params)).fetchall()
            return _send(
                Response(),
                200,
                {
                    "templates": [
                        {
                            "id": row[0],
                            "name": row[1],
                            "description": row[2],
                            "category": row[3],
                            "sourceProjectId": row[4],
                            "sourceRevisionId": row[5],
                            "createdBy": row[6],
                            "createdAt": row[7],
                            "updatedAt": row[8],
                            "favorite": bool(row[9]),
                        }
                        for row in rows
                    ]
                },
            )

        body = await request.json()
        if not isinstance(body, dict):
            body = {}
        project_id = _text(body.get("projectId")).strip()
        revision_id = _text(body.get("revisionId")).strip()
        result = services.require_project_capability(
            project_id, user.id, "release.publish"
        )
        project = result["project"]
        name = _text(body.get("name")).strip()
        if project["workspace_id"] != workspace_id or not name:
            raise PlatformError(400, "TEMPLATE_INPUT_INVALID")
        revision = services.database.execute(
            """
            SELECT id, status, flow_snapshot, environment_snapshot,
                   element_snapshot
            FROM flow_revisions WHERE id = ? AND project_id = ?
            """,
            (revision_id, project_id),
        ).fetchone()
        if not revision or revision[1] != "published":
            raise PlatformError(409, "PUBLISHED_REVISION_REQUIRED")
        variables = services.database.execute(
            """
            SELECT data FROM project_resources
            WHERE project_id = ? AND resource_type = 'variables'
              AND archived_at IS NULL
            """,
            (project_id,),
        ).fetchall()
        snapshot = {
            "flow": parse_json(revision[2], {}),
            "environments": [parse_json(revision[3], {})],
            "elements": parse_json(revision[4], []),
            "variables": [
                public_resource_data(parse_json(row[0], {})) for row in variables
            ],
        }
        template_id = str(uuid.uuid4())
        created_at = now()
        services.database.execute(
            """
            INSERT INTO internal_templates (
              id, workspace_id, source_project_id, source_revision_id, name,
              description, category, snapshot, created_by, created_at,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                template_id,
                workspace_id,
                project_id,
                revision[0],
                name[:160],
                _text(body.get("description")).strip()[:1000],
                _text(body.get("category")).strip()[:80] or "通用",
                json(snapshot),
                user.id,
                created_at,
                created_at,
            ),
        )
        services.audit(
            workspace_id,
            {"type": "user", "id": user.id},
            "template.published",
            {"type": "template", "id": template_id},
            {"sourceRevisionId": revision[0]},
            project_id,
        )
        return _send(
            Response(),
            201,
            {
                "template": {
                    "id": template_id,
                    "name": name,
                    "description": _text(body.get("description")).strip(),
                    "category": _text(body.get("category")).strip() or "通用",
                    "favorite": False,
                    "createdAt": created_at,
                    "updatedAt": created_at,
                }
            },
        )

    @router.api_route(
        "/api/platform/templates/{template_id}", methods=["GET", "PATCH", "DELETE"]
    )
    async def template_detail(
        request: Request, template_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        template = services.database.execute(
            """
            SELECT id, workspace_id, name, description, category, snapshot,
                   created_by, source_project_id, source_revision_id,
                   created_at, updated_at
            FROM internal_templates WHERE id = ? AND deleted_at IS NULL
            """,
            (template_id,),
        ).fetchone()
        if not template:
            raise PlatformError(404, "TEMPLATE_NOT_FOUND")
        services.require_workspace_role(template[1], user.id)
        if request.method == "GET":
            return _send(
                Response(),
                200,
                {
                    "template": {
                        "id": template[0],
                        "name": template[2],
                        "description": template[3],
                        "category": template[4],
                        "snapshot": parse_json(template[5], {}),
                        "sourceProjectId": template[7],
                        "sourceRevisionId": template[8],
                        "createdBy": template[6],
                        "createdAt": template[9],
                        "updatedAt": template[10],
                    }
                },
            )
        services.require_workspace_role(template[1], user.id)
        if template[6] != user.id:
            services.require_workspace_capability(
                template[1], user.id, "project.manage"
            )
        if request.method == "DELETE":
            services.database.execute(
                """
                UPDATE internal_templates SET deleted_at = ?, updated_at = ?
                WHERE id = ? AND workspace_id = ?
                """,
                (now(), now(), template_id, template[1]),
            )
            services.audit(
                template[1],
                {"type": "user", "id": user.id},
                "template.deleted",
                {"type": "template", "id": template_id},
            )
            return _send(Response(), 200, {"templateId": template_id, "deleted": True})

        body = await request.json()
        if not isinstance(body, dict):
            body = {}
        name = _text(body.get("name")).strip()[:160]
        if not name:
            raise PlatformError(400, "TEMPLATE_NAME_REQUIRED")
        description = _text(body.get("description")).strip()[:1000]
        category = _text(body.get("category")).strip()[:80] or "通用"
        updated_at = now()
        services.database.execute(
            """
            UPDATE internal_templates
            SET name = ?, description = ?, category = ?, updated_at = ?
            WHERE id = ? AND workspace_id = ?
            """,
            (name, description, category, updated_at, template_id, template[1]),
        )
        services.audit(
            template[1],
            {"type": "user", "id": user.id},
            "template.updated",
            {"type": "template", "id": template_id},
            {"name": name, "category": category},
        )
        return _send(
            Response(),
            200,
            {
                "template": {
                    "id": template_id,
                    "name": name,
                    "description": description,
                    "category": category,
                    "sourceProjectId": template[7],
                    "sourceRevisionId": template[8],
                    "createdBy": template[6],
                    "createdAt": template[9],
                    "updatedAt": updated_at,
                }
            },
        )

    @router.api_route(
        "/api/platform/templates/{template_id}/favorite",
        methods=["POST", "DELETE"],
    )
    async def template_favorite(
        request: Request, template_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        template = services.database.execute(
            """
            SELECT workspace_id FROM internal_templates
            WHERE id = ? AND deleted_at IS NULL
            """,
            (template_id,),
        ).fetchone()
        if not template:
            raise PlatformError(404, "TEMPLATE_NOT_FOUND")
        services.require_workspace_role(template[0], user.id)
        if request.method == "POST":
            services.database.execute(
                """
                INSERT OR IGNORE INTO template_favorites (
                  template_id, user_id, created_at
                ) VALUES (?, ?, ?)
                """,
                (template_id, user.id, now()),
            )
        else:
            services.database.execute(
                """
                DELETE FROM template_favorites
                WHERE template_id = ? AND user_id = ?
                """,
                (template_id, user.id),
            )
        return _send(
            Response(),
            200,
            {"templateId": template_id, "favorite": request.method == "POST"},
        )

    @router.api_route(
        "/api/platform/templates/{template_id}/re-publish", methods=["POST"]
    )
    async def template_republish(
        request: Request, template_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        template = services.database.execute(
            """
            SELECT id, workspace_id, name, description, category,
                   snapshot, created_by, source_project_id,
                   source_revision_id, created_at, updated_at
            FROM internal_templates WHERE id = ? AND deleted_at IS NULL
            """,
            (template_id,),
        ).fetchone()
        if not template:
            raise PlatformError(404, "TEMPLATE_NOT_FOUND")
        if template[6] != user.id:
            services.require_workspace_role(template[1], user.id, True)
        body = await request.json()
        if not isinstance(body, dict):
            body = {}
        revision_id = _text(body.get("revisionId")).strip()
        if not revision_id:
            raise PlatformError(400, "REVISION_ID_REQUIRED")
        source_project_id = template[7]
        services.require_project_capability(
            source_project_id, user.id, "release.publish"
        )
        revision = services.database.execute(
            """
            SELECT id, status, flow_snapshot, environment_snapshot,
                   element_snapshot
            FROM flow_revisions WHERE id = ? AND project_id = ?
            """,
            (revision_id, source_project_id),
        ).fetchone()
        if not revision or revision[1] != "published":
            raise PlatformError(409, "PUBLISHED_REVISION_REQUIRED")
        variables = services.database.execute(
            """
            SELECT data FROM project_resources
            WHERE project_id = ? AND resource_type = 'variables'
              AND archived_at IS NULL
            """,
            (source_project_id,),
        ).fetchall()
        snapshot = {
            "flow": parse_json(revision[2], {}),
            "environments": [parse_json(revision[3], {})],
            "elements": parse_json(revision[4], []),
            "variables": [
                public_resource_data(parse_json(row[0], {})) for row in variables
            ],
        }
        updated_at = now()
        services.database.execute(
            """
            UPDATE internal_templates
            SET snapshot = ?, source_revision_id = ?, updated_at = ?
            WHERE id = ? AND workspace_id = ? AND source_project_id = ?
            """,
            (
                json(snapshot),
                revision_id,
                updated_at,
                template_id,
                template[1],
                source_project_id,
            ),
        )
        services.audit(
            template[1],
            {"type": "user", "id": user.id},
            "template.republished",
            {"type": "template", "id": template_id},
            {"sourceRevisionId": revision_id},
            source_project_id,
        )
        return _send(
            Response(),
            200,
            {
                "template": {
                    "id": template_id,
                    "name": template[2],
                    "description": template[3],
                    "category": template[4],
                    "snapshot": snapshot,
                    "sourceProjectId": template[7],
                    "sourceRevisionId": revision_id,
                    "createdBy": template[6],
                    "createdAt": template[9],
                    "updatedAt": updated_at,
                }
            },
        )

    @router.api_route(
        "/api/platform/templates/{template_id}/apply-candidates",
        methods=["GET"],
    )
    async def template_apply_candidates(
        request: Request, template_id: str
    ) -> Response:
        user = services.session_user(dict(request.headers))
        template = services.database.execute(
            """
            SELECT id, workspace_id FROM internal_templates
            WHERE id = ? AND deleted_at IS NULL
            """,
            (template_id,),
        ).fetchone()
        if not template:
            raise PlatformError(404, "TEMPLATE_NOT_FOUND")
        project_id = request.query_params.get("projectId", "").strip()
        if not project_id:
            raise PlatformError(400, "PROJECT_ID_REQUIRED")
        result = services.require_project_capability(
            project_id, user.id, "flow.edit"
        )
        project = result["project"]
        if project["workspace_id"] != template[1]:
            raise PlatformError(403, "TEMPLATE_WORKSPACE_MISMATCH")
        rows = services.database.execute(
            """
            SELECT data FROM project_resources
            WHERE project_id = ? AND resource_type = 'elements'
              AND archived_at IS NULL
            ORDER BY updated_at DESC
            """,
            (project_id,),
        ).fetchall()
        candidates = []
        for row in rows:
            elem = parse_json(row[0], {})
            if isinstance(elem, dict) and elem.get("id"):
                candidates.append({
                    "id": elem.get("id"),
                    "name": elem.get("name") or "",
                    "selector": elem.get("value") or elem.get("selector") or "",
                    "method": elem.get("method") or "css",
                    "environment": elem.get("environment") or "",
                })
        return _send(
            Response(),
            200,
            {"candidates": candidates},
        )

    @router.api_route(
        "/api/platform/templates/{template_id}/apply", methods=["POST"]
    )
    async def template_apply(request: Request, template_id: str) -> Response:
        user = services.session_user(dict(request.headers))
        template = services.database.execute(
            """
            SELECT id, workspace_id, snapshot FROM internal_templates
            WHERE id = ? AND deleted_at IS NULL
            """,
            (template_id,),
        ).fetchone()
        if not template:
            raise PlatformError(404, "TEMPLATE_NOT_FOUND")
        body = await request.json()
        if not isinstance(body, dict):
            body = {}
        project_id = _text(body.get("projectId")).strip()
        if not project_id:
            raise PlatformError(400, "PROJECT_ID_REQUIRED")
        result = services.require_project_capability(
            project_id, user.id, "flow.edit"
        )
        project = result["project"]
        if project["workspace_id"] != template[1]:
            raise PlatformError(403, "TEMPLATE_WORKSPACE_MISMATCH")
        snapshot = parse_json(template[2], {})
        if not isinstance(snapshot, dict):
            snapshot = {}

        raw_selection = body.get("selection")
        selection: dict[str, Any] | None = raw_selection if isinstance(raw_selection, dict) else None

        raw_mappings = body.get("elementMappings")
        element_mappings: dict[str, str | None] = (
            {
                str(k): (str(v).strip() if isinstance(v, str) and v.strip() else None)
                for k, v in raw_mappings.items()
            }
            if isinstance(raw_mappings, dict)
            else {}
        )

        raw_flow = as_record(snapshot.get("flow"))
        raw_elements = [
            as_record(item)
            for item in snapshot.get("elements", [])
            if isinstance(item, dict)
        ]
        raw_variables = [
            as_record(item)
            for item in snapshot.get("variables", [])
            if isinstance(item, dict)
        ]
        raw_environments = [
            as_record(item)
            for item in snapshot.get("environments", [])
            if isinstance(item, dict)
        ]

        if selection is None:
            apply_flow = bool(raw_flow)
            selected_elem_ids = {e["id"] for e in raw_elements if "id" in e}
            selected_var_ids = {v["id"] for v in raw_variables if "id" in v}
            apply_environments = bool(raw_environments)
        else:
            apply_flow = bool(selection.get("flow", True)) if raw_flow else False

            sel_elem = selection.get("elements")
            if sel_elem is True or sel_elem is None:
                selected_elem_ids = {e["id"] for e in raw_elements if "id" in e}
            elif isinstance(sel_elem, list):
                selected_elem_ids = {str(eid) for eid in sel_elem}
            else:
                selected_elem_ids = set()

            sel_var = selection.get("variables")
            if sel_var is True or sel_var is None:
                selected_var_ids = {v["id"] for v in raw_variables if "id" in v}
            elif isinstance(sel_var, list):
                selected_var_ids = {str(vid) for vid in sel_var}
            else:
                selected_var_ids = set()

            sel_env = selection.get("environments")
            apply_environments = bool(sel_env) if sel_env is not None else True

        # Existing target elements for mapping check
        existing_elements_rows = services.database.execute(
            """
            SELECT resource_id, data FROM project_resources
            WHERE project_id = ? AND resource_type = 'elements' AND archived_at IS NULL
            """,
            (project_id,),
        ).fetchall()
        target_elements_by_id: dict[str, dict[str, Any]] = {}
        for row in existing_elements_rows:
            elem_data = parse_json(row[1], {})
            elem_id = row[0]
            if isinstance(elem_data, dict):
                target_elements_by_id[elem_id] = elem_data

        mapped_target_ids: dict[str, str] = {}
        mapped_target_names: dict[str, str] = {}
        for tmpl_elem_id, target_id in element_mappings.items():
            if target_id:
                if target_id not in target_elements_by_id:
                    raise PlatformError(400, f"INVALID_ELEMENT_MAPPING: {target_id}")
                mapped_target_ids[tmpl_elem_id] = target_id
                target_elem_data = target_elements_by_id[target_id]
                tmpl_elem = next((e for e in raw_elements if e.get("id") == tmpl_elem_id), None)
                if tmpl_elem and tmpl_elem.get("name") and target_elem_data.get("name"):
                    mapped_target_names[tmpl_elem["name"]] = target_elem_data["name"]

        warnings: list[str] = []

        # Dependency Closure (D6):
        # 1. 元素是「严格强依赖」：步骤缺少 UI 定位器会导致流程不可执行，未映射且模板内未声明时抛 400 (TEMPLATE_DEPENDENCY_MISSING)。
        # 2. 变量是「宽松容错」：除系统前缀(data/flow/run/env.baseUrl)外，优先自动闭包模板内变量；若模板与目标项目中均缺失，则记录 warning 提示用户补齐。
        if apply_flow:
            flow_elem_refs = extract_flow_element_references(raw_flow)
            for ref in flow_elem_refs:
                is_mapped = False
                matched_tmpl_elem = None
                for elem in raw_elements:
                    if elem.get("id") == ref or elem.get("name") == ref:
                        matched_tmpl_elem = elem
                        if elem.get("id") and elem["id"] in mapped_target_ids:
                            is_mapped = True
                        break

                if is_mapped:
                    continue

                if matched_tmpl_elem:
                    if matched_tmpl_elem.get("id"):
                        selected_elem_ids.add(matched_tmpl_elem["id"])
                else:
                    target_has_ref = any(
                        t_id == ref or t_data.get("name") == ref
                        for t_id, t_data in target_elements_by_id.items()
                    )
                    if not target_has_ref:
                        raise PlatformError(400, "TEMPLATE_DEPENDENCY_MISSING")

            flow_var_refs = extract_flow_variable_references(raw_flow)
            for var_ref in flow_var_refs:
                matched_tmpl_var = None
                for var in raw_variables:
                    v_name = var.get("name")
                    v_scope = var.get("scope", "项目")
                    v_ref1 = f"{'env' if v_scope == '环境' else 'project'}.{v_name}"
                    if var_ref in (v_name, v_ref1, f"secret.{v_name}"):
                        matched_tmpl_var = var
                        break
                if matched_tmpl_var and matched_tmpl_var.get("id"):
                    selected_var_ids.add(matched_tmpl_var["id"])

        elements_to_create = [
            dict(e) for e in raw_elements
            if e.get("id") in selected_elem_ids and e.get("id") not in mapped_target_ids
        ]
        variables_to_create = [
            dict(v) for v in raw_variables
            if v.get("id") in selected_var_ids
        ]
        environments_to_create = (
            [dict(env) for env in raw_environments] if apply_environments else []
        )
        flow_to_create = dict(raw_flow) if apply_flow else None

        existing_res_rows = services.database.execute(
            """
            SELECT resource_type,
                   json_extract(data, '$.name') AS name,
                   json_extract(data, '$.scope') AS scope,
                   json_extract(data, '$.environment') AS environment
            FROM project_resources
            WHERE project_id = ? AND archived_at IS NULL
            """,
            (project_id,),
        ).fetchall()

        existing_flow_names: set[str] = set()
        existing_env_names: set[str] = set()
        existing_var_keys: set[tuple[str, str]] = set()
        existing_elem_keys: set[tuple[str, str]] = set()

        for row in existing_res_rows:
            r_type, r_name, r_scope, r_env = row[0], row[1] or "", row[2] or "", row[3] or ""
            if r_type == "flows":
                existing_flow_names.add(r_name)
            elif r_type == "environments":
                existing_env_names.add(r_name)
            elif r_type == "variables":
                existing_var_keys.add((r_scope, r_name))
            elif r_type == "elements":
                existing_elem_keys.add((r_env, r_name))

        if apply_flow:
            for var_ref in flow_var_refs:
                in_template = any(
                    var.get("name") == var_ref
                    or f"{'env' if var.get('scope') == '环境' else 'project'}.{var.get('name')}" == var_ref
                    or f"secret.{var.get('name')}" == var_ref
                    for var in raw_variables
                )
                in_target = any(
                    name == var_ref
                    or f"{'env' if scope == '环境' else 'project'}.{name}" == var_ref
                    or f"secret.{name}" == var_ref
                    for scope, name in existing_var_keys
                )
                if not in_template and not in_target:
                    warnings.append(f"流程引用的变量 '{{{{{var_ref}}}}}' 在模板与目标项目中均未找到定义，请在项目变量中手动配置")

        conflicts: list[dict[str, str]] = []
        ref_renames: dict[str, str] = {}
        element_name_renames: dict[str, str] = dict(mapped_target_names)

        def _get_unique_name(base: str, is_taken_fn) -> str:
            if not is_taken_fn(base):
                return base
            idx = 2
            while True:
                candidate = f"{base}_{idx}"
                if not is_taken_fn(candidate):
                    return candidate
                idx += 1

        if flow_to_create:
            orig_flow_name = flow_to_create.get("name", "流程")
            if orig_flow_name in existing_flow_names:
                new_flow_name = _get_unique_name(orig_flow_name, lambda n: n in existing_flow_names)
                flow_to_create["name"] = new_flow_name
                existing_flow_names.add(new_flow_name)
                conflicts.append({
                    "resourceType": "flows",
                    "originalName": orig_flow_name,
                    "newName": new_flow_name,
                })

        for env in environments_to_create:
            orig_env_name = env.get("name", "")
            if orig_env_name and orig_env_name in existing_env_names:
                new_env_name = _get_unique_name(orig_env_name, lambda n: n in existing_env_names)
                env["name"] = new_env_name
                existing_env_names.add(new_env_name)
                conflicts.append({
                    "resourceType": "environments",
                    "originalName": orig_env_name,
                    "newName": new_env_name,
                })

        for var in variables_to_create:
            orig_var_name = var.get("name", "")
            var_scope = var.get("scope", "项目")
            if orig_var_name and (var_scope, orig_var_name) in existing_var_keys:
                new_var_name = _get_unique_name(
                    orig_var_name,
                    lambda n: (var_scope, n) in existing_var_keys,
                )
                var["name"] = new_var_name
                existing_var_keys.add((var_scope, new_var_name))
                conflicts.append({
                    "resourceType": "variables",
                    "originalName": orig_var_name,
                    "newName": new_var_name,
                })
                scope_prefix = "env" if var_scope == "环境" else "project"
                ref_renames[f"{scope_prefix}.{orig_var_name}"] = f"{scope_prefix}.{new_var_name}"
                ref_renames[orig_var_name] = new_var_name
                ref_renames[f"secret.{orig_var_name}"] = f"secret.{new_var_name}"

        for elem in elements_to_create:
            orig_elem_name = elem.get("name", "")
            elem_env = elem.get("environment", "")
            if orig_elem_name and (elem_env, orig_elem_name) in existing_elem_keys:
                new_elem_name = _get_unique_name(
                    orig_elem_name,
                    lambda n: (elem_env, n) in existing_elem_keys,
                )
                elem["name"] = new_elem_name
                existing_elem_keys.add((elem_env, new_elem_name))
                conflicts.append({
                    "resourceType": "elements",
                    "originalName": orig_elem_name,
                    "newName": new_elem_name,
                })
                element_name_renames[orig_elem_name] = new_elem_name

        ids: dict[str, str] = {}
        for tmpl_elem_id, target_id in mapped_target_ids.items():
            ids[tmpl_elem_id] = target_id

        resources_to_insert: dict[str, list[dict[str, Any]]] = {
            "flows": [flow_to_create] if flow_to_create else [],
            "elements": elements_to_create,
            "variables": variables_to_create,
            "environments": environments_to_create,
        }

        for r_list in resources_to_insert.values():
            for res in r_list:
                old_id = res.get("id")
                if isinstance(old_id, str):
                    new_id = str(uuid.uuid4())
                    ids[old_id] = new_id

        if flow_to_create:
            flow_to_create = rewrite_flow_placeholders_and_elements(
                flow_to_create, ref_renames, element_name_renames
            )
            resources_to_insert["flows"] = [flow_to_create]

        created: dict[str, list[str]] = {}
        services.database.execute("BEGIN IMMEDIATE")
        try:
            for resource_type, resources in resources_to_insert.items():
                created[resource_type] = []
                for source in resources:
                    old_id = (
                        source.get("id")
                        if isinstance(source.get("id"), str)
                        else str(uuid.uuid4())
                    )
                    resource_id = ids.get(old_id, str(uuid.uuid4()))
                    rewritten = public_resource_data(
                        rewrite_template_references({**source, "id": resource_id}, ids)
                    )
                    services.database.execute(
                        """
                        INSERT INTO project_resources (
                          project_id, resource_type, resource_id, data, version,
                          updated_at, updated_by
                        ) VALUES (?, ?, ?, ?, 1, ?, ?)
                        """,
                        (
                            project_id,
                            resource_type,
                            resource_id,
                            json(rewritten),
                            now(),
                            user.id,
                        ),
                    )
                    created[resource_type].append(resource_id)
            services.database.execute("COMMIT")
        except Exception:
            services.database.execute("ROLLBACK")
            raise

        if flow_to_create:
            secret_names = flow_to_create.get("secretNames")
            if isinstance(secret_names, list):
                for secret_name in secret_names:
                    if isinstance(secret_name, str) and secret_name.strip():
                        s_name = secret_name.strip()
                        try:
                            encrypted = services.encrypt("")
                            secret_id = str(uuid.uuid4())
                            services.database.execute(
                                """
                                INSERT INTO project_secrets (
                                  id, project_id, name, key_version, iv, tag, ciphertext,
                                  created_at, updated_at
                                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                                ON CONFLICT(project_id, name) DO NOTHING
                                """,
                                (
                                    secret_id,
                                    project_id,
                                    s_name,
                                    services.active_secret_version,
                                    encrypted["iv"],
                                    encrypted["tag"],
                                    encrypted["ciphertext"],
                                    now(),
                                    now(),
                                ),
                            )
                        except Exception:
                            warnings.append(
                                f"创建密钥占位符 {s_name} 失败: SECRET_PLACEHOLDER_FAILED"
                            )

        services.audit(
            template[1],
            {"type": "user", "id": user.id},
            "template.applied",
            {"type": "template", "id": template_id},
            {
                "targetProjectId": project_id,
                "created": created,
                "selection": selection,
                "elementMappings": element_mappings,
                "conflicts": conflicts,
            },
            project_id,
        )
        return _send(
            Response(),
            201,
            {
                "templateId": template_id,
                "projectId": project_id,
                "created": created,
                "conflicts": conflicts,
                "warnings": warnings,
            },
        )
