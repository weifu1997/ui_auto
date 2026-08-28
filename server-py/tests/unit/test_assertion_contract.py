"""Python 侧跨层 parity：assertion_contract 与契约文档一致。

权威来源: ``.trellis/spec/backend/assertion-field-contract.md``。
前端对应: ``src/domain/assertions.ts``（由前端 parity 测试兜底）。
本测试额外校验 revision_snapshot.STEP_KEYS 内嵌规范断言字段的顺序/位置
（STEP_KEYS 键序直接进 checksum，漏加字段会被剔出修订快照——硬约束）。
"""

from __future__ import annotations

import pytest

from autoflow.assertion_contract import (
    ASSERT_ATTRIBUTE_DEFAULT,
    ASSERTION_KEYS,
    ASSERTION_TYPES,
    ASSERT_MATCHES,
    ASSERT_OPERATORS,
    ASSERT_VISIBILITIES,
)
from autoflow.revision_snapshot import STEP_KEYS


def test_assertion_enums_match_contract() -> None:
    assert ASSERT_MATCHES == ("exact", "contains")
    assert ASSERT_VISIBILITIES == ("visible", "hidden")
    assert ASSERT_OPERATORS == ("=", ">", "<", ">=", "<=")
    assert ASSERT_ATTRIBUTE_DEFAULT == "value"


def test_assertion_type_mapping_matches_contract() -> None:
    assert ASSERTION_TYPES == {
        "可见性断言": "visibility",
        "文本断言": "text",
        "数量断言": "count",
        "属性断言": "attribute",
        "URL 断言": "url",
    }


def test_assertion_keys_embedded_in_step_keys_in_place() -> None:
    """规范断言字段必须原样、原位内嵌进 STEP_KEYS（键序进 checksum）。"""
    assert ASSERTION_KEYS == (
        "assertMatch",
        "assertVisibility",
        "assertOperator",
        "assertAttribute",
        "trimCompare",
    )
    # 五字段按序连续出现在 STEP_KEYS 中。
    for index, key in enumerate(ASSERTION_KEYS):
        assert key in STEP_KEYS
    window = STEP_KEYS[STEP_KEYS.index("failurePolicy") + 1 :]
    assert window[: len(ASSERTION_KEYS)] == ASSERTION_KEYS


@pytest.mark.parametrize(
    ("module_keys", "contract_keys"),
    [
        (tuple(ASSERTION_TYPES), ("可见性断言", "文本断言", "数量断言", "属性断言", "URL 断言")),
    ],
)
def test_mapping_keys_match_contract(module_keys: tuple[str, ...], contract_keys: tuple[str, ...]) -> None:
    assert tuple(sorted(module_keys)) == tuple(sorted(contract_keys))
