import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as util from "node:util";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

export function resolveConfigurationFile(environment = process.env, root = repoRoot) {
  const configured = environment.AUTOFLOW_CONFIG_FILE;
  if (configured !== undefined) {
    if (typeof configured !== "string" || !configured.trim()) {
      throw new Error(
        "AUTOFLOW_CONFIG_FILE must be a non-blank path when it is set.",
      );
    }
    return { explicit: true, filePath: resolve(root, configured) };
  }
  return { explicit: false, filePath: resolve(root, ".env") };
}

export function getNativeParseEnv() {
  if (typeof util.parseEnv !== "function") {
    throw new Error(
      "Node.js >=20.12 is required to load production configuration files. Upgrade Node, then run `npm run start` again.",
    );
  }
  return util.parseEnv;
}

export function validateConfigurationFile(
  filePath,
  {
    metadata,
    userId = typeof process.getuid === "function" ? process.getuid() : undefined,
  } = {},
) {
  let inspectedMetadata = metadata;
  if (!inspectedMetadata) {
    try {
      inspectedMetadata = fs.lstatSync(filePath);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        return false;
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to inspect production configuration file ${filePath}: ${detail}`);
    }
  }

  if (inspectedMetadata.isSymbolicLink() || !inspectedMetadata.isFile()) {
    throw new Error(
      `Production configuration file ${filePath} must be a regular file, not a directory or symbolic link.`,
    );
  }
  if (userId !== undefined && inspectedMetadata.uid !== userId) {
    throw new Error(
      `Production configuration file ${filePath} must be owned by the current user.`,
    );
  }
  if (userId !== undefined && (inspectedMetadata.mode & 0o077) !== 0) {
    throw new Error(
      `Production configuration file ${filePath} is too permissive; run \`chmod 600 ${filePath}\` and try again.`,
    );
  }
  return true;
}

export function readConfigurationFile(
  configurationFile,
  parseEnv = getNativeParseEnv(),
) {
  const noFollow = process.platform === "linux" ? fs.constants.O_NOFOLLOW ?? 0 : 0;
  let descriptor;
  try {
    descriptor = fs.openSync(
      configurationFile.filePath,
      fs.constants.O_RDONLY | noFollow,
    );
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      if (configurationFile.explicit) {
        throw new Error(
          `Production configuration file ${configurationFile.filePath} was not found. Check AUTOFLOW_CONFIG_FILE and try again.`,
        );
      }
      return {};
    }
    if (error && typeof error === "object" && error.code === "ELOOP") {
      throw new Error(
        `Production configuration file ${configurationFile.filePath} must be a regular file, not a directory or symbolic link.`,
      );
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to open production configuration file ${configurationFile.filePath}: ${detail}. Check ownership and run \`chmod 600 ${configurationFile.filePath}\` before trying again.`,
    );
  }

  try {
    let metadata;
    try {
      metadata = fs.fstatSync(descriptor);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Unable to inspect production configuration file ${configurationFile.filePath}: ${detail}`,
      );
    }
    validateConfigurationFile(configurationFile.filePath, { metadata });

    let source;
    try {
      source = fs.readFileSync(descriptor, "utf8");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Unable to read production configuration file ${configurationFile.filePath}: ${detail}`,
      );
    }

    try {
      return parseEnv(source);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Unable to parse production configuration file ${configurationFile.filePath}: ${detail}`,
      );
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

export function resolveProductionEnvironment(
  environment = process.env,
  root = repoRoot,
) {
  const parseEnv = getNativeParseEnv();
  const configurationFile = resolveConfigurationFile(environment, root);
  const fileEnvironment = readConfigurationFile(configurationFile, parseEnv);
  const merged = { ...environment };
  for (const [key, value] of Object.entries(fileEnvironment)) {
    if (!hasOwn(merged, key)) merged[key] = value;
  }
  return productionEnvironment(merged);
}

export function getStaticDirectory(environment = process.env, root = repoRoot) {
  const configured = environment.AUTOFLOW_STATIC_DIRECTORY || "dist";
  return resolve(root, configured);
}

export function validateProductionPrerequisites(
  environment = process.env,
  root = repoRoot,
) {
  const staticDirectory = getStaticDirectory(environment, root);
  if (!fs.existsSync(resolve(staticDirectory, "index.html"))) {
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
  const resolvedEnvironment = resolveProductionEnvironment(environment, root);
  validateProductionPrerequisites(resolvedEnvironment, root);
  const child = spawn(process.execPath, [resolve(root, "scripts/server-py.mjs")], {
    cwd: root,
    env: resolvedEnvironment,
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
