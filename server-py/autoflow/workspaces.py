"""Workspace role normalization and named capability policy."""

from __future__ import annotations


GLOBAL_ROLE_SUPER_ADMIN = "super_admin"
WORKSPACE_ROLE_ADMIN = "admin"
WORKSPACE_ROLE_MEMBER = "member"
WORKSPACE_ROLES = (WORKSPACE_ROLE_ADMIN, WORKSPACE_ROLE_MEMBER)

# Existing rows are migrated once. Keep the mapping explicit so upgrades do not
# retain a hidden compatibility role policy.
LEGACY_ROLE_MAP = {
    "owner": WORKSPACE_ROLE_ADMIN,
    "admin": WORKSPACE_ROLE_ADMIN,
    "publisher": WORKSPACE_ROLE_MEMBER,
    "product": WORKSPACE_ROLE_MEMBER,
    "tester": WORKSPACE_ROLE_MEMBER,
    "operations": WORKSPACE_ROLE_MEMBER,
    "editor": WORKSPACE_ROLE_MEMBER,
    "viewer": WORKSPACE_ROLE_MEMBER,
}

ALL_CAPABILITIES = (
    "project.view",
    "project.edit",
    "project.manage",
    "flow.edit",
    "element.manage",
    "variable.manage",
    "environment.manage",
    "secret.manage",
    "release.submit",
    "release.publish",
    "run.execute",
    "dataset.manage",
    "automation.manage",
    "member.manage",
    "invite.manage",
    "workspace.manage",
    "account.manage",
)

# Deployment account administration is deliberately not a workspace-admin
# capability.  It is listed with the other names so the frontend can validate
# the server-issued session projection, but only a deployment super-admin can
# receive it.
ADMIN_CAPABILITIES = tuple(
    capability for capability in ALL_CAPABILITIES if capability != "account.manage"
)

MEMBER_CAPABILITIES = (
    "project.view",
    "flow.edit",
    "element.manage",
    "variable.manage",
    "environment.manage",
    "release.submit",
    "run.execute",
    "dataset.manage",
)

ROLE_CAPABILITIES = {
    GLOBAL_ROLE_SUPER_ADMIN: ALL_CAPABILITIES,
    WORKSPACE_ROLE_ADMIN: ADMIN_CAPABILITIES,
    WORKSPACE_ROLE_MEMBER: MEMBER_CAPABILITIES,
}


def normalize_workspace_role(role: str | None) -> str:
    """Map legacy stored roles while denying malformed values by default."""
    candidate = (role or "").strip().lower()
    if candidate in WORKSPACE_ROLES:
        return candidate
    return LEGACY_ROLE_MAP.get(candidate, "")


def is_workspace_role(role: str | None) -> bool:
    return role in WORKSPACE_ROLES


def is_super_admin(global_role: str | None) -> bool:
    return global_role == GLOBAL_ROLE_SUPER_ADMIN


def capabilities_for_role(role: str, global_role: str | None = None) -> list[str]:
    if is_super_admin(global_role) or role == GLOBAL_ROLE_SUPER_ADMIN:
        return list(ALL_CAPABILITIES)
    return list(ROLE_CAPABILITIES.get(normalize_workspace_role(role), ()))


def role_has_capability(
    role: str,
    capability: str,
    global_role: str | None = None,
) -> bool:
    return capability in capabilities_for_role(role, global_role)
