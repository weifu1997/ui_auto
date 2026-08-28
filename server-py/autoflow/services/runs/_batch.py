"""Batch execution from a published run spec.

`_BatchMixin`（batch 执行）。适配注：真正的 batch 生命周期/聚合在 `batches.py`（`BatchServices`），runs.py 内的 batch 语义只有 `queue_published_runs`（单 spec 按 dataset rows 批量入队）。
"""
from __future__ import annotations

from typing import Any

class _BatchMixin:
    """Batch execution from a published run spec."""

    def queue_published_runs(self, input: dict[str, Any]) -> dict[str, Any]:
        spec = self.resolve_run_spec(input)
        run_ids: list[str] = []
        self.database.execute("BEGIN IMMEDIATE")
        try:
            for row in spec["rows"]:
                dispatch_key = (
                    f"{input['dispatchKey']}:{row['rowNumber'] or 0}"
                    if input.get("dispatchKey")
                    else None
                )
                run_ids.append(
                    self.insert_run_from_spec(
                        spec,
                        row=row,
                        created_by=input["createdBy"],
                        source=input["source"],
                        dispatch_key=dispatch_key,
                    )
                )
            self.database.execute("COMMIT")
        except Exception:
            self.database.execute("ROLLBACK")
            raise
        for run_id in run_ids:
            self.enqueue_managed_run(run_id)
        return {
            "runIds": run_ids,
            "revision": spec["revision"],
            "environmentId": spec["environmentId"],
            "datasetVersionId": spec["datasetVersionId"],
        }
