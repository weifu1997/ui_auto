import { spawn } from "node:child_process";
import { checkModule, repoRoot, resolvePython } from "./python-env.mjs";

const python = resolvePython();
const check = checkModule(python, "uvicorn");

if (check.status !== 0) {
  console.error(`Python module 'uvicorn' is not available in ${python}`);
  console.error("Run `npm run setup:py` to initialize the project Python environment.");
  process.exit(1);
}

const child = spawn(
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

const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
const forwardSignal = (signal) => {
  if (!child.killed) child.kill(signal);
};
signals.forEach((signal) => process.once(signal, forwardSignal));

child.once("error", (error) => {
  console.error(`Failed to run uvicorn: ${error.message}`);
  console.error("Run `npm run setup:py` to initialize the project Python environment.");
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  signals.forEach((item) => process.removeListener(item, forwardSignal));
  process.exitCode = signal ? 1 : code ?? 1;
});
