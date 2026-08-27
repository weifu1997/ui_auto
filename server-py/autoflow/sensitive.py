"""敏感字段词表单源（W0-3）。

录制防线的判定规则此前分散在三处：浏览器注入脚本的正则、服务端
``recorder.SENSITIVE_FIELD_PATTERN``、前端 ``platform-api.ts`` 的兜底词表——
三者覆盖面不一致导致中文标签的敏感输入其明文值可经事件流外泄。
本模块是唯一权威词表：服务端正则与注入脚本的 JS 正则都从这里生成，
新增敏感词只允许改这里。
"""

from __future__ import annotations

import re
from typing import Any

# 英文沿用历史词表；中文词取自前端兜底逻辑原有的覆盖面。
SENSITIVE_FIELD_WORDS: tuple[str, ...] = (
    "password",
    "passwd",
    "secret",
    "token",
    "api[-_ ]?key",
    "credential",
    "密码",
    "口令",
    "秘钥",
    "密钥",
    "令牌",
    "凭证",
)

SENSITIVE_FIELD_PATTERN_SOURCE = "|".join(SENSITIVE_FIELD_WORDS)

SENSITIVE_FIELD_PATTERN = re.compile(SENSITIVE_FIELD_PATTERN_SOURCE, re.IGNORECASE)

# 注入脚本侧通过占位符替换嵌入同一份词表（词表中没有引号/反斜杠，可直接嵌入）。
JS_SENSITIVE_PATTERN_SOURCE = SENSITIVE_FIELD_PATTERN_SOURCE


def is_sensitive_field(element: dict[str, Any] | None) -> bool:
    """与 recorder 层语义一致：type=password 或字段名/可访问名命中词表。"""
    if not isinstance(element, dict):
        return False
    if str(element.get("type") or "").lower() == "password":
        return True
    haystack = " ".join(
        str(element.get(field) or "")
        for field in ("name", "id", "label", "accessibleName", "autocomplete")
    )
    return bool(SENSITIVE_FIELD_PATTERN.search(haystack))
