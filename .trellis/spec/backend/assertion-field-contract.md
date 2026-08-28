# 断言字段契约（Assertion Field Contract）

> **Purpose**: 断言 schema 的**权威来源**。前端 `src/domain/assertions.ts` 与后端 `server-py/autoflow/assertion_contract.py` 是本契约的两端单一模块；跨层 parity 测试（`src/lib/assertions-contract.test.ts`、`server-py/tests/unit/test_assertion_contract.py`）与 e2e 保证两端与此文档不漂移。
> **来源**: 阶段0（`08-27-phase-0-contracts-baseline`）固化；落地执行见阶段1（`08-27-phase-1-architecture`）。本文档本身不是代码——两端模块与 parity 测试才是代码实现。

---

## 1. 字段定义

每个字段只属于一种断言类型，**枚举互斥，不得跨类型取值**；跨类型误值回落缺省、不报错。

| 字段 | 归属断言类型 | 允许值 | 缺省 | 语义 |
|---|---|---|---|---|
| `assertMatch` | 文本 / 属性 / URL | `exact` \| `contains` | `contains` | 匹配方式（URL：对 `page.url` 命中期望值） |
| `assertVisibility` | 可见性 | `visible` \| `hidden` | `visible` | 元素可见/不可见；`hidden` 区分「不存在」(not-found) 与「存在但隐藏」 |
| `assertOperator` | 数量 | `=` `>` `<` `>=` `<=` | `=` | 匹配元素个数与期望数的关系；期望数对 `value` 做 `int()` 强转，转换失败即断言失败，禁止字符串/数字直接比较 |
| `assertAttribute` | 属性 | 非空字符串 | `value` | 属性名（如 value / disabled / href / checked / text） |
| `trimCompare` | 文本 | boolean | `true`（显式 `false` 关闭） | 比较前对实际/期望文本做空白归一化（首尾 + 连续空白折叠）；期望值保留原样参与报告展示 |

## 2. 动作 → 判定 type 映射

统一标识用于 `step.asserted` 事件与 `platform_runs.result.assertions` 载荷。

| 动作（`action`） | 判定 type | 求值函数 |
|---|---|---|
| `可见性断言` | `visibility` | `_assert_visibility` |
| `文本断言` | `text` | `_assert_text` |
| `数量断言` | `count` | `_assert_count` |
| `属性断言` | `attribute` | `_assert_attribute` |
| `URL 断言` | `url` | `_assert_url` |

未知断言动作必须显式报 `UNSUPPORTED_ACTION`，不得静默落属性断言。

## 3. 事件与结果载荷契约

- `step.asserted` 载荷：`{type, passed, expected, actual}`。
- **顺序契约**：`step.asserted` 恒在 `step.completed` / `step.failed` 之前（前端时间线依赖）。
- 断言失败走 `ASSERTION_FAILED: <type> expected=<...> actual=<...>` 结构化异常，由执行循环写入 `result.assertions` 并走既有 `failurePolicy`（立即失败 / 继续执行）。

## 4. 规范字段集（revision checksum）

进修订快照的断言字段（对应 `revision_snapshot.py:STEP_KEYS` 的断言部分，**漏加会被剔出快照——硬约束**）：

```
assertMatch  assertVisibility  assertOperator  assertAttribute  trimCompare
```

任何新断言字段必须先进入本契约文档，再同步到两端单一模块与 `STEP_KEYS`。

## 5. 跨层 parity 约束

- 前端 `actionOptions` 的断言动作 == 后端 `_ASSERTION_TYPES` 键（4 个）。
- 前端 `assertions.ts` 枚举 == 后端 `assertion_contract.py` 枚举 == 本契约第 1 节表。
- 任一方向漂移，对应 parity 测试即红。
