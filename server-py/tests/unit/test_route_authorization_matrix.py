"""Executable authorization inventory for the Platform router.

The table is deliberately test-owned: a new route or method must be classified
here before it can pass the isolation gate.  It documents the parent resolver
that must run before a handler reads or mutates a resource.
"""

from dataclasses import dataclass

from autoflow.handler import create_platform_router
from autoflow.services import PlatformServices


@dataclass(frozen=True)
class RoutePolicy:
    path: str
    method: str
    auth: str
    scope: str
    capability: str
    parent: str
    note: str = ""


def _rows(
    path: str,
    methods: str,
    *,
    auth: str,
    scope: str,
    capability: str,
    parent: str,
    note: str = "",
) -> list[RoutePolicy]:
    return [
        RoutePolicy(path, method, auth, scope, capability, parent, note)
        for method in methods.split()
    ]


def _public(path: str, methods: str, note: str) -> list[RoutePolicy]:
    return _rows(
        path,
        methods,
        auth="public",
        scope="none",
        capability="none",
        parent="none",
        note=note,
    )


def _deployment(path: str, methods: str, capability: str) -> list[RoutePolicy]:
    return _rows(
        path,
        methods,
        auth="session",
        scope="deployment",
        capability=capability,
        parent="deployment session user",
    )


def _workspace(path: str, methods: str, capability: str) -> list[RoutePolicy]:
    return _rows(
        path,
        methods,
        auth="session",
        scope="workspace",
        capability=capability,
        parent="workspace_id -> membership/capability",
    )


def _project(path: str, methods: str, capability: str) -> list[RoutePolicy]:
    return _rows(
        path,
        methods,
        auth="session",
        scope="project",
        capability=capability,
        parent="project_id -> project.workspace_id -> capability",
    )


def _indirect(path: str, methods: str, capability: str, parent: str) -> list[RoutePolicy]:
    return _rows(
        path,
        methods,
        auth="session",
        scope="indirect-project",
        capability=capability,
        parent=parent,
    )


ROUTE_POLICIES = [
    *_public("/api/platform/health", "GET", "readiness probe"),
    *_public("/api/auth/register", "POST", "terminal registration-disabled response"),
    *_public("/api/auth/login", "POST", "credential exchange"),
    *_public("/api/auth/logout", "POST", "revokes the presented session only"),
    *_public("/api/auth/session", "GET", "session projection; invalid sessions are rejected"),
    *_public("/api/auth/invitations/accept", "POST", "one-time token acceptance"),
    *_public("/api/auth/password-resets/accept", "POST", "one-time reset token acceptance"),
    *_public("/api/platform/webhooks/{trigger_id}", "POST", "signed webhook; trigger resolves its own project"),
    *_deployment("/api/admin/accounts", "GET", "account.manage"),
    *_deployment("/api/admin/accounts/{account_id}", "PATCH", "account.manage"),
    *_deployment("/api/admin/accounts/{account_id}/password-reset", "POST", "account.manage"),
    *_deployment("/api/workspaces", "GET", "super_admin"),
    *_deployment("/api/workspaces", "POST", "super_admin"),
    *_workspace("/api/workspaces/{workspace_id}/members", "GET", "member.view"),
    *_workspace("/api/workspaces/{workspace_id}/members/{member_id}", "PATCH DELETE", "member.manage"),
    *_workspace("/api/workspaces/{workspace_id}/invitations", "GET", "invite.view"),
    *_workspace("/api/workspaces/{workspace_id}/invitations", "POST", "invite.manage"),
    *_workspace("/api/workspaces/{workspace_id}/invitations/{invitation_id}/revoke", "POST", "invite.manage"),
    *_workspace("/api/workspaces/{workspace_id}/projects", "GET", "project.view"),
    *_workspace("/api/workspaces/{workspace_id}/projects", "POST", "project.manage"),
    *_workspace("/api/workspaces/{workspace_id}/imports/local-storage", "POST", "project.manage"),
    *_workspace("/api/platform/workspaces/{workspace_id}/notification-channels", "GET", "workspace membership"),
    *_workspace("/api/platform/workspaces/{workspace_id}/notification-channels", "POST", "automation.manage"),
    *_workspace("/api/platform/workspaces/{workspace_id}/notification-channels/{channel_id}", "PUT DELETE", "automation.manage"),
    *_workspace("/api/platform/workspaces/{workspace_id}/notification-channels/{channel_id}/test", "POST", "automation.manage"),
    *_project("/api/platform/projects/{project_id}", "GET", "project.view"),
    *_project("/api/platform/projects/{project_id}", "PATCH", "project.manage"),
    *_project("/api/platform/projects/{project_id}/document", "GET", "project.view"),
    *_project("/api/platform/projects/{project_id}/document", "PUT", "dataset.manage"),
    *_workspace("/api/platform/templates", "GET", "workspace membership"),
    *_workspace("/api/platform/templates", "POST", "release.publish"),
    *_workspace("/api/platform/templates/{template_id}", "GET", "workspace membership"),
    *_workspace("/api/platform/templates/{template_id}", "PATCH DELETE", "project.manage or template owner"),
    *_workspace("/api/platform/templates/{template_id}/favorite", "POST DELETE", "workspace membership"),
    *_workspace("/api/platform/templates/{template_id}/re-publish", "POST", "release.publish on source project"),
    *_indirect("/api/platform/templates/{template_id}/apply-candidates", "GET", "flow.edit", "template.workspace + project_id body/query"),
    *_indirect("/api/platform/templates/{template_id}/apply", "POST", "flow.edit", "template.workspace + project_id body"),
    *_project("/api/platform/projects/{project_id}/resources/{resource_type}", "GET", "project.view"),
    *_project("/api/platform/projects/{project_id}/resources/{resource_type}", "POST", "resource-type capability"),
    *_project("/api/platform/projects/{project_id}/resources/{resource_type}/{resource_id}", "GET", "project.view"),
    *_project("/api/platform/projects/{project_id}/resources/{resource_type}/{resource_id}", "PUT PATCH DELETE", "resource-type capability"),
    *_project("/api/platform/projects/{project_id}/settings", "GET", "project.view"),
    *_project("/api/platform/projects/{project_id}/settings", "PUT", "project.manage"),
    *_project("/api/platform/projects/{project_id}/datasets", "GET", "project.view"),
    *_project("/api/platform/projects/{project_id}/datasets", "POST", "dataset.manage"),
    *_project("/api/platform/projects/{project_id}/datasets/{dataset_id}", "DELETE", "dataset.manage"),
    *_project("/api/platform/projects/{project_id}/datasets/{dataset_id}/versions", "GET", "project.view"),
    *_project("/api/platform/projects/{project_id}/datasets/{dataset_id}/versions", "POST", "dataset.manage"),
    *_indirect("/api/platform/projects/{project_id}/dataset-versions/{version_id}", "GET", "project.view", "version -> dataset.project_id -> route project_id"),
    *_project("/api/platform/projects/{project_id}/schedules", "GET", "project.view"),
    *_project("/api/platform/projects/{project_id}/schedules", "POST", "automation.manage"),
    *_project("/api/platform/projects/{project_id}/schedules/{schedule_id}", "PUT DELETE", "automation.manage"),
    *_project("/api/platform/projects/{project_id}/schedules/{schedule_id}/{action}", "POST", "automation.manage"),
    *_project("/api/platform/projects/{project_id}/webhook-triggers", "GET", "project.view"),
    *_project("/api/platform/projects/{project_id}/webhook-triggers", "POST", "automation.manage"),
    *_project("/api/platform/projects/{project_id}/webhook-triggers/{trigger_id}", "PUT DELETE", "automation.manage"),
    *_project("/api/platform/projects/{project_id}/webhook-triggers/{trigger_id}/rotate-secret", "POST", "automation.manage"),
    *_project("/api/platform/projects/{project_id}/webhook-triggers/{trigger_id}/{action}", "POST", "automation.manage"),
    *_project("/api/platform/projects/{project_id}/notification-subscriptions", "GET", "project.view"),
    *_project("/api/platform/projects/{project_id}/notification-subscriptions", "PUT", "automation.manage"),
    *_project("/api/platform/projects/{project_id}/deliveries", "GET", "project.view"),
    *_project("/api/platform/projects/{project_id}/runs", "GET", "project.view"),
    *_project("/api/platform/projects/{project_id}/runs", "POST", "run.execute"),
    *_project("/api/platform/projects/{project_id}/runs/batch-delete", "POST", "run.execute"),
    *_indirect("/api/platform/projects/{project_id}/runs/{run_id}", "GET", "project.view", "run.project_id -> route project_id"),
    *_indirect("/api/platform/projects/{project_id}/runs/{run_id}", "DELETE", "run.execute", "run.project_id -> route project_id"),
    *_indirect("/api/platform/projects/{project_id}/runs/{run_id}/cancel", "POST", "run.execute", "run.project_id -> route project_id"),
    *_indirect("/api/platform/projects/{project_id}/runs/{run_id}/retry", "POST", "run.execute", "run.project_id -> route project_id"),
    *_project("/api/platform/projects/{project_id}/run-batches", "GET", "project.view"),
    *_project("/api/platform/projects/{project_id}/run-batches", "POST", "run.execute"),
    *_indirect("/api/platform/projects/{project_id}/run-batches/{batch_id}", "GET", "project.view", "batch.project_id -> route project_id"),
    *_indirect("/api/platform/projects/{project_id}/run-batches/{batch_id}/cancel", "POST", "run.execute", "batch.project_id -> route project_id"),
    *_indirect("/api/platform/projects/{project_id}/run-batches/{batch_id}/retry-failed", "POST", "run.execute", "batch.project_id -> route project_id"),
    *_project("/api/platform/projects/{project_id}/recording-sessions", "POST", "flow.edit"),
    *_project("/api/platform/projects/{project_id}/recording-sessions/cancel-active", "POST", "flow.edit"),
    *_indirect("/api/platform/projects/{project_id}/recording-sessions/{session_id}", "GET DELETE", "flow.edit", "in-memory session owner + project_id"),
    *_indirect("/api/platform/projects/{project_id}/recording-sessions/{session_id}/events", "GET", "flow.edit", "in-memory session owner + project_id"),
    *_indirect("/api/platform/projects/{project_id}/recording-sessions/{session_id}/pause", "POST", "flow.edit", "in-memory session owner + project_id"),
    *_indirect("/api/platform/projects/{project_id}/recording-sessions/{session_id}/resume", "POST", "flow.edit", "in-memory session owner + project_id"),
    *_indirect("/api/platform/projects/{project_id}/recording-sessions/{session_id}/stop", "POST", "flow.edit", "in-memory session owner + project_id"),
    *_project("/api/platform/projects/{project_id}/element-validations", "POST", "run.execute"),
    *_indirect("/api/platform/projects/{project_id}/element-validations/{validation_id}", "GET", "project.view", "validation.project_id -> route project_id"),
    *_indirect("/api/platform/validation-artifacts/{artifact_id}", "GET", "project.view", "validation artifact.project_id -> project"),
    *_indirect("/api/platform/artifacts/{artifact_id}", "GET", "project.view", "artifact.project_id -> project"),
    *_project("/api/platform/projects/{project_id}/revisions", "GET", "project.view"),
    *_project("/api/platform/projects/{project_id}/revisions", "POST", "flow.edit"),
    *_project("/api/platform/projects/{project_id}/revisions/{revision_id}/{action}", "POST", "release.publish"),
    *_project("/api/platform/projects/{project_id}/secrets", "GET", "project.view"),
    *_project("/api/platform/projects/{project_id}/secrets", "POST", "secret.manage"),
    *_project("/api/platform/projects/{project_id}/audit-events", "GET", "project.view"),
    *_project("/api/platform/projects/{project_id}/analytics", "GET", "project.view"),
]


def _runtime_route_methods(services: PlatformServices) -> set[tuple[str, str]]:
    return {
        (route.path, method)
        for route in create_platform_router(services).routes
        if hasattr(route, "path")
        for method in (getattr(route, "methods", None) or ())
    }


def test_platform_router_has_one_complete_typed_policy_per_method(tmp_path):
    services = PlatformServices(str(tmp_path))
    try:
        policy_keys = [(row.path, row.method) for row in ROUTE_POLICIES]
        assert len(policy_keys) == len(set(policy_keys)), "duplicate matrix row"
        assert all(
            row.auth and row.scope and row.capability and row.parent
            for row in ROUTE_POLICIES
        )
        assert set(policy_keys) == _runtime_route_methods(services)
    finally:
        services.close()

