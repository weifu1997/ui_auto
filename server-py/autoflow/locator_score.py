"""D5 定位器自愈：候选定位器评分抽象 + 纯启发式实现（阶段2-F）。

`LocatorScorer` 是候选定位器评分接口，预留可选 LLM 实现（受限沙箱内替换
``HeuristicLocatorScorer`` 即可）；MVP 默认纯启发式——定位技术稳定性优先
（testid/role/label > text > css/XPath），且候选必须 ``count()===1`` 唯一
命中才可采纳，防止回退到模棱两可的定位器引入误点/误填。

评分只用于「定位失败后的候选回退」，不参与正常定位路径，因此不给正常执行
增加开销。安全边界：本模块纯评分，不触达敏感数据；runner 侧仅在元素定位
失败时用它挑选唯一命中的备用定位器，并发射既有 ``step.locatorFallback``
事件（不新增事件 kind）。
"""

from __future__ import annotations

from typing import Any, Protocol

# 定位技术稳定性权重（dom-to-locator 风格）：越高越优先。
# 候选定位器在构建时把来源技术标注在 `_autoflow_method`（取基础技术名，
# 如 `testidPartial` → `testid`），评分器据此取基础分。
_METHOD_STABILITY: dict[str, float] = {
    "testid": 100.0,
    "role": 90.0,
    "label": 80.0,
    "text": 60.0,
    "css": 40.0,
    "XPath": 20.0,
}


class LocatorScorer(Protocol):
    """候选定位器评分接口（预留可选 LLM 实现）。

    调用方在定位失败后对每个候选调用 ``score(locator, page)``；返回浮点质量
    分（越高越可靠），负无穷表示不可用。实现必须自行吸收 ``count()`` 等
    异常——候选打分失败一律按不可用处理。
    """

    def score(self, locator: Any, page: Any) -> float:
        """返回候选定位器的匹配质量分；不可用（count != 1）返回负无穷。"""
        ...


class HeuristicLocatorScorer:
    """dom-to-locator 风格纯启发式评分 + ``count()===1`` 唯一性。

    1. 候选必须唯一命中：``count() != 1`` 直接返回负无穷（不可用）。
    2. 唯一命中的按定位技术稳定性给基础分；候选定位器构建时标注了来源技术
       （``_autoflow_method``），评分值即该技术的基础分，稳定技术优先。
    """

    def score(self, locator: Any, page: Any) -> float:
        try:
            count = locator.count()
        except Exception:
            return float("-inf")
        if count != 1:
            return float("-inf")
        method = getattr(locator, "_autoflow_method", None)
        if not isinstance(method, str):
            return 0.0
        return _METHOD_STABILITY.get(method, 0.0)
