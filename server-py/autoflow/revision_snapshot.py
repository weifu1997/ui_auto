"""Canonical revision snapshot helpers.

Only execution-relevant fields participate in the checksum so display and
transient fields such as `updatedAt`, `validation`, and step `status` cannot
create meaningless versions.
"""

from __future__ import annotations

import json
from typing import Any

from .core import digest
from .resources import as_record


STEP_KEYS = (
    "id",
    "action",
    "element",
    "value",
    "timeout",
    "failurePolicy",
    "assertMatch",
    "assertVisibility",
    "assertOperator",
    "assertAttribute",
    "trimCompare",
    "output",
    "outputSource",
    "outputAttribute",
    "outputParameter",
    "responseUrl",
    "outputPath",
    "outputPublic",
)
ENVIRONMENT_KEYS = (
    "id",
    "baseUrl",
    "browser",
    "auth",
    "timeout",
    "testIdAttribute",
    "keepBrowserOpenOnFailure",
    "headless",
)
ELEMENT_KEYS = (
    "id",
    "name",
    "path",
    "method",
    "value",
    "environment",
)
DATASET_KEYS = (
    "datasetId",
    "versionId",
    "versionNumber",
    "checksum",
    "columns",
    "rowCount",
)


def _pick(record: dict[str, Any], keys: tuple[str, ...]) -> dict[str, Any]:
    return {key: record[key] for key in keys if key in record}


def canonical_step(step: Any) -> dict[str, Any]:
    return _pick(as_record(step), STEP_KEYS)


def canonical_flow(
    flow: Any,
    secret_names: list[str] | None = None,
) -> dict[str, Any]:
    record = as_record(flow)
    steps = record.get("steps")
    if not isinstance(steps, list):
        steps = []
    variables = record.get("variables")
    if not isinstance(variables, dict):
        variables = {}
    names = sorted({str(name) for name in (secret_names or [])})
    return {
        "id": record.get("id"),
        "steps": [canonical_step(step) for step in steps],
        "variables": {
            str(key): variables[key] for key in sorted(variables, key=str)
        },
        "secretNames": names,
    }


def canonical_environment(environment: Any) -> dict[str, Any]:
    return _pick(as_record(environment), ENVIRONMENT_KEYS)


def canonical_elements(elements: Any) -> list[dict[str, Any]]:
    if not isinstance(elements, list):
        return []
    normalized = [as_record(element) for element in elements]
    normalized.sort(
        key=lambda element: (
            str(element.get("id", "")),
            str(element.get("name", "")),
            str(element.get("value", "")),
        )
    )
    return [_pick(element, ELEMENT_KEYS) for element in normalized]


def canonical_dataset(dataset: Any) -> dict[str, Any] | None:
    if not dataset:
        return None
    record = as_record(dataset)
    result = _pick(record, DATASET_KEYS)
    columns = result.get("columns")
    if isinstance(columns, list):
        result["columns"] = sorted(str(column) for column in columns)
    return result


def canonical_snapshot(
    flow: Any,
    environment: Any,
    elements: Any,
    dataset: Any = None,
    secret_names: list[str] | None = None,
) -> dict[str, Any]:
    names = sorted({str(name) for name in (secret_names or [])})
    return {
        "flow": canonical_flow(flow, names),
        "environment": canonical_environment(environment),
        "elements": canonical_elements(elements),
        "dataset": canonical_dataset(dataset),
        "secretNames": names,
    }


def canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def canonical_checksum(
    flow: Any,
    environment: Any,
    elements: Any,
    dataset: Any = None,
    secret_names: list[str] | None = None,
) -> str:
    return digest(
        canonical_json(
            canonical_snapshot(
                flow,
                environment,
                elements,
                dataset,
                secret_names,
            )
        )
    )
