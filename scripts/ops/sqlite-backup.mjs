import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, renameSync, rmSync } from "node:fs";

const [source, destination, required] = process.argv.slice(2);
if (!existsSync(source)) {
  if (required) throw new Error(`Required database missing: ${source}`);
  process.exit(0);
}
const database = new DatabaseSync(source);
const integrity = database.prepare("PRAGMA integrity_check").get();
if (integrity.integrity_check !== "ok") throw new Error(`Integrity check failed: ${integrity.integrity_check}`);
let checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
for (let attempt = 1; checkpoint.busy === 1 && attempt <= 3; attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
}
if (checkpoint.busy !== 0) throw new Error(`WAL checkpoint did not complete (busy=${checkpoint.busy}); backup aborted`);
const sourceStats = new Map();
for (const table of ["platform_users", "platform_runs"]) {
  const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (exists) sourceStats.set(table, database.prepare(`SELECT COUNT(*) AS count, MAX(created_at) AS maxCreatedAt FROM ${table}`).get());
}
database.close();
const temp = `${destination}.tmp`;
try {
  copyFileSync(source, temp);
  const copy = new DatabaseSync(temp, { readOnly: true });
  try {
    if (copy.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") throw new Error("Backup verification failed");
    for (const [table, expected] of sourceStats) {
      const actual = copy.prepare(`SELECT COUNT(*) AS count, MAX(created_at) AS maxCreatedAt FROM ${table}`).get();
      if (actual.count !== expected.count || actual.maxCreatedAt !== expected.maxCreatedAt) {
        throw new Error(`Backup row-count mismatch on ${table}: source ${expected.count} vs copy ${actual.count}`);
      }
    }
  } finally {
    copy.close();
  }
  renameSync(temp, destination);
} finally {
  if (existsSync(temp)) rmSync(temp);
}
