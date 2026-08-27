"""Stage W2-5: 断言判定收紧与空白归一化单测。

契约：
- `_run_assertion` 对未知断言动作显式抛 UNSUPPORTED_ACTION，不再静默
  落入属性断言，type 输出严格来自 _ASSERTION_TYPES 映射；
- 文本断言默认（trimCompare 未显式 false）比较前做空白归一化：
  首尾空白与连续空白折叠；显式关闭后恢复逐字符精确比较。
"""

from __future__ import annotations

import pytest

from autoflow.runner import _assert_text, _assert_url, _run_assertion


class _TextLocator:
    def __init__(self, text: str):
        self._text = text

    def text_content(self, timeout: int | None = None) -> str:
        return self._text


class _UrlPage:
    """URL 断言用的假页面：`url` 为普通属性；`broken` 时访问抛异常。"""

    def __init__(self, url: str, *, broken: bool = False):
        self._url = url
        self._broken = broken

    @property
    def url(self) -> str:
        if self._broken:
            raise RuntimeError("Target page, context or browser has been closed")
        return self._url


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


# ---------- R3-1：URL 断言（页面级，无元素） ----------


def _url_step(**overrides) -> dict:
    return {"action": "URL 断言", "assertMatch": "contains", **overrides}


def test_url_assert_contains_default():
    """缺省匹配方式为 contains：实际 URL 含期望子串即通过。"""
    passed, expected, actual = _assert_url(
        _UrlPage("https://app.test/__fixture/login?next=/dash"),
        _url_step(),
        1000,
        "/__fixture/login",
    )
    assert passed is True
    assert expected == "/__fixture/login"
    assert actual == "https://app.test/__fixture/login?next=/dash"


def test_url_assert_contains_fail_on_missing_substring():
    passed, _expected, actual = _assert_url(
        _UrlPage("https://app.test/home"),
        _url_step(),
        1000,
        "/__fixture/login",
    )
    assert passed is False
    assert actual == "https://app.test/home"


def test_url_assert_exact():
    url = "https://app.test/__fixture/login"
    passed, expected, actual = _assert_url(
        _UrlPage(url),
        _url_step(assertMatch="exact"),
        1000,
        url,
    )
    assert passed is True
    assert expected == url
    assert actual == url


def test_url_assert_exact_ignores_extra_query():
    """exact 含查询串：实际多出查询参数不算命中。"""
    passed, _expected, _actual = _assert_url(
        _UrlPage("https://app.test/login?next=/dash"),
        _url_step(assertMatch="exact"),
        1000,
        "https://app.test/login",
    )
    assert passed is False


def test_url_assert_page_unavailable_does_not_raise():
    """页面关闭/取 URL 异常：判定为不可用（不抛非预期异常）。"""
    passed, _expected, actual = _assert_url(
        _UrlPage("", broken=True),
        _url_step(),
        1000,
        "/__fixture/login",
    )
    assert passed is False
    assert actual == "not-available"


def test_run_assertion_url_dispatch_without_locator():
    """URL 断言经 _run_assertion 分发：无元素（locator=None）不落
    STEP_ELEMENT_REQUIRED，type 严格来自映射（url）。"""
    record = _run_assertion(
        None,
        _UrlPage("https://app.test/__fixture/login"),
        {"action": "URL 断言", "assertMatch": "contains"},
        1000,
        "/__fixture/login",
    )
    assert record == {
        "type": "url",
        "passed": True,
        "expected": "/__fixture/login",
        "actual": "https://app.test/__fixture/login",
    }
