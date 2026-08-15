import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const portIndex = args.findIndex((arg) => arg === "--port");
const port = portIndex >= 0 && args[portIndex + 1] ? args[portIndex + 1] : "4175";
const command = process.platform === "win32" ? "npm.cmd" : "npm";

const child = spawn(
  command,
  ["run", "dev", "--", "--host", "127.0.0.1", "--port", port],
  {
    cwd: repoRoot,
    env: { ...process.env, VITE_AUTH_REQUIRED: "1" },
    stdio: "inherit",
  },
);

child.on("error", (error) => {
  console.error(`Failed to start auth-required Vite server: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
