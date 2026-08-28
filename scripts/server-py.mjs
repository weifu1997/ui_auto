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
    "autoflow.main:create_platform_app",
    "--factory",
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
let forceKill = null;
const forwardSignal = (signal) => {
  if (!child.killed) child.kill(signal);
  if (forceKill == null) {
    forceKill = setTimeout(() => {
      if (child.exitCode == null && child.signalCode == null) {
        child.kill("SIGKILL");
      }
    }, 10_000);
    forceKill.unref?.();
  }
};
signals.forEach((signal) => process.on(signal, forwardSignal));

child.once("error", (error) => {
  console.error(`Failed to run uvicorn: ${error.message}`);
  console.error("Run `npm run setup:py` to initialize the project Python environment.");
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (forceKill != null) clearTimeout(forceKill);
  signals.forEach((item) => process.removeListener(item, forwardSignal));
  process.exitCode = signal ? 1 : code ?? 1;
});
