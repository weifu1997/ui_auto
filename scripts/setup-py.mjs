import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { repoRoot } from "./python-env.mjs";

const CHROMIUM_BINARIES = new Set([
  "chrome",
  "chrome.exe",
  "chromium",
  "chromium.exe",
  "chrome-headless-shell",
  "chrome-headless-shell.exe",
  "headless_shell",
  "headless_shell.exe",
]);

export function defaultPlaywrightCache(environment = process.env, platform = process.platform) {
  if (platform === "darwin") {
    return join(homedir(), "Library", "Caches", "ms-playwright");
  }
  if (platform === "win32") {
    return join(
      environment.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
      "ms-playwright",
    );
  }
  return join(homedir(), ".cache", "ms-playwright");
}

export function resolveBrowserCache(environment = process.env, platform = process.platform) {
  return environment.PLAYWRIGHT_BROWSERS_PATH
    ? join(environment.PLAYWRIGHT_BROWSERS_PATH)
    : defaultPlaywrightCache(environment, platform);
}

export function chromiumLooksInstalled(cacheDir) {
  if (!cacheDir || !existsSync(cacheDir)) return false;
  const walk = (dir, depth) => {
    if (depth > 6) return false;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isFile() && CHROMIUM_BINARIES.has(entry.name)) return true;
      if (entry.isDirectory() && walk(path, depth + 1)) return true;
    }
    return false;
  };
  return walk(cacheDir, 0);
}

function fail(message, exitCode = 1) {
  console.error(message);
  process.exit(exitCode);
}

function run(command, args, label, env = process.env) {
  console.log(`[setup:py] ${label}`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
  if ((result.error && result.status === null) || result.status !== 0) {
    fail(
      `[setup:py] ${label} failed: ${
        result.error ? result.error.message : `exit code ${result.status}`
      }`,
    );
  }
}

export function main() {
  const uvCheck = spawnSync("uv", ["--version"], { encoding: "utf8" });
  if (uvCheck.status !== 0) {
    console.error(
      "[setup:py] `uv` is not installed or not on PATH.\n" +
        "Install it once (https://docs.astral.sh/uv/):\n" +
        (process.platform === "win32"
          ? '  powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"\n'
          : "  curl -LsSf https://astral.sh/uv/install.sh | sh\n") +
        "CI installs uv via astral-sh/setup-uv automatically.",
    );
    process.exit(1);
  }
  console.log(`[setup:py] Using ${uvCheck.stdout.trim()}`);

  // uv sync creates server-py/.venv (the interpreter resolvePython() probes first)
  // and installs from server-py/uv.lock. AUTOFLOW_PYTHON overrides the interpreter.
  const pythonFlag = process.env.AUTOFLOW_PYTHON
    ? ["--python", process.env.AUTOFLOW_PYTHON]
    : [];
  const frozen = process.env.CI ? ["--frozen"] : [];
  run(
    "uv",
    ["sync", "--project", "server-py", ...frozen, ...pythonFlag],
    process.env.CI
      ? "Sync Python dependencies (uv sync --frozen, from uv.lock)"
      : "Sync Python dependencies (uv sync, from uv.lock)",
  );

  const browserCache = resolveBrowserCache();
  if (chromiumLooksInstalled(browserCache)) {
    console.log("[setup:py] Playwright Chromium already present; skipping download");
  } else {
    run(
      "uv",
      ["run", "--project", "server-py", "python", "-m", "playwright", "install", "chromium"],
      "Install Playwright Chromium",
      { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserCache },
    );
  }

  console.log("[setup:py] Ready. Python environment: server-py/.venv");
}

const entry = process.argv[1] && resolve(process.argv[1]);
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main();
}
