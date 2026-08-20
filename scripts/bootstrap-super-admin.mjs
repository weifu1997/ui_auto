import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { repoRoot, resolvePython } from "./python-env.mjs";

const python = resolvePython();
const pythonPath = [resolve(repoRoot, "server-py"), process.env.PYTHONPATH]
  .filter(Boolean)
  .join(process.platform === "win32" ? ";" : ":");
const child = spawn(
  python,
  ["-m", "autoflow.bootstrap_super_admin", ...process.argv.slice(2)],
  {
    cwd: repoRoot,
    env: { ...process.env, PYTHONPATH: pythonPath },
    stdio: "inherit",
  },
);

child.once("error", (error) => {
  console.error(`Failed to start super-admin bootstrap: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = signal ? 1 : code ?? 1;
});
