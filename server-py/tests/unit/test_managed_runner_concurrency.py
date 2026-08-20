import threading
import time

import autoflow.managed_runner as module
from autoflow.managed_runner import ManagedRunner


def _callbacks(name: str, started: list[str]):
    return {
        "started": lambda: started.append(name),
        "event": lambda *_args: None,
        "artifact": lambda *_args: None,
        "completed": lambda _result: None,
    }


def _wait_until(predicate, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return predicate()


def test_global_and_workspace_concurrency(tmp_path, monkeypatch):
    release = threading.Event()
    started: list[str] = []

    def fake_execute(_input, _hooks):
        release.wait(timeout=10)
        return {
            "status": "success",
            "completedSteps": 0,
            "totalSteps": 0,
            "elapsedMs": 0,
            "flowOutputs": {},
        }

    monkeypatch.setattr(module, "execute_browser_run", fake_execute)
    monkeypatch.setattr(module, "execute_element_validation", fake_execute)

    runner = ManagedRunner(
        str(tmp_path), global_concurrency=2, workspace_concurrency=1
    )
    try:
        runner.enqueue("A", {}, _callbacks("A", started), "run", workspace_id="w1")
        runner.enqueue("B", {}, _callbacks("B", started), "run", workspace_id="w2")
        runner.enqueue("C", {}, _callbacks("C", started), "run", workspace_id="w1")

        # Global limit 2 allows A and B; per-workspace limit 1 keeps C queued.
        assert _wait_until(lambda: sorted(started) == ["A", "B"])
        time.sleep(0.05)
        assert "C" not in started

        # Release A/B; C (workspace w1) becomes eligible and starts.
        release.set()
        assert _wait_until(lambda: "C" in started)
    finally:
        release.set()
        runner.stop()


def test_global_concurrency_caps_cross_workspace_runs(tmp_path, monkeypatch):
    release = threading.Event()
    started: list[str] = []

    def fake_execute(_input, _hooks):
        release.wait(timeout=10)
        return {
            "status": "success",
            "completedSteps": 0,
            "totalSteps": 0,
            "elapsedMs": 0,
            "flowOutputs": {},
        }

    monkeypatch.setattr(module, "execute_browser_run", fake_execute)
    monkeypatch.setattr(module, "execute_element_validation", fake_execute)

    runner = ManagedRunner(
        str(tmp_path), global_concurrency=1, workspace_concurrency=2
    )
    try:
        runner.enqueue("A", {}, _callbacks("A", started), "run", workspace_id="w1")
        runner.enqueue("B", {}, _callbacks("B", started), "run", workspace_id="w2")

        assert _wait_until(lambda: started == ["A"])
        time.sleep(0.05)
        assert started == ["A"]

        release.set()
        assert _wait_until(lambda: started == ["A", "B"])
    finally:
        release.set()
        runner.stop()
