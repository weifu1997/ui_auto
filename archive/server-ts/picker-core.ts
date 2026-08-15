import type { Page } from "playwright";

/**
 * Shared interactive element-picker logic used by both the platform Agent
 * (agent/index.ts) and the local Worker capture channel (server/index.ts).
 * The injection script must stay plain JS: tsx rewrites TS arrow/function
 * declarations with an `__name` helper that is not available inside
 * page.evaluate's serialized function.
 */

export type PickerMethod = "testid" | "role" | "label" | "text" | "css";
export type PickerCandidate = {
  method: PickerMethod;
  value: string;
  count: number;
  score: number;
  label: string;
};

export type PickerTarget = {
  target?: unknown;
  testid?: unknown;
  role?: unknown;
  label?: unknown;
  text?: unknown;
  css?: unknown;
};

export function pickerInjectionScript(testIdAttribute: string) {
  return `
    (() => {
      const testIdAttribute = ${JSON.stringify(testIdAttribute)};
      const current = window;
      if (current.__autoflowPickerCleanup) current.__autoflowPickerCleanup();
      const cssPath = (element) => {
        const id = element.getAttribute("id");
        if (id) return "#" + CSS.escape(id);
        const segments = [];
        let node = element;
        while (node && segments.length < 5) {
          const tag = node.tagName.toLowerCase();
          const siblings = node.parentElement ? [...node.parentElement.children].filter((child) => child.tagName === node.tagName) : [];
          const index = siblings.indexOf(node) + 1;
          segments.unshift(tag + ":nth-of-type(" + Math.max(1, index) + ")");
          node = node.parentElement;
        }
        return segments.join(" > ");
      };
      const roleFor = (element) => {
        const explicit = element.getAttribute("role");
        if (explicit) return explicit;
        if (element.tagName === "BUTTON") return "button";
        if (element.tagName === "A") return "link";
        if (element.tagName === "SELECT") return "combobox";
        if (element.tagName === "TEXTAREA") return "textbox";
        if (element.tagName === "INPUT") return element.getAttribute("type") === "checkbox" ? "checkbox" : "textbox";
        return "";
      };
      const listener = (event) => {
        const element = event.target instanceof HTMLElement ? event.target : undefined;
        if (!element) return;
        event.preventDefault();
        event.stopPropagation();
        const labels = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
          ? [...(element.labels || [])].map((label) => (label.textContent || "").trim()).filter(Boolean)
          : [];
        if (current.autoflowDebugPickerCapture) {
          current.autoflowDebugPickerCapture({
            target: element.tagName.toLowerCase() + (element.id ? "#" + element.id : ""),
            testid: element.getAttribute(testIdAttribute) || "",
            role: roleFor(element),
            label: labels[0] || element.getAttribute("aria-label") || "",
            text: (element.innerText || element.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 120),
            css: cssPath(element),
          });
        }
        if (current.__autoflowPickerCleanup) current.__autoflowPickerCleanup();
      };
      document.addEventListener("click", listener, true);
      current.__autoflowPickerCleanup = () => document.removeEventListener("click", listener, true);
    })();
  `;
}

export function pickerCandidateLocator(page: Page, candidate: Pick<PickerCandidate, "method" | "value">, testIdAttribute = "data-testid") {
  if (candidate.method === "testid") return page.locator(`[${testIdAttribute}=${JSON.stringify(candidate.value)}]`);
  if (candidate.method === "role") return page.getByRole(candidate.value as never);
  if (candidate.method === "label") return page.getByLabel(candidate.value);
  if (candidate.method === "text") return page.getByText(candidate.value, { exact: true });
  return page.locator(candidate.value);
}

export function pickerScore(method: PickerMethod, count: number) {
  const base = { testid: 98, role: 84, label: 80, text: 62, css: 52 }[method];
  if (count === 1) return base;
  if (count === 0) return 0;
  return Math.max(5, base - Math.min(70, (count - 1) * 12));
}

export async function buildPickerCandidates(
  page: Page,
  target: PickerTarget,
  testIdAttribute: string,
  secretValues: string[],
) {
  const source = [
    { method: "testid" as const, value: target.testid, label: testIdAttribute },
    { method: "role" as const, value: target.role, label: "role" },
    { method: "label" as const, value: target.label, label: "label" },
    { method: "text" as const, value: target.text, label: "text" },
    { method: "css" as const, value: target.css, label: "css" },
  ];
  const seen = new Set<string>();
  const candidates: PickerCandidate[] = [];
  for (const item of source) {
    const value = item.value;
    if (typeof value !== "string" || !value.trim() || value.length > 500) continue;
    if (secretValues.some((secret) => secret && value.includes(secret))) continue;
    const key = `${item.method}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const count = await pickerCandidateLocator(page, { method: item.method, value }, testIdAttribute).count();
      candidates.push({ method: item.method, value, count, score: pickerScore(item.method, count), label: `${item.label}: ${value}`.slice(0, 160) });
    } catch {
      // Ignore a locator that cannot be evaluated in the current document.
    }
  }
  return candidates.sort((left, right) => right.score - left.score);
}

export async function previewPickerCandidate(
  page: Page,
  candidate: Pick<PickerCandidate, "method" | "value">,
  testIdAttribute: string,
) {
  const locator = pickerCandidateLocator(page, candidate, testIdAttribute);
  const count = await locator.count();
  if (count > 0) {
    await locator.first().evaluate((element) => {
      const target = element as HTMLElement;
      const prior = target.style.outline;
      const priorOffset = target.style.outlineOffset;
      target.style.outline = "3px solid #e5a11a";
      target.style.outlineOffset = "2px";
      target.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
      window.setTimeout(() => {
        target.style.outline = prior;
        target.style.outlineOffset = priorOffset;
      }, 4000);
    });
  }
  return count;
}