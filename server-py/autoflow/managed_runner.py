"""Multi-concurrency ManagedRunner matching server/managed-runner.ts.

RUN-01: the runner honors a global concurrency limit and a per-workspace
concurrency limit while preserving eligible FIFO scheduling and isolated
cancellation of queued or active items.
"""

from __future__ import annotations

import threading
import uuid
from pathlib import Path
from typing import Any

from .runner import execute_browser_run, execute_element_validation


class ManagedRunner:
    def __init__(
        self,
        artifact_directory: str | Path,
        global_concurrency: int = 2,
        workspace_concurrency: int = 1,
    ):
        self.artifact_directory = Path(artifact_directory)
        self.global_concurrency = max(1, int(global_concurrency))
        self.workspace_concurrency = max(1, int(workspace_concurrency))
        self._condition = threading.Condition()
        self._items: list[dict[str, Any]] = []
        self._active: dict[str, dict[str, Any]] = {}
        self._stopped = False
        self._threads = [
            threading.Thread(target=self._run, daemon=True)
            for _ in range(self.global_concurrency)
        ]
        for thread in self._threads:
            thread.start()

    def enqueue(
        self,
        item_id: str,
        input: dict[str, Any],
        callbacks: dict[str, Any],
        kind: str = "run",
        workspace_id: str | None = None,
    ) -> None:
        with self._condition:
            if item_id in self._active or any(
                item["id"] == item_id for item in self._items
            ):
                return
            self._items.append(
                {
                    "id": item_id,
                    "kind": kind,
                    "input": input,
                    "callbacks": callbacks,
                    "signal": threading.Event(),
                    "browser": None,
                    "context": None,
                    "workspace_id": workspace_id,
                }
            )
            self._condition.notify_all()

    def cancel(self, item_id: str) -> bool:
        with self._condition:
            queued = next(
                (item for item in self._items if item["id"] == item_id),
                None,
            )
            if queued:
                self._items.remove(queued)
                self._complete_canceled(queued)
                return True
            active = self._active.get(item_id)
            if active is not None:
                # Signal only. Closing Playwright from this thread (and while
                # holding the condition) is unsafe; the worker checks the
                # signal at step boundaries and closes its own browser.
                active["signal"].set()
                return True
        return False

    def position(self, item_id: str) -> int | None:
        with self._condition:
            for index, item in enumerate(self._items):
                if item["id"] == item_id:
                    return index + 1
        return None

    @property
    def is_busy(self) -> bool:
        with self._condition:
            return bool(self._active)

    def stop(self) -> None:
        with self._condition:
            self._stopped = True
            for item in self._active.values():
                item["signal"].set()
            self._condition.notify_all()
        for thread in self._threads:
            thread.join(timeout=5)

    def _active_workspace_count(self, workspace_id: str | None) -> int:
        if workspace_id is None:
            return 0
        return sum(
            1 for item in self._active.values() if item.get("workspace_id") == workspace_id
        )

    def _next_eligible(self) -> dict[str, Any] | None:
        if len(self._active) >= self.global_concurrency:
            return None
        for index, item in enumerate(self._items):
            if (
                self._active_workspace_count(item.get("workspace_id"))
                >= self.workspace_concurrency
            ):
                continue
            return self._items.pop(index)
        return None

    def _complete_canceled(self, item: dict[str, Any]) -> None:
        callbacks = item["callbacks"]
        if item["kind"] == "run":
            callbacks["completed"](
                {
                    "status": "canceled",
                    "completedSteps": 0,
                    "totalSteps": len(item["input"].get("flow", {}).get("steps", [])),
                    "elapsedMs": 0,
                    "error": "RUN_CANCELED",
                    "flowOutputs": {},
                }
            )
        else:
            callbacks["completed"](
                {
                    "status": "canceled",
                    "count": 0,
                    "elapsedMs": 0,
                    "error": "VALIDATION_CANCELED",
                }
            )

    def _run(self) -> None:
        while True:
            with self._condition:
                while True:
                    if self._stopped:
                        return
                    item = self._next_eligible()
                    if item is not None:
                        self._active[item["id"]] = item
                        break
                    self._condition.wait()
            self._execute(item)

    def _execute(self, item: dict[str, Any]) -> None:
        callbacks = item["callbacks"]
        try:
            started = callbacks.get("started")
            if callable(started):
                try:
                    accepted = started()
                except Exception:
                    accepted = False
                if accepted is False:
                    # Cancel/watchdog already finalized the row. Do not execute
                    # and do not call completed(); still drop the active slot.
                    return
            self.artifact_directory.mkdir(parents=True, exist_ok=True)
            hooks = {
                "signal": item["signal"],
                "artifact_path": lambda _name, extension: str(
                    self.artifact_directory / f"artifact_{uuid.uuid4()}.{extension}"
                ),
                "artifact": callbacks["artifact"],
                "event": callbacks["event"] if item["kind"] == "run" else (lambda *_args: None),
                # W0-4：步骤级心跳回调；未提供 progress 的入队方（如元素校验）安全降级。
                "progress": callbacks.get("progress") or (lambda *_args: None),
                "browser": lambda browser, context: self._set_active_browser(
                    item["id"], browser, context
                ),
            }
            if item["kind"] == "run":
                result = execute_browser_run(item["input"], hooks)
            else:
                result = execute_element_validation(item["input"], hooks)
            callbacks["completed"](result)
        except Exception as error:
            message = str(error) or "MANAGED_RUNNER_FAILED"
            if item["kind"] == "run":
                callbacks["completed"](
                    {
                        "status": "failed",
                        "completedSteps": 0,
                        "totalSteps": len(item["input"].get("flow", {}).get("steps", [])),
                        "elapsedMs": 0,
                        "error": message,
                        "flowOutputs": {},
                    }
                )
            else:
                callbacks["completed"](
                    {
                        "status": "failed",
                        "count": 0,
                        "elapsedMs": 0,
                        "error": message,
                    }
                )
        finally:
            with self._condition:
                self._active.pop(item["id"], None)
                self._condition.notify_all()

    def _set_active_browser(
        self,
        item_id: str,
        browser: Any,
        context: Any,
    ) -> None:
        with self._condition:
            active = self._active.get(item_id)
            if active is not None:
                active["browser"] = browser
                active["context"] = context
