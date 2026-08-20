import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  isUsableVenv,
  projectVenvs,
  repoRoot,
} from "./python-env.mjs";

const venvRoot = join(repoRoot, "server-py", ".venv");
const venvs = projectVenvs();

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

function systemPython() {
  if (process.env.AUTOFLOW_PYTHON) {
    return process.env.AUTOFLOW_PYTHON;
  }
  const candidates = process.platform === "win32" ? ["python"] : ["python3", "python"];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (probe.status === 0) {
      return candidate;
    }
  }
  return fail("Could not find a system Python to create server-py/.venv.");
}

let selectedVenv = venvs.find(isUsableVenv);
if (!selectedVenv) {
  if (existsSync(venvRoot)) {
    console.error(
      `[setup:py] ${venvRoot} exists but has no usable pip. ` +
        "Remove it or install python3-venv, then rerun.",
    );
    process.exit(1);
  }
  run(systemPython(), ["-m", "venv", venvRoot], "Create virtual environment");
  selectedVenv = venvs[0];
}

const requirementsFile = existsSync(
  join(repoRoot, "server-py", "requirements.lock"),
)
  ? "requirements.lock"
  : "requirements.txt";

run(
  selectedVenv.python,
  ["-m", "pip", "install", "-r", join(repoRoot, "server-py", requirementsFile)],
  `Install Python dependencies (${requirementsFile})`,
);

const browserCache = process.env.PLAYWRIGHT_BROWSERS_PATH
  ? join(process.env.PLAYWRIGHT_BROWSERS_PATH)
  : join(repoRoot, "server-py", ".browsers");
if (existsSync(browserCache)) {
  console.log("[setup:py] Playwright browser cache already exists; skipping download");
} else {
  run(
    selectedVenv.python,
    ["-m", "playwright", "install", "chromium"],
    "Install Playwright Chromium",
  );
}

if (selectedVenv.label !== "server-py/.venv") {
  console.log(`[setup:py] Reusing existing environment: ${selectedVenv.label}`);
}
console.log(`[setup:py] Ready. Python: ${selectedVenv.python}`);
