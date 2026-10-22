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


def test_started_false_skips_browser_execution(tmp_path, monkeypatch):
    executed: list[str] = []
    completed: list[str] = []

    def fake_execute(input, _hooks):
        executed.append(input.get("name") or "run")
        return {
            "status": "success",
            "completedSteps": 0,
            "totalSteps": 0,
            "elapsedMs": 0,
            "flowOutputs": {},
        }

    monkeypatch.setattr(module, "execute_browser_run", fake_execute)
    runner = ManagedRunner(str(tmp_path), global_concurrency=1, workspace_concurrency=1)
    try:
        runner.enqueue(
            "skip",
            {"name": "skip"},
            {
                "started": lambda: False,
                "event": lambda *_args: None,
                "artifact": lambda *_args: None,
                "completed": lambda _result: completed.append("skip"),
            },
            "run",
            workspace_id="w1",
        )
        assert _wait_until(lambda: not runner.is_busy)
        assert executed == []
        assert completed == []

        # The skipped item must release the global slot so a later run can start.
        runner.enqueue(
            "next",
            {"name": "next"},
            {
                "started": lambda: True,
                "event": lambda *_args: None,
                "artifact": lambda *_args: None,
                "completed": lambda _result: completed.append("next"),
            },
            "run",
            workspace_id="w1",
        )
        assert _wait_until(lambda: completed == ["next"])
        assert executed == ["next"]
    finally:
        runner.stop()


def test_started_exception_fails_and_releases_slot(tmp_path, monkeypatch):
    executed: list[str] = []
    completed: list[dict] = []

    def fake_execute(input, _hooks):
        executed.append(input.get("name") or "run")
        return {
            "status": "success",
            "completedSteps": 0,
            "totalSteps": 0,
            "elapsedMs": 0,
            "flowOutputs": {},
        }

    monkeypatch.setattr(module, "execute_browser_run", fake_execute)
    runner = ManagedRunner(str(tmp_path), global_concurrency=1, workspace_concurrency=1)
    try:
        def boom():
            raise RuntimeError("mark_run_started boom")

        runner.enqueue(
            "boom",
            {"name": "boom"},
            {
                "started": boom,
                "event": lambda *_args: None,
                "artifact": lambda *_args: None,
                "completed": completed.append,
            },
            "run",
            workspace_id="w1",
        )
        assert _wait_until(lambda: completed and completed[0].get("status") == "failed")
        assert executed == []
        assert "mark_run_started boom" in str(completed[0].get("error"))

        runner.enqueue(
            "next",
            {"name": "next"},
            {
                "started": lambda: True,
                "event": lambda *_args: None,
                "artifact": lambda *_args: None,
                "completed": lambda _result: completed.append({"id": "next"}),
            },
            "run",
            workspace_id="w1",
        )
        assert _wait_until(lambda: any(item.get("id") == "next" for item in completed))
        assert executed == ["next"]
    finally:
        runner.stop()


def test_cancel_reclaims_slot_when_worker_wedged(tmp_path, monkeypatch):
    """P2-6: watchdog 判死一个卡死 worker 后，cancel 必须立刻释放并发槽。

    旧实现只置 signal；卡在 Playwright 调用里、永远到不了步骤边界的 worker
    看不到它 → ``_execute`` 的 finally 不跑 → ``_active`` 槽被永久占死，
    后续 run 无限排队（哪怕 DB 行已被 watchdog 置 failed）。
    """
    entered = threading.Event()
    release = threading.Event()
    started: list[str] = []

    def fake_execute(_input, _hooks):
        entered.set()
        release.wait(timeout=30)  # wedged：模拟卡在 CDP 传输层，从不返回
        return {
            "status": "success",
            "completedSteps": 0,
            "totalSteps": 0,
            "elapsedMs": 0,
            "flowOutputs": {},
        }

    monkeypatch.setattr(module, "execute_browser_run", fake_execute)
    runner = ManagedRunner(str(tmp_path), global_concurrency=1, workspace_concurrency=1)
    try:
        runner.enqueue("A", {}, _callbacks("A", started), "run", workspace_id="w1")
        assert _wait_until(lambda: entered.is_set())
        runner.enqueue("B", {}, _callbacks("B", started), "run", workspace_id="w1")

        # watchdog 视角：对判死（failed）的 A 调 reap_lost —— 摘槽并补员，
        # B 应立即开始执行（即使 A 的 worker 永不返回）。
        assert runner.reclaim_lost("A") is True
        assert _wait_until(lambda: "B" in started, timeout=3), (
            "reap_lost 判死卡死 run 后必须释放并发槽并补员，否则后续 run 无限排队"
        )
    finally:
        release.set()
        runner.stop()
