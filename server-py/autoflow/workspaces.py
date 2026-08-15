"""Workspace capability helpers matching server/platform-workspaces.ts."""

from __future__ import annotations


ALL_CAPABILITIES = [
    "project.view",
    "project.edit",
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
]

ROLE_CAPABILITIES = {
    "owner": ALL_CAPABILITIES,
    "admin": ALL_CAPABILITIES,
    "publisher": [
        "project.view",
        "project.edit",
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
    ],
    "product": ["project.view", "project.edit", "flow.edit", "variable.manage", "release.submit"],
    "tester": [
        "project.view",
        "flow.edit",
        "element.manage",
        "variable.manage",
        "environment.manage",
        "secret.manage",
        "release.submit",
        "run.execute",
        "dataset.manage",
    ],
    "operations": ["project.view", "run.execute", "dataset.manage", "automation.manage"],
    "editor": [
        "project.view",
        "project.edit",
        "flow.edit",
        "element.manage",
        "variable.manage",
        "environment.manage",
        "release.submit",
        "run.execute",
        "dataset.manage",
    ],
    "viewer": ["project.view"],
}


def role_has_capability(role: str, capability: str) -> bool:
    return capability in ROLE_CAPABILITIES.get(role, [])
