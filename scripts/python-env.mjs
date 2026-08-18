import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(scriptsDir, "..");

function venvPython(venvRoot) {
  return process.platform === "win32"
    ? join(venvRoot, "Scripts", "python.exe")
    : join(venvRoot, "bin", "python");
}

function venvPip(venvRoot) {
  return process.platform === "win32"
    ? join(venvRoot, "Scripts", "pip.exe")
    : join(venvRoot, "bin", "pip");
}

export function projectVenvs() {
  return [
    {
      root: join(repoRoot, "server-py", ".venv"),
      python: venvPython(join(repoRoot, "server-py", ".venv")),
      pip: venvPip(join(repoRoot, "server-py", ".venv")),
      label: "server-py/.venv",
    },
    {
      root: join(repoRoot, "server-py", ".venv-linux"),
      python: venvPython(join(repoRoot, "server-py", ".venv-linux")),
      pip: venvPip(join(repoRoot, "server-py", ".venv-linux")),
      label: "server-py/.venv-linux",
    },
    {
      root: join(repoRoot, "venv"),
      python: venvPython(join(repoRoot, "venv")),
      pip: venvPip(join(repoRoot, "venv")),
      label: "venv",
    },
  ];
}

export function isUsableVenv(venv) {
  return existsSync(venv.python) && existsSync(venv.pip);
}

export function resolvePython() {
  if (process.env.AUTOFLOW_PYTHON) {
    return process.env.AUTOFLOW_PYTHON;
  }

  for (const venv of projectVenvs()) {
    if (isUsableVenv(venv)) {
      return venv.python;
    }
  }
  return "python";
}

export function checkModule(python, moduleName) {
  return spawnSync(python, ["-c", `import ${moduleName}`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(resolvePython());
}
