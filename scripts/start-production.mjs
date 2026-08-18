import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function getStaticDirectory(environment = process.env, root = repoRoot) {
  const configured = environment.AUTOFLOW_STATIC_DIRECTORY || "dist";
  return resolve(root, configured);
}

export function validateProductionPrerequisites(
  environment = process.env,
  root = repoRoot,
) {
  const staticDirectory = getStaticDirectory(environment, root);
  if (!existsSync(resolve(staticDirectory, "index.html"))) {
    throw new Error(
      `Production build not found at ${resolve(staticDirectory, "index.html")}. Run \`npm run build\` first.`,
    );
  }
  if (typeof environment.PLATFORM_SECRET_KEY !== "string" || !environment.PLATFORM_SECRET_KEY.trim()) {
    throw new Error(
      "PLATFORM_SECRET_KEY is required for production. Set it, then run `npm run start`.",
    );
  }
  return staticDirectory;
}

export function productionEnvironment(environment = process.env) {
  return { ...environment, NODE_ENV: "production" };
}

export function startProduction({ environment = process.env, root = repoRoot } = {}) {
  validateProductionPrerequisites(environment, root);
  const child = spawn(process.execPath, [resolve(root, "scripts/server-py.mjs")], {
    cwd: root,
    env: productionEnvironment(environment),
    stdio: "inherit",
  });

  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const forwardSignal = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  signals.forEach((signal) => process.once(signal, forwardSignal));

  child.once("error", (error) => {
    console.error(`Failed to start production server: ${error.message}`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    signals.forEach((item) => process.removeListener(item, forwardSignal));
    process.exitCode = signal ? 1 : code ?? 1;
  });
  return child;
}

function main() {
  try {
    startProduction();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
