"""Run spec resolution, enqueue/execute lifecycle, deletion, and metrics.

`RunServices` 拆为 `RunServicesBase` + 领域 mixin（阶段1-C，行为保持拆分）：
- `RunServicesBase`：跨 mixin 共享的辅助（`redact_run_value` 脱敏）。
- `_RunsLifecycleMixin`：run 创建/取消/重试/终态（spec 解析、入队、删除、终态落库）。
- `_RunEventsMixin`：事件写入与 run 详情的事件序列化。
- `_BatchMixin`：batch 执行（单 spec 按 dataset rows 批量入队）。
- `_ReportMixin`：断言报告导出（JSON/XLSX）。
- `_AggregationMixin`：服务级 + 断言统计聚合。
"""
from __future__ import annotations

from ._base import RunServicesBase
from ._lifecycle import _RunsLifecycleMixin
from ._events import _RunEventsMixin
from ._batch import _BatchMixin
from ._report import _ReportMixin
from ._aggregation import _AggregationMixin


class RunServices(
    RunServicesBase,
    _RunsLifecycleMixin,
    _RunEventsMixin,
    _BatchMixin,
    _ReportMixin,
    _AggregationMixin,
):
    """Run spec resolution, enqueue/execute lifecycle, deletion, and metrics."""
