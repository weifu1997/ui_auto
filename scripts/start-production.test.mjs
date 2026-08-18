import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  getStaticDirectory,
  productionEnvironment,
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
