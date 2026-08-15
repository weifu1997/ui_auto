import { readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetsDir = join(repoRoot, "dist", "assets");
const limitKb = Number(process.env.BUNDLE_SIZE_LIMIT_KB ?? 500);
const failures = [];

if (!Number.isFinite(limitKb) || limitKb <= 0) {
  console.error("Invalid BUNDLE_SIZE_LIMIT_KB. Expected a positive number.");
  process.exit(1);
}

try {
  for (const file of readdirSync(assetsDir)) {
    if (!file.endsWith(".js")) continue;
    const sizeKb = statSync(join(assetsDir, file)).size / 1024;
    if (sizeKb > limitKb) {
      failures.push(`${file}: ${sizeKb.toFixed(2)} kB > ${limitKb} kB`);
    }
  }
} catch {
  console.error("dist/assets not found. Run `npm run build` first.");
  process.exit(1);
}

if (failures.length > 0) {
  console.error("Bundle size budget exceeded:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Bundle size check passed (limit ${limitKb} kB).`);
