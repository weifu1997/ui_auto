import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  getStaticDirectory,
  productionEnvironment,
  resolveProductionEnvironment,
  validateConfigurationFile,
  validateProductionPrerequisites,
} from "./start-production.mjs";

function withTemporaryProject(callback) {
  const root = mkdtempSync(join(tmpdir(), "autoflow-start-test-"));
  try {
    return callback(root);
  } finally {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  }
}

function writeProtectedFile(filePath, contents) {
  writeFileSync(filePath, contents, { mode: 0o600 });
  chmodSync(filePath, 0o600);
}

test("production start rejects a missing build before spawning the server", () => {
  withTemporaryProject((root) => {
    assert.throws(
      () => validateProductionPrerequisites({ PLATFORM_SECRET_KEY: "test-secret" }, root),
      /Run `npm run build` first/,
    );
  });
});

test("production start rejects a missing or blank platform secret", () => {
  withTemporaryProject((root) => {
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "index.html"), "<!doctype html>");
    assert.throws(
      () => validateProductionPrerequisites({}, root),
      /PLATFORM_SECRET_KEY is required/,
    );
    assert.throws(
      () => validateProductionPrerequisites({ PLATFORM_SECRET_KEY: "  " }, root),
      /PLATFORM_SECRET_KEY is required/,
    );
  });
});

test("production start accepts a readable non-blank PLATFORM_SECRET_KEY_FILE", () => {
  withTemporaryProject((root) => {
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "index.html"), "<!doctype html>");
    mkdirSync(join(root, "runtime"));
    writeFileSync(join(root, "runtime", "platform-secret.key"), "file-managed-secret\n");
    assert.equal(
      validateProductionPrerequisites(
        { PLATFORM_SECRET_KEY_FILE: join(root, "runtime", "platform-secret.key") },
        root,
      ),
      join(root, "dist"),
    );
  });
});

test("production start rejects an unreadable or blank PLATFORM_SECRET_KEY_FILE", () => {
  withTemporaryProject((root) => {
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "index.html"), "<!doctype html>");
    assert.throws(
      () =>
        validateProductionPrerequisites(
          { PLATFORM_SECRET_KEY_FILE: join(root, "runtime", "missing.key") },
          root,
        ),
      /PLATFORM_SECRET_KEY_FILE is not readable/,
    );
    mkdirSync(join(root, "runtime"));
    writeFileSync(join(root, "runtime", "platform-secret.key"), "   \n");
    assert.throws(
      () =>
        validateProductionPrerequisites(
          { PLATFORM_SECRET_KEY_FILE: join(root, "runtime", "platform-secret.key") },
          root,
        ),
      /PLATFORM_SECRET_KEY_FILE is blank/,
    );
  });
});

test("production start prefers PLATFORM_SECRET_KEY over PLATFORM_SECRET_KEY_FILE", () => {
  withTemporaryProject((root) => {
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "index.html"), "<!doctype html>");
    assert.equal(
      validateProductionPrerequisites(
        {
          PLATFORM_SECRET_KEY: "direct-secret",
          PLATFORM_SECRET_KEY_FILE: join(root, "runtime", "missing.key"),
        },
        root,
      ),
      join(root, "dist"),
    );
  });
});

test("production start uses the configured build directory and forces production mode", () => {
  withTemporaryProject((root) => {
    mkdirSync(join(root, "release"));
    writeFileSync(join(root, "release", "index.html"), "<!doctype html>");
    const environment = {
      AUTOFLOW_STATIC_DIRECTORY: "release",
      PLATFORM_SECRET_KEY: "test-secret",
      AUTOFLOW_LISTEN_HOST: "0.0.0.0",
      PORT: "9900",
    };
    assert.equal(getStaticDirectory(environment, root), join(root, "release"));
    assert.equal(validateProductionPrerequisites(environment, root), join(root, "release"));
    assert.deepEqual(productionEnvironment(environment), { ...environment, NODE_ENV: "production" });
  });
});

test("production start loads the protected default .env file", () => {
  withTemporaryProject((root) => {
    writeProtectedFile(
      join(root, ".env"),
      "# production secret\nPLATFORM_SECRET_KEY=from-file\nAUTOFLOW_STATIC_DIRECTORY=release\nNODE_ENV=development\n",
    );
    const environment = resolveProductionEnvironment({}, root);
    assert.equal(environment.PLATFORM_SECRET_KEY, "from-file");
    assert.equal(environment.AUTOFLOW_STATIC_DIRECTORY, "release");
    assert.equal(environment.NODE_ENV, "production");
    mkdirSync(join(root, "release"));
    writeFileSync(join(root, "release", "index.html"), "<!doctype html>");
    assert.equal(validateProductionPrerequisites(environment, root), join(root, "release"));
  });
});

test("production start accepts an explicit relative config path and dotenv syntax", () => {
  withTemporaryProject((root) => {
    mkdirSync(join(root, "config"));
    writeProtectedFile(
      join(root, "config", "production.env"),
      "PLATFORM_SECRET_KEY=\"quoted secret\" # inline comment\nAUTOFLOW_CORS_ORIGINS='https://example.test'\n",
    );
    const environment = resolveProductionEnvironment(
      { AUTOFLOW_CONFIG_FILE: "config/production.env" },
      root,
    );
    assert.equal(environment.PLATFORM_SECRET_KEY, "quoted secret");
    assert.equal(environment.AUTOFLOW_CORS_ORIGINS, "https://example.test");

    const absoluteEnvironment = resolveProductionEnvironment(
      { AUTOFLOW_CONFIG_FILE: join(root, "config", "production.env") },
      root,
    );
    assert.equal(absoluteEnvironment.PLATFORM_SECRET_KEY, "quoted secret");
  });
});

test("inherited environment values take precedence over config-file values", () => {
  withTemporaryProject((root) => {
    writeProtectedFile(
      join(root, ".env"),
      "PLATFORM_SECRET_KEY=from-file\nPORT=7000\nAUTOFLOW_CORS_ORIGINS=file-origin\n",
    );
    const environment = resolveProductionEnvironment(
      {
        PLATFORM_SECRET_KEY: "from-shell",
        PORT: "8000",
      },
      root,
    );
    assert.equal(environment.PLATFORM_SECRET_KEY, "from-shell");
    assert.equal(environment.PORT, "8000");
    assert.equal(environment.AUTOFLOW_CORS_ORIGINS, "file-origin");
  });
});

test("an inherited blank secret remains an explicit override", () => {
  withTemporaryProject((root) => {
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "index.html"), "<!doctype html>");
    writeProtectedFile(join(root, ".env"), "PLATFORM_SECRET_KEY=from-file\n");
    const environment = resolveProductionEnvironment(
      { PLATFORM_SECRET_KEY: "" },
      root,
    );
    assert.equal(environment.PLATFORM_SECRET_KEY, "");
    assert.throws(
      () => validateProductionPrerequisites(environment, root),
      /PLATFORM_SECRET_KEY is required/,
    );
  });
});

test("a missing default .env is optional for environment-only startup", () => {
  withTemporaryProject((root) => {
    const environment = resolveProductionEnvironment(
      { PLATFORM_SECRET_KEY: "from-shell" },
      root,
    );
    assert.equal(environment.PLATFORM_SECRET_KEY, "from-shell");
    assert.equal(environment.NODE_ENV, "production");
  });
});

test("an explicit missing or blank config path fails clearly", () => {
  withTemporaryProject((root) => {
    assert.throws(
      () => resolveProductionEnvironment({ AUTOFLOW_CONFIG_FILE: "missing.env" }, root),
      /production configuration file .* was not found.*AUTOFLOW_CONFIG_FILE/i,
    );
    assert.throws(
      () => resolveProductionEnvironment({ AUTOFLOW_CONFIG_FILE: "  " }, root),
      /AUTOFLOW_CONFIG_FILE must be a non-blank path/,
    );
  });
});

test("a config path must point to a regular non-symlink file", () => {
  withTemporaryProject((root) => {
    mkdirSync(join(root, "config"));
    assert.throws(
      () => resolveProductionEnvironment({ AUTOFLOW_CONFIG_FILE: "config" }, root),
      /must be a regular file/,
    );

    if (process.platform !== "win32") {
      writeProtectedFile(join(root, "real.env"), "PLATFORM_SECRET_KEY=from-file\n");
      symlinkSync(join(root, "real.env"), join(root, "linked.env"));
      assert.throws(
        () => resolveProductionEnvironment({ AUTOFLOW_CONFIG_FILE: "linked.env" }, root),
        /regular file.*symbolic link/,
      );
    }
  });
});

test("POSIX config files must be owned by the current user and mode 600", { skip: typeof process.getuid !== "function" }, () => {
  withTemporaryProject((root) => {
    const filePath = join(root, ".env");
    writeProtectedFile(filePath, "PLATFORM_SECRET_KEY=from-file\n");
    assert.throws(
      () => validateConfigurationFile(filePath, { userId: process.getuid() + 1 }),
      /must be owned by the current user/,
    );
    chmodSync(filePath, 0o644);
    assert.throws(
      () => resolveProductionEnvironment({}, root),
      /too permissive.*chmod 600/,
    );
  });
});
