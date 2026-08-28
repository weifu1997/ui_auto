import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromiumLooksInstalled, resolveBrowserCache } from "./setup-py.mjs";

test("resolveBrowserCache uses Playwright's default cache and honors env", () => {
  assert.equal(
    resolveBrowserCache({ PLAYWRIGHT_BROWSERS_PATH: "/opt/browsers" }),
    join("/opt", "browsers"),
  );
  assert.match(
    resolveBrowserCache({}, "linux"),
    /ms-playwright$/,
  );
});

test("chromiumLooksInstalled is false for missing or empty cache dirs", () => {
  const root = mkdtempSync(join(tmpdir(), "autoflow-browsers-"));
  try {
    assert.equal(chromiumLooksInstalled(join(root, "missing")), false);
    const empty = join(root, "empty");
    mkdirSync(empty);
    assert.equal(chromiumLooksInstalled(empty), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("chromiumLooksInstalled finds a nested chrome binary", () => {
  const root = mkdtempSync(join(tmpdir(), "autoflow-browsers-"));
  try {
    const chromeDir = join(root, "chromium-123", "chrome-linux64");
    mkdirSync(chromeDir, { recursive: true });
    writeFileSync(join(chromeDir, "chrome"), "");
    assert.equal(chromiumLooksInstalled(root), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
