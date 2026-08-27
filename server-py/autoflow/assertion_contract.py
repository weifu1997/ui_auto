"""断言字段契约（Python 侧单一模块）。

权威来源: ``.trellis/spec/backend/assertion-field-contract.md``。
前端对应: ``src/domain/assertions.ts``。跨层 parity 校验:
- ``server-py/tests/unit/test_assertion_contract.py``（本模块常量与契约文档一致）
- ``src/lib/assertions-contract.test.ts``（前端常量与契约文档一致）
- e2e ``assertion-contract.spec.ts``（两端动作映射一致）

两端枚举漂移时对应 parity 测试即红；新增断言字段必须先更新契约文档，
再同步本模块与前端 ``assertions.ts``、``revision_snapshot.STEP_KEYS``。
"""

from __future__ import annotations

# 匹配方式（文本/属性断言），缺省 contains。
ASSERT_MATCHES = ("exact", "contains")
# 可见性（可见性断言），缺省 visible。
ASSERT_VISIBILITIES = ("visible", "hidden")
# 计数比较符（数量断言），缺省 =。
ASSERT_OPERATORS = ("=", ">", "<", ">=", "<=")
# 属性名缺省（属性断言）。
ASSERT_ATTRIBUTE_DEFAULT = "value"

# 动作 -> 判定 type（``step.asserted`` 事件与 ``result.assertions`` 载荷的统一标识）。
ASSERTION_TYPES = {
    "可见性断言": "visibility",
    "文本断言": "text",
    "数量断言": "count",
    "属性断言": "attribute",
}

# 进 revision checksum 的规范断言字段（``revision_snapshot.STEP_KEYS`` 的断言部分；
# 漏加会被剔出快照——硬约束）。元组顺序即 canonical_step 键序，改动需保持快照一致。
ASSERTION_KEYS = (
    "assertMatch",
    "assertVisibility",
    "assertOperator",
    "assertAttribute",
    "trimCompare",
)
