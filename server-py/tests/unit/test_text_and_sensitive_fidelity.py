"""Stage W0-2/W0-3: text 定位保真与敏感词表单源单测。

W0-2 契约：
- 浏览器描述符新增 ``fullText``（原文全文，上界 1000 字符），进入受信 DTO；
- 点击候选优先以 fullText 作为 text 定位值，展示标签（text）只用于 UI；
- 重放端 text 方法在页面无全字符串等值文本时自动降级子串匹配并发事件。

W0-3 契约：
- 词表唯一来源 autoflow.sensitive：中英文敏感词在注入脚本与服务端判定
  两侧一致，中文标签输入不再外泄明文 value。
"""

from __future__ import annotations

import json

from autoflow.recorder import (
    RECORDER_INIT_SCRIPT,
    RecorderNormalizer,
    is_sensitive_field,
    validate_recorder_event,
)
from autoflow.runner import _locator_for
from autoflow.sensitive import SENSITIVE_FIELD_PATTERN_SOURCE


# ---------- W0-2: fullText 捕获与候选生成 ----------


def _element(full_text: str, label_text: str) -> dict:
    return {
        "tag": "button",
        "type": "",
        "name": "",
        "id": "",
        "label": "",
        "autocomplete": "",
        "role": "button",
        "accessibleName": "",
        "testid": "",
        # 展示标签：折叠空白并截断到 60 字符的历史行为保持不变。
        "text": label_text,
        "fullText": full_text,
        "css": "body>button:nth-of-type(1)",
        "contenteditable": False,
    }


def _click_event(element: dict) -> dict:
    raw = {
        "kind": "click",
        "url": "https://env.test/dashboard",
        "at": 1,
        "element": element,
        "sensitive": False,
        "value": None,
    }
    validated = validate_recorder_event(raw)
    assert validated is not None
    return validated


def test_click_candidate_uses_full_text_not_truncated_label():
    """>60 字符按钮的 text 候选必须是全文，而不是历史截断值。"""
    full = (
        "这是一段特别长的确认文案用于验证录制端不会把定位值截断到六十个字符"
        "以上下限随便补位凑数继续补齐长度直到突破阈值为止请再补足若干个字"
    )
    assert len(full) > 60

    normalizer = RecorderNormalizer(
        start_url="https://env.test", environment_id="env-1"
    )
    normalizer.append(_click_event(_element(full, full[:60])))

    assets = normalizer.result()["elements"]
    text_assets = [a for a in assets if a["method"] == "text"]
    assert text_assets, f"expected a text-method asset, got {assets}"
    assert text_assets[0]["value"] == full


def test_validate_recorder_event_keeps_full_text_in_dto():
    """白名单必须透传 fullText；上界 1000 字符生效。"""
    event = validate_recorder_event(
        {
            "kind": "click",
            "url": "https://env.test/",
            "at": 1,
            "element": {"tag": "a", "fullText": "x" * 1500, "css": "a"},
            "sensitive": False,
            "value": None,
        }
    )
    assert event is not None
    assert len(event["element"]["fullText"]) == 1000


# ---------- W0-2: runner 侧 exact→子串降级 ----------


class _FakeLocator:
    def __init__(self, calls, count: int):
        self._calls = calls
        self._count = count

    def count(self) -> int:
        return self._count

    def match_calls(self):
        return list(self._calls)


class _FakePage:
    def __init__(self, exact_count: int):
        self.calls: list[tuple[str, bool]] = []
        self._exact_count = exact_count

    def get_by_text(self, value, *, exact=False):
        self.calls.append((value, exact))
        return _FakeLocator(self.calls, self._exact_count if exact else 7)


def test_text_locator_prefers_exact_when_equal_text_exists():
    page = _FakePage(exact_count=2)
    locator = _locator_for(page, {"method": "text", "value": "确定"})

    assert page.calls == [("确定", True)]
    assert locator.count() == 2


def test_text_locator_falls_back_to_substring_and_reports():
    """页面上没有等值文本（如旧数据的 60 字符截断值）时降级为子串匹配。"""
    page = _FakePage(exact_count=0)
    fallbacks: list[str] = []

    def on_fallback(value: str) -> None:
        fallbacks.append(value)

    _locator_for(
        page,
        {"method": "text", "value": "提交订单确认"},
        on_locator_fallback=on_fallback,
    )

    assert page.calls[0] == ("提交订单确认", True)
    assert page.calls[-1] == ("提交订单确认", False)
    assert fallbacks == ["提交订单确认"]


def test_text_locator_fallback_silent_without_callback():
    page = _FakePage(exact_count=0)
    _locator_for(page, {"method": "text", "value": "legacy"})
    assert [exact for _, exact in page.calls] == [True, False]


# ---------- W0-3: 敏感词表单源 ----------


def test_injected_script_embeds_shared_word_list():
    for word in ("密码", "令牌", "credential"):
        assert word in RECORDER_INIT_SCRIPT, f"missing {word} in init script"
    assert "new RegExp" in RECORDER_INIT_SCRIPT
    assert "@@AUTOFLOW_SENSITIVE@@" not in RECORDER_INIT_SCRIPT
    assert "@@AUTOFLOW_TESTID@@" not in RECORDER_INIT_SCRIPT
    assert 'getAttribute("data-testid")' in RECORDER_INIT_SCRIPT
    from autoflow.recorder_capture import recorder_init_script

    custom = recorder_init_script("data-cy")
    assert 'getAttribute("data-cy")' in custom
    assert 'getAttribute("data-testid")' not in custom


def test_is_sensitive_field_covers_chinese_labels():
    assert is_sensitive_field({"type": "password"})
    assert is_sensitive_field({"name": "user_name"}) is False
    assert is_sensitive_field({"label": "登录密码"})
    assert is_sensitive_field({"accessibleName": "访问令牌"})
    assert is_sensitive_field({"id": "api_token"})


def test_chinese_labeled_input_value_never_persists():
    """回归主体：中文标签敏感框的明文不得进入任何出栈事件载荷。"""
    secret_value = "PLAINTEXT-PASSWORD-123"
    payload = {
        "kind": "input",
        "url": "https://env.test/login",
        "at": 5,
        "value": secret_value,
        "sensitive": False,  # 浏览器侧旧词表漏判的情形
        "element": {
            "tag": "input",
            "type": "text",
            "name": "",
            "id": "field-1",
            "label": "密码",
            "autocomplete": "",
            "role": "",
            "accessibleName": "",
            "testid": "",
            "text": "",
            "fullText": "",
            "css": "#field-1",
            "contenteditable": False,
        },
    }
    event = validate_recorder_event(payload)
    assert event is not None
    assert event["sensitive"] is True
    serialized = json.dumps(event, ensure_ascii=False)
    assert secret_value not in serialized
    assert SENSITIVE_FIELD_PATTERN_SOURCE  # 单源词表非空
