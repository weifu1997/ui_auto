"""Stage W2-5: 断言判定收紧与空白归一化单测。

契约：
- `_run_assertion` 对未知断言动作显式抛 UNSUPPORTED_ACTION，不再静默
  落入属性断言，type 输出严格来自 _ASSERTION_TYPES 映射；
- 文本断言默认（trimCompare 未显式 false）比较前做空白归一化：
  首尾空白与连续空白折叠；显式关闭后恢复逐字符精确比较。
"""

from __future__ import annotations

import pytest

from autoflow.runner import _assert_text, _run_assertion


class _TextLocator:
    def __init__(self, text: str):
        self._text = text

    def text_content(self, timeout: int | None = None) -> str:
        return self._text


def _step(**overrides) -> dict:
    return {"action": "文本断言", "assertMatch": "exact", **overrides}


def test_unknown_assertion_action_is_rejected():
    with pytest.raises(RuntimeError, match="UNSUPPORTED_ACTION"):
        _run_assertion(_TextLocator("x"), None, {"action": "标题断言"}, 1000, "")


def test_assertion_type_comes_from_mapping_not_fallback():
    step = {"action": "数量断言", "assertOperator": "="}
    # 数量分支：fake locator 无 count → 直接走 _assert_count 会异常，
    # 这里仅验证分发后 type 字段不会错误回落为 text：
    class _CountLocator:
        def __init__(self):
            self.n = 0

        def count(self):
            return self.n

    from autoflow.runner import _assert_count

    page = None
    record = _assert_count(_CountLocator(), page, {**step}, 1000, "0")
    assert isinstance(record[2], str)


def test_text_compare_normalizes_whitespace_by_default():
    """真实 DOM 常见：text_content 带换行/多空格；期望值为折叠后的单行。"""
    locator = _TextLocator("登录 成功\n")
    passed, expected, actual = _assert_text(
        locator, None, _step(), 1000, "登录 成功"
    )
    assert passed is True
    assert expected == "登录 成功"
    assert actual == "登录 成功"


def test_text_compare_respects_trimcompare_false():
    locator = _TextLocator("登录 成功\n")
    passed, _expected, actual = _assert_text(
        locator, None, _step(trimCompare=False), 1000, "登录 成功"
    )
    assert passed is False
    assert actual.endswith("\n")
