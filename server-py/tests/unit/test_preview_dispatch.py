"""Stage W0-1: preview 派发不阻塞事件循环 + 并发闸单测。

契约（.trellis/tasks/08-27-reliability-repair-waves/design.md）：
- `dispatch_preview` 必须把同步 Playwright 执行放到 worker 线程，
  事件循环在其执行期间保持可调度（修好前会整体挂起）；
- 全进程同时只允许一个 preview 占位，第二个并发请求得到
  409 / PREVIEW_BUSY；
- 占位在 preview 抛错后必须释放，下一个请求可正常进入。
"""

from __future__ import annotations

import asyncio
import threading
import time
from types import SimpleNamespace

import pytest

from autoflow.handler import runs as runs_handler
from autoflow.http import PlatformError


@pytest.fixture(autouse=True)
def fresh_preview_slots(monkeypatch):
    monkeypatch.setattr(runs_handler, "_PREVIEW_SLOTS", threading.BoundedSemaphore(1))


def _fake_services(delay: float, *, error: Exception | None = None):
    def preview_run(project_id, body):
        time.sleep(delay)
        if error is not None:
            raise error
        return {"ok": True}

    return SimpleNamespace(preview_run=preview_run)


@pytest.mark.asyncio
async def test_preview_offloads_to_worker_thread_keeps_loop_responsive():
    """preview 运行期间事件循环必须持续可调度；阻塞实现会让 tick 出现长空窗。"""
    services = _fake_services(delay=0.6)
    ticks: list[float] = []

    async def ticker():
        while True:
            ticks.append(time.monotonic())
            await asyncio.sleep(0.005)

    tick_task = asyncio.create_task(ticker())
    try:
        result = await asyncio.wait_for(
            runs_handler.dispatch_preview(services, "p1", {}), timeout=10
        )
    finally:
        tick_task.cancel()

    assert result == {"ok": True}
    # 若派发仍在事件循环内同步执行，await 全程不会发生调度切换，
    # ticks 只会有取消前的零星样本且出现 >= 0.6s 的空窗。
    assert len(ticks) >= 50, f"event loop barely scheduled ({len(ticks)} ticks)"
    gaps = [b - a for a, b in zip(ticks, ticks[1:])]
    assert not gaps or max(gaps) < 0.3, (
        f"event loop stalled for {max(gaps):.3f}s during preview"
    )


@pytest.mark.asyncio
async def test_second_concurrent_preview_gets_preview_busy_409():
    """占位被首个 preview 持有时，第二个请求立即 409/PREVIEW_BUSY。"""
    release = threading.Event()
    started_box: list[bool] = []

    def slow_preview(project_id, body):
        started_box.append(True)
        release.wait(timeout=5)
        return {"ok": True}

    services = SimpleNamespace(preview_run=slow_preview)

    first = asyncio.create_task(
        runs_handler.dispatch_preview(services, "p1", {})
    )
    for _ in range(200):
        if started_box:
            break
        await asyncio.sleep(0.01)
    assert started_box, "first preview never entered the worker"

    with pytest.raises(PlatformError) as error:
        await runs_handler.dispatch_preview(services, "p1", {})
    assert error.value.status == 409
    assert error.value.code == "PREVIEW_BUSY"

    release.set()
    assert (await asyncio.wait_for(first, timeout=5)) == {"ok": True}


@pytest.mark.asyncio
async def test_slot_released_after_preview_error():
    """preview 抛错时占位必须在 finally 中释放，后续请求可正常进入。"""
    services = _fake_services(delay=0.01, error=RuntimeError("boom"))

    with pytest.raises(RuntimeError, match="boom"):
        await runs_handler.dispatch_preview(services, "p1", {})

    healthy = _fake_services(delay=0.01)
    result = await runs_handler.dispatch_preview(healthy, "p1", {})
    assert result == {"ok": True}
