import { spawnSync } from "node:child_process";
import { checkModule, repoRoot, resolvePython } from "./python-env.mjs";

const python = resolvePython();
const check = checkModule(python, "uvicorn");

if (check.status !== 0) {
  console.error(`Python module 'uvicorn' is not available in ${python}`);
  console.error("Run `npm run setup:py` to initialize the project Python environment.");
  process.exit(1);
}

const result = spawnSync(
  python,
  [
    "-m",
    "uvicorn",
    "autoflow.main:app",
    "--app-dir",
    "server-py",
    "--host",
    process.env.AUTOFLOW_LISTEN_HOST || "127.0.0.1",
    "--port",
    process.env.PORT || "8787",
  ],
  {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  },
);

if (result.error && result.status === null) {
  console.error(`Failed to run uvicorn: ${result.error.message}`);
  console.error("Run `npm run setup:py` to initialize the project Python environment.");
  process.exit(1);
}

process.exit(result.status ?? 1);
