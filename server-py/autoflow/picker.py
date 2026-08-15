"""Interactive element-picker logic matching server/picker-core.ts."""

from __future__ import annotations

import json
from typing import Any


def picker_injection_script(test_id_attribute: str) -> str:
    return f"""
    (() => {{
      const testIdAttribute = {json.dumps(test_id_attribute)};
      const current = window;
      if (current.__autoflowPickerCleanup) current.__autoflowPickerCleanup();
      const cssPath = (element) => {{
        const id = element.getAttribute("id");
        if (id) return "#" + CSS.escape(id);
        const segments = [];
        let node = element;
        while (node && segments.length < 5) {{
          const tag = node.tagName.toLowerCase();
          const siblings = node.parentElement ? [...node.parentElement.children].filter((child) => child.tagName === node.tagName) : [];
          const index = siblings.indexOf(node) + 1;
          segments.unshift(tag + ":nth-of-type(" + Math.max(1, index) + ")");
          node = node.parentElement;
        }}
        return segments.join(" > ");
      }};
      const roleFor = (element) => {{
        const explicit = element.getAttribute("role");
        if (explicit) return explicit;
        if (element.tagName === "BUTTON") return "button";
        if (element.tagName === "A") return "link";
        if (element.tagName === "SELECT") return "combobox";
        if (element.tagName === "TEXTAREA") return "textbox";
        if (element.tagName === "INPUT") return element.getAttribute("type") === "checkbox" ? "checkbox" : "textbox";
        return "";
      }};
      const listener = (event) => {{
        const element = event.target instanceof HTMLElement ? event.target : undefined;
        if (!element) return;
        event.preventDefault();
        event.stopPropagation();
        const labels = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
          ? [...(element.labels || [])].map((label) => (label.textContent || "").trim()).filter(Boolean)
          : [];
        if (current.autoflowDebugPickerCapture) {{
          current.autoflowDebugPickerCapture({{
            target: element.tagName.toLowerCase() + (element.id ? "#" + element.id : ""),
            testid: element.getAttribute(testIdAttribute) || "",
            role: roleFor(element),
            label: labels[0] || element.getAttribute("aria-label") || "",
            text: (element.innerText || element.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 120),
            css: cssPath(element),
          }});
        }}
        if (current.__autoflowPickerCleanup) current.__autoflowPickerCleanup();
      }};
      document.addEventListener("click", listener, true);
      current.__autoflowPickerCleanup = () => document.removeEventListener("click", listener, true);
    }})();
  """


def picker_candidate_locator(
    page: Any,
    candidate: dict[str, Any],
    test_id_attribute: str = "data-testid",
) -> Any:
    method = candidate.get("method")
    value = str(candidate.get("value", ""))
    if method == "testid":
        return page.locator(f"[{test_id_attribute}={json.dumps(value)}]")
    if method == "role":
        return page.get_by_role(value)
    if method == "label":
        return page.get_by_label(value)
    if method == "text":
        return page.get_by_text(value, exact=True)
    return page.locator(value)


def picker_score(method: str, count: int) -> int:
    base = {
        "testid": 98,
        "role": 84,
        "label": 80,
        "text": 62,
        "css": 52,
    }.get(method, 52)
    if count == 1:
        return base
    if count == 0:
        return 0
    return max(5, base - min(70, (count - 1) * 12))


def build_picker_candidates(
    page: Any,
    target: dict[str, Any],
    test_id_attribute: str,
    secret_values: list[str],
) -> list[dict[str, Any]]:
    source = [
        {"method": "testid", "value": target.get("testid"), "label": test_id_attribute},
        {"method": "role", "value": target.get("role"), "label": "role"},
        {"method": "label", "value": target.get("label"), "label": "label"},
        {"method": "text", "value": target.get("text"), "label": "text"},
        {"method": "css", "value": target.get("css"), "label": "css"},
    ]
    seen: set[str] = set()
    candidates: list[dict[str, Any]] = []
    for item in source:
        value = item["value"]
        if not isinstance(value, str) or not value.strip() or len(value) > 500:
            continue
        if any(secret and secret in value for secret in secret_values):
            continue
        key = f"{item['method']}:{value}"
        if key in seen:
            continue
        seen.add(key)
        try:
            count = picker_candidate_locator(
                page,
                {"method": item["method"], "value": value},
                test_id_attribute,
            ).count()
            candidates.append(
                {
                    "method": item["method"],
                    "value": value,
                    "count": count,
                    "score": picker_score(item["method"], count),
                    "label": f"{item['label']}: {value}"[:160],
                }
            )
        except Exception:
            continue
    return sorted(candidates, key=lambda item: item["score"], reverse=True)


def preview_picker_candidate(
    page: Any,
    candidate: dict[str, Any],
    test_id_attribute: str,
) -> int:
    locator = picker_candidate_locator(page, candidate, test_id_attribute)
    count = locator.count()
    if count > 0:
        locator.first.evaluate(
            """(element) => {
                const target = element;
                const prior = target.style.outline;
                const priorOffset = target.style.outlineOffset;
                target.style.outline = "3px solid #e5a11a";
                target.style.outlineOffset = "2px";
                target.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
                window.setTimeout(() => {
                  target.style.outline = prior;
                  target.style.outlineOffset = priorOffset;
                }, 4000);
              }"""
        )
    return count
