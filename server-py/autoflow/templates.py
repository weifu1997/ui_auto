"""Template reference rewriting and dependency closure helpers."""

from __future__ import annotations

import re
from typing import Any


def rewrite_template_references(
    value: Any, ids: dict[str, str], depth: int = 0
) -> Any:
    """Recursively rewrite IDs according to the provided mapping dictionary."""
    if depth > 100:
        raise ValueError("TEMPLATE_SNAPSHOT_TOO_DEEP")
    if isinstance(value, str):
        return ids.get(value, value)
    if isinstance(value, list):
        return [
            rewrite_template_references(item, ids, depth + 1) for item in value
        ]
    if isinstance(value, dict):
        return {
            key: rewrite_template_references(item, ids, depth + 1)
            for key, item in value.items()
        }
    return value


def extract_flow_element_references(flow: dict[str, Any]) -> set[str]:
    """Extract element ID or name references from flow steps."""
    refs: set[str] = set()
    steps = flow.get("steps") if isinstance(flow, dict) else []
    if not isinstance(steps, list):
        return refs
    for step in steps:
        if not isinstance(step, dict):
            continue
        elem_id = step.get("elementId")
        if isinstance(elem_id, str) and elem_id.strip():
            refs.add(elem_id.strip())
        elem_ref = step.get("element")
        if isinstance(elem_ref, str) and elem_ref.strip():
            refs.add(elem_ref.strip())
    return refs


def extract_flow_variable_references(flow: dict[str, Any]) -> set[str]:
    """Extract variable references from flow steps and secretNames, excluding system runtime namespaces."""
    refs: set[str] = set()
    if not isinstance(flow, dict):
        return refs

    # Extract from secretNames
    secret_names = flow.get("secretNames")
    if isinstance(secret_names, list):
        for name in secret_names:
            if isinstance(name, str) and name.strip():
                refs.add(name.strip())

    # Extract from step values/text/urls/etc
    steps = flow.get("steps")
    if isinstance(steps, list):
        for step in steps:
            if not isinstance(step, dict):
                continue
            for val in step.values():
                if isinstance(val, str):
                    for match in re.finditer(r"{{\s*([^}]+)\s*}}", val):
                        expr = match.group(1).strip()
                        if not expr:
                            continue
                        # Exclude built-in runtime namespaces
                        if (
                            expr.startswith("data.")
                            or expr.startswith("flow.")
                            or expr.startswith("run.")
                            or expr == "env.baseUrl"
                        ):
                            continue
                        refs.add(expr)
    return refs


def rewrite_flow_placeholders_and_elements(
    flow: dict[str, Any],
    ref_renames: dict[str, str],
    element_name_renames: dict[str, str],
) -> dict[str, Any]:
    """Rewrite {{...}} placeholders, secretNames, and step.element names in a flow snapshot."""
    if not isinstance(flow, dict):
        return flow
    flow_copy = dict(flow)

    # Rewrite secretNames
    if isinstance(flow_copy.get("secretNames"), list):
        flow_copy["secretNames"] = [
            ref_renames.get(name, name) if isinstance(name, str) else name
            for name in flow_copy["secretNames"]
        ]

    # Rewrite steps
    steps = flow_copy.get("steps")
    if isinstance(steps, list):
        new_steps = []
        for step in steps:
            if not isinstance(step, dict):
                new_steps.append(step)
                continue
            step_copy = dict(step)
            # Element name rewriting
            elem = step_copy.get("element")
            if isinstance(elem, str) and elem in element_name_renames:
                step_copy["element"] = element_name_renames[elem]

            # Placeholder rewriting in all string fields
            for key, val in list(step_copy.items()):
                if isinstance(val, str):
                    new_val = val
                    for old_ref, new_ref in ref_renames.items():
                        pattern = re.compile(r"{{\s*" + re.escape(old_ref) + r"\s*}}")
                        new_val = pattern.sub("{{" + new_ref + "}}", new_val)
                    step_copy[key] = new_val
            new_steps.append(step_copy)
        flow_copy["steps"] = new_steps

    return flow_copy
