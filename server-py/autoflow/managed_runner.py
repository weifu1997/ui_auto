"""Single-concurrency ManagedRunner matching server/managed-runner.ts."""

from __future__ import annotations

import threading
import uuid
from pathlib import Path
from typing import Any

from .runner import execute_browser_run, execute_element_validation


class ManagedRunner:
    def __init__(self, artifact_directory: str | Path):
        self.artifact_directory = Path(artifact_directory)
        self._condition = threading.Condition()
        self._items: list[dict[str, Any]] = []
        self._active: dict[str, Any] | None = None
        self._stopped = False
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def enqueue(
        self,
        item_id: str,
        input: dict[str, Any],
        callbacks: dict[str, Any],
        kind: str = "run",
    ) -> None:
        with self._condition:
            if self._active and self._active["id"] == item_id:
                return
            if any(item["id"] == item_id for item in self._items):
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
                callbacks = queued["callbacks"]
                if queued["kind"] == "run":
                    callbacks["completed"](
                        {
                            "status": "canceled",
                            "completedSteps": 0,
                            "totalSteps": len(queued["input"].get("flow", {}).get("steps", [])),
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
                return True
            if self._active and self._active["id"] == item_id:
                self._active["signal"].set()
                browser = self._active.get("browser")
                context = self._active.get("context")
                if context is not None:
                    try:
                        context.close()
                    except Exception:
                        pass
                if browser is not None:
                    try:
                        browser.close()
                    except Exception:
                        pass
                return True
        return False

    def stop(self) -> None:
        with self._condition:
            self._stopped = True
            self._condition.notify_all()
        self._thread.join(timeout=5)

    def _run(self) -> None:
        while True:
            with self._condition:
                while not self._items and not self._stopped:
                    self._condition.wait()
                if not self._items and self._stopped:
                    return
                item = self._items.pop(0)
                self._active = item
            callbacks = item["callbacks"]
            callbacks["started"]()
            self.artifact_directory.mkdir(parents=True, exist_ok=True)
            hooks = {
                "signal": item["signal"],
                "artifact_path": lambda _name, extension: str(
                    self.artifact_directory / f"artifact_{uuid.uuid4()}.{extension}"
                ),
                "artifact": callbacks["artifact"],
                "event": callbacks["event"] if item["kind"] == "run" else (lambda *_args: None),
                "browser": lambda browser, context: self._set_active_browser(
                    item["id"], browser, context
                ),
            }
            try:
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
                    self._active = None
                    self._condition.notify_all()

    def _set_active_browser(
        self,
        item_id: str,
        browser: Any,
        context: Any,
    ) -> None:
        with self._condition:
            if self._active and self._active["id"] == item_id:
                self._active["browser"] = browser
                self._active["context"] = context
