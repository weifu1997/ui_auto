import { spawnSync } from "node:child_process";
import { checkModule, repoRoot, resolvePython } from "./python-env.mjs";

const args = process.argv.slice(2);
const python = resolvePython();
const moduleName = args[0] === "-m" ? args[1] : null;

if (moduleName) {
  const check = checkModule(python, moduleName);
  if (check.status !== 0) {
    console.error(`Python module '${moduleName}' is not available in ${python}`);
    console.error("Run `npm run setup:py` to initialize the project Python environment.");
    process.exit(1);
  }
}

const result = spawnSync(python, args, {
  cwd: repoRoot,
  env: process.env,
  stdio: "inherit",
});

if (result.error && result.status === null) {
  console.error(`Failed to run Python command: ${result.error.message}`);
  console.error("Run `npm run setup:py` to initialize the project Python environment.");
  process.exit(1);
}

process.exit(result.status ?? 1);
