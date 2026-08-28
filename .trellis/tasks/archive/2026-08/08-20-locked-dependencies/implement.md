# REL-01 实施清单

- [x] `server-py/requirements.lock`：`pip freeze` 生成的全量锁定（36 项）。
- [x] `scripts/setup-py.mjs`：优先使用 `requirements.lock`，回退 `requirements.txt`。
- [x] `scripts/verify-lock.py`：校验已安装版本与锁文件一致（PEP 503 归一化比较）。

## 验证

- `verify-lock.py` 对当前 venv 返回 `ok (36 pinned packages)`。

## 未完成（需发布流水线）

- 不可变版本包、校验和/SBOM、staging 迁移检查与回滚证据需真实发布流水线，未伪造。
