import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { repoRoot } from "./python-env.mjs";

const projectDir = join(repoRoot, "server-py");

function fail(message, exitCode = 1) {
  console.error(message);
  process.exit(exitCode);
}

function run(command, args, label) {
  console.log(`[setup:py] ${label}`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: process.env,
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
run(
  "uv",
  ["sync", "--project", "server-py", ...pythonFlag],
  "Sync Python dependencies (uv sync, from uv.lock)",
);

const browserCache = process.env.PLAYWRIGHT_BROWSERS_PATH
  ? join(process.env.PLAYWRIGHT_BROWSERS_PATH)
  : join(projectDir, ".browsers");
if (existsSync(browserCache)) {
  console.log("[setup:py] Playwright browser cache already exists; skipping download");
} else {
  run(
    "uv",
    ["run", "--project", "server-py", "python", "-m", "playwright", "install", "chromium"],
    "Install Playwright Chromium",
  );
}

console.log("[setup:py] Ready. Python environment: server-py/.venv");
