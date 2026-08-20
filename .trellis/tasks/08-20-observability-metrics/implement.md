# OBS-02 实施清单

- [x] `services.py`：新增 `metrics()`（按状态的 run/delivery 计数、磁盘用量、
      产物字节数）与 `_artifact_bytes()`。
- [x] `main.py`：新增 `GET /metrics`，合并 ready 状态与 maintenance 错误状态。
- [x] 新增 `test_metrics.py`。

## 验证

- `test_metrics.py` 1 项通过。
- 端点注册核实 `/metrics` 存在。

## 未完成（需真实环境）

- 仪表盘与告警阈值（如 Grafana/Prometheus alert）属运维基础设施，未伪造。
