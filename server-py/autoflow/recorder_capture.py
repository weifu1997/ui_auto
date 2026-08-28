"""Browser capture script injected via ``context.add_init_script``.

录制 MVP 内核拆分（阶段2-A）：浏览器侧采集脚本常量为纯字符串，零 Python
逻辑；敏感词表由 ``autoflow.sensitive`` 单源替换进模板（W0-3），对外常量名
（``RECORDER_INIT_SCRIPT``）保持不变。
"""

import re

from .sensitive import JS_SENSITIVE_PATTERN_SOURCE

RECORDER_INIT_SCRIPT_TEMPLATE = r"""
(() => {
  if (window.__autoflowRecorderInstalled) return;
  window.__autoflowRecorderInstalled = true;
  const SENSITIVE = new RegExp("@@AUTOFLOW_SENSITIVE@@", "i");
  const frameKind = () => (window.top === window ? "top" : "child");
  const safeUrl = () => location.protocol + "//" + location.host + location.pathname;
  const labelText = (el) => {
    if (el.labels && el.labels.length) return (el.labels[0].textContent || "").trim();
    const aria = el.getAttribute("aria-label");
    return aria ? aria.trim() : "";
  };
  const roleFor = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a" && el.getAttribute("href")) return "link";
    if (tag === "select") return "combobox";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "button" || type === "submit") return "button";
    }
    return "";
  };
  const cssPath = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      let selector = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(selector + "#" + node.id);
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (child) => child.tagName === node.tagName,
        );
        if (siblings.length > 1) {
          selector += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")";
        }
      }
      parts.unshift(selector);
      node = node.parentElement;
    }
    return parts.join(">");
  };
  const descriptor = (el) => ({
    tag: el.tagName.toLowerCase(),
    type: (el.getAttribute("type") || "").toLowerCase(),
    name: el.getAttribute("name") || "",
    id: el.id || "",
    label: labelText(el),
    autocomplete: el.getAttribute("autocomplete") || "",
    role: roleFor(el),
    accessibleName: labelText(el) || (el.getAttribute("aria-label") || "").trim(),
    testid: el.getAttribute("@@AUTOFLOW_TESTID@@") || "",
    // text 是展示用的折叠截断标签；fullText 才是定位候选使用的原文全文
    // （重放端 get_by_text 按空白归一化后的全字符串匹配，截断值必然失配）。
    text: (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60),
    fullText: (el.innerText || el.textContent || "").trim().slice(0, 1000),
    css: cssPath(el),
    contenteditable: Boolean(el.isContentEditable || el.getAttribute("contenteditable") === "true"),
  });
  const sensitiveFor = (el, desc) =>
    (el.tagName === "INPUT" && desc.type === "password") ||
    SENSITIVE.test(
      [desc.name, desc.id, desc.label, el.getAttribute("autocomplete") || ""].join(" "),
    );
  const emit = (payload) => {
    try {
      window.__autoflowRecorderEvent(
        Object.assign({ frame: frameKind(), url: safeUrl(), at: Date.now() }, payload),
      );
    } catch (error) {
      /* binding 在会话回收后不可用，忽略 */
    }
  };
  const target = (event) =>
    event.target instanceof Element
      ? event.target
      : event.target && event.target.parentElement instanceof Element
        ? event.target.parentElement
        : null;
  const semanticTarget = (event) => {
    const source = target(event);
    if (!source || source.getRootNode() !== document) return source;
    for (let el = source; el && el.ownerDocument === document; el = el.parentElement) {
      const tag = el.tagName.toLowerCase();
      if (
        tag === "button" ||
        (tag === "a" && el.hasAttribute("href")) ||
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        Boolean((el.getAttribute("role") || "").trim())
      ) {
        return el;
      }
    }
    return source;
  };
  const unsupportedFeature = (event, el) => {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    if (path.some((node) => typeof ShadowRoot !== "undefined" && node instanceof ShadowRoot)) {
      return "shadow-dom";
    }
    if (el && (el.isContentEditable || el.getAttribute("contenteditable") === "true")) {
      return "contenteditable";
    }
    return "";
  };
  const emitUnsupported = (event, feature) => {
    const el = semanticTarget(event);
    emit({
      kind: "unsupported",
      feature,
      element: el ? descriptor(el) : null,
    });
  };
  document.addEventListener(
    "click",
    (event) => {
      const source = target(event);
      const el = semanticTarget(event);
      if (!el) return;
      const unsupported = unsupportedFeature(event, source);
      if (unsupported) {
        emitUnsupported(event, unsupported);
        return;
      }
      const desc = descriptor(el);
      emit({ kind: "click", element: desc, sensitive: sensitiveFor(el, desc) });
    },
    true,
  );
  document.addEventListener(
    "input",
    (event) => {
      const el = event.target;
      if (el instanceof HTMLElement) {
        const unsupported = unsupportedFeature(event, el);
        if (unsupported) {
          emitUnsupported(event, unsupported);
          return;
        }
      }
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
      const desc = descriptor(el);
      if (desc.type === "checkbox" || desc.type === "radio") return;
      const sensitive = sensitiveFor(el, desc);
      emit({
        kind: "input",
        element: desc,
        sensitive,
        value: sensitive ? null : String(el.value || ""),
      });
    },
    true,
  );
  document.addEventListener(
    "change",
    (event) => {
      const el = event.target;
      if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement)) return;
      const unsupported = unsupportedFeature(event, el);
      if (unsupported) {
        emitUnsupported(event, unsupported);
        return;
      }
      const desc = descriptor(el);
      const payload = {
        kind: "change",
        element: desc,
        sensitive: sensitiveFor(el, desc),
      };
      if (el instanceof HTMLSelectElement) payload.selectedValue = el.value;
      else payload.checked = Boolean(el.checked);
      emit(payload);
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (!["Enter", "Escape", "Tab"].includes(event.key)) return;
      const source = target(event);
      const el = semanticTarget(event);
      const unsupported = unsupportedFeature(event, source);
      if (unsupported) {
        emitUnsupported(event, unsupported);
        return;
      }
      emit({ kind: "keydown", key: event.key, element: el ? descriptor(el) : null });
    },
    true,
  );
  ["dragstart", "drop"].forEach((kind) => {
    document.addEventListener(kind, (event) => emitUnsupported(event, "drag"), true);
  });
})();
"""

def recorder_init_script(test_id_attribute: str = "data-testid") -> str:
    """Fill sensitive-word and test-id placeholders for a recording session."""
    attribute = (
        test_id_attribute
        if re.match(r"^[a-zA-Z_][\w:-]*$", test_id_attribute or "")
        else "data-testid"
    )
    return RECORDER_INIT_SCRIPT_TEMPLATE.replace(
        "@@AUTOFLOW_SENSITIVE@@", JS_SENSITIVE_PATTERN_SOURCE
    ).replace("@@AUTOFLOW_TESTID@@", attribute)


# 词表由 autoflow.sensitive 单源生成后替换进模板（W0-3），保持对外常量名不变。
RECORDER_INIT_SCRIPT = recorder_init_script()
