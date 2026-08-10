import { chromium } from "playwright";
import type { Browser, BrowserContext, Locator, Page } from "playwright";
import type { ElementAsset, Environment, FlowStep } from "../src/mock-data";

export type RunnerFlow = { id: string; name: string; steps: FlowStep[] };
export type RunnerInput = {
  environment: Environment;
  flow: RunnerFlow;
  elements: ElementAsset[];
  variables: Record<string, string>;
  data: Record<string, string>;
  secrets: Record<string, string>;
  upToStepId?: string;
};

export type RunnerHooks = {
  signal: AbortSignal;
  artifactPath: (name: string, extension: string) => string;
  artifact: (input: { name: string; contentType: string; path: string }) => void;
  event: (kind: string, data: Record<string, unknown>) => void;
  browser?: (browser: Browser | undefined, context: BrowserContext | undefined) => void;
};

function interpolate(value: string, input: RunnerInput, outputs: Record<string, string>) {
  return value.replace(/{{\s*([^}]+)\s*}}/g, (_match, expression: string) => {
    const normalized = expression.trim();
    const [scope, ...keyParts] = normalized.split(".");
    const key = keyParts.join(".");
    if (scope === "env") return key === "baseUrl" ? input.environment.baseUrl : input.variables[`env.${key}`] ?? "";
    if (scope === "project") return input.variables[`project.${key}`] ?? input.variables[key] ?? "";
    if (scope === "data") return input.data[key] ?? "";
    if (scope === "secret") return input.secrets[key] ?? "";
    if (scope === "flow") return outputs[key] ?? input.variables[`flow.${key}`] ?? "";
    if (scope === "run" && key === "timestamp") return new Date().toISOString();
    return input.variables[normalized] ?? input.secrets[normalized] ?? "";
  });
}

function targetUrl(baseUrl: string, value: string) {
  try {
    const base = new URL(baseUrl);
    const target = new URL(value || "/", base);
    if (!["http:", "https:"].includes(base.protocol) || target.origin !== base.origin) throw new Error();
    return target.toString();
  } catch {
    throw new Error("TARGET_URL_ORIGIN_FORBIDDEN");
  }
}

function locatorFor(page: Page, element: ElementAsset, testIdAttribute = "data-testid"): Locator {
  const value = element.value;
  if (element.method === "testid") return page.locator(`[${testIdAttribute}=${JSON.stringify(value)}]`);
  if (element.method === "label") return page.getByLabel(value);
  if (element.method === "text") return page.getByText(value, { exact: true });
  if (element.method === "role") {
    const match = value.match(/^([\w-]+)(?:\[name=["']?(.*?)["']?\])?$/);
    return page.getByRole((match?.[1] ?? value) as Parameters<Page["getByRole"]>[0], match?.[2] ? { name: match[2] } : undefined);
  }
  if (element.method === "XPath") return page.locator(`xpath=${value}`);
  return page.locator(value);
}

export type ElementValidationInput = {
  environment: Environment;
  element: ElementAsset;
};

export async function executeElementValidation(input: ElementValidationInput, hooks: RunnerHooks) {
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  const started = Date.now();
  try {
    browser = await chromium.launch({ headless: process.env.MANAGED_RUNNER_HEADLESS !== "0" });
    context = await browser.newContext();
    hooks.browser?.(browser, context);
    const page = await context.newPage();
    await page.goto(targetUrl(input.environment.baseUrl, input.element.path || "/"), {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    if (hooks.signal.aborted) throw new Error("RUN_CANCELED");
    const locator = locatorFor(page, input.element, input.environment.testIdAttribute);
    const count = await locator.count();
    const firstMatch = count > 0
      ? await locator.first().evaluate((node) => node.outerHTML.slice(0, 1_000)).catch(() => undefined)
      : undefined;
    const path = hooks.artifactPath("element-validation.png", "png");
    await page.screenshot({ path, fullPage: true });
    hooks.artifact({ name: "element-validation.png", contentType: "image/png", path });
    return { status: "success" as const, count, firstMatch, elapsedMs: Date.now() - started };
  } catch (error) {
    const canceled = hooks.signal.aborted || (error instanceof Error && error.message === "RUN_CANCELED");
    return {
      status: canceled ? "canceled" as const : "failed" as const,
      count: 0,
      elapsedMs: Date.now() - started,
      error: canceled ? "VALIDATION_CANCELED" : error instanceof Error ? error.message : "VALIDATION_FAILED",
    };
  } finally {
    hooks.browser?.(undefined, undefined);
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

async function captureOutput(page: Page, step: FlowStep, locator: Locator | undefined) {
  if (!step.output) return undefined;
  if (step.outputSource === "url") {
    const url = new URL(page.url());
    return step.outputParameter ? url.searchParams.get(step.outputParameter) ?? "" : url.toString();
  }
  if (step.outputSource === "attribute") return locator && step.outputAttribute ? await locator.getAttribute(step.outputAttribute) ?? "" : "";
  return locator ? await locator.textContent() ?? "" : "";
}

async function executeStep(page: Page, step: FlowStep, input: RunnerInput, outputs: Record<string, string>) {
  const value = interpolate(step.value, input, outputs);
  const element = step.element ? input.elements.find((item) => item.name === step.element || item.id === step.element) : undefined;
  const locator = element ? locatorFor(page, element, input.environment.testIdAttribute) : undefined;
  const timeout = Math.max(1, step.timeout) * 1000;
  if (step.action === "打开页面") await page.goto(targetUrl(input.environment.baseUrl, value), { waitUntil: "domcontentloaded", timeout });
  else if (step.action === "点击") await required(locator).click({ timeout });
  else if (step.action === "填写") await required(locator).fill(value, { timeout });
  else if (step.action === "清空填写") await required(locator).fill("", { timeout });
  else if (step.action === "选择下拉项") await required(locator).selectOption(value, { timeout });
  else if (step.action === "勾选") await required(locator).check({ timeout });
  else if (step.action === "键盘按键") {
    if (locator) await locator.press(value, { timeout });
    else await page.keyboard.press(value);
  }
  else if (step.action === "等待") await page.waitForTimeout(Number(value) || timeout);
  else if (step.action === "可见性断言") await required(locator).waitFor({ state: "visible", timeout });
  else if (step.action === "文本断言") {
    const actual = await required(locator).textContent({ timeout });
    if (!(actual ?? "").includes(value)) throw new Error(`TEXT_ASSERTION_FAILED: expected ${value}, received ${actual ?? ""}`);
  } else if (step.action !== "截图") throw new Error(`UNSUPPORTED_ACTION: ${step.action}`);
  const output = await captureOutput(page, step, locator);
  if (step.output && output !== undefined) outputs[step.output] = output;
}

function required(locator: Locator | undefined) {
  if (!locator) throw new Error("STEP_ELEMENT_REQUIRED");
  return locator;
}

export async function executeBrowserRun(input: RunnerInput, hooks: RunnerHooks) {
  const sensitive = Object.values(input.secrets).some(Boolean);
  const outputs: Record<string, string> = {};
  const steps = input.upToStepId
    ? input.flow.steps.slice(0, input.flow.steps.findIndex((step) => step.id === input.upToStepId) + 1)
    : input.flow.steps;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let completedSteps = 0;
  let tracingStarted = false;
  const started = Date.now();
  try {
    browser = await chromium.launch({ headless: process.env.MANAGED_RUNNER_HEADLESS !== "0" });
    context = await browser.newContext();
    hooks.browser?.(browser, context);
    const page = await context.newPage();
    if (!sensitive) {
      await context.tracing.start({ screenshots: true, snapshots: true });
      tracingStarted = true;
    }
    else hooks.event("run.security", { message: "Sensitive run disabled screenshots and Trace" });
    for (const [index, step] of steps.entries()) {
      if (hooks.signal.aborted) throw new Error("RUN_CANCELED");
      const stepStarted = Date.now();
      hooks.event("step.started", { index, stepId: step.id, title: step.title });
      const attempts = step.failurePolicy === "重试 1 次" ? 2 : 1;
      let failure: unknown;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          if (step.action === "截图") {
            if (!sensitive) {
              const path = hooks.artifactPath(`${step.title}.png`, "png");
              await page.screenshot({ path, fullPage: true });
              hooks.artifact({ name: `${step.title}.png`, contentType: "image/png", path });
            }
          } else await executeStep(page, step, input, outputs);
          failure = undefined;
          break;
        } catch (error) {
          failure = error;
          if (attempt < attempts) hooks.event("step.retrying", { index, stepId: step.id, attempt });
        }
      }
      if (failure) {
        const error = failure instanceof Error ? failure.message : "STEP_FAILED";
        if (!sensitive) {
          const path = hooks.artifactPath(`failure-step-${index + 1}.png`, "png");
          await page.screenshot({ path, fullPage: true }).catch(() => undefined);
          hooks.artifact({ name: `failure-step-${index + 1}.png`, contentType: "image/png", path });
        }
        hooks.event("step.failed", { index, stepId: step.id, title: step.title, error, durationMs: Date.now() - stepStarted });
        if (step.failurePolicy !== "继续执行") throw failure;
      } else {
        completedSteps += 1;
        hooks.event("step.succeeded", { index, stepId: step.id, title: step.title, durationMs: Date.now() - stepStarted });
      }
    }
    if (context && !sensitive) {
      const path = hooks.artifactPath("trace.zip", "zip");
      await context.tracing.stop({ path });
      tracingStarted = false;
      hooks.artifact({ name: "trace.zip", contentType: "application/zip", path });
    }
    return { status: "success" as const, completedSteps, totalSteps: steps.length, elapsedMs: Date.now() - started, flowOutputs: outputs };
  } catch (error) {
    const canceled = hooks.signal.aborted || (error instanceof Error && error.message === "RUN_CANCELED");
    return { status: canceled ? "canceled" as const : "failed" as const, completedSteps, totalSteps: steps.length, elapsedMs: Date.now() - started, error: canceled ? "RUN_CANCELED" : error instanceof Error ? error.message : "RUN_FAILED", flowOutputs: outputs };
  } finally {
    hooks.browser?.(undefined, undefined);
    if (context && tracingStarted) {
      const path = hooks.artifactPath("trace.zip", "zip");
      await context.tracing.stop({ path }).then(() => {
        hooks.artifact({ name: "trace.zip", contentType: "application/zip", path });
      }).catch(() => undefined);
    }
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}
