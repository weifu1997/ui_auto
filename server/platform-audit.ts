import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export function createAuditWriter(database: DatabaseSync) {
  return (
    workspaceId: string,
    actor: { type: "user" | "agent" | "system"; id: string },
    action: string,
    target: { type: string; id: string },
    detail: Record<string, unknown> = {},
    projectId?: string,
  ) => {
    database.prepare(`INSERT INTO audit_events (id, workspace_id, project_id, actor_type, actor_id, action, target_type, target_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), workspaceId, projectId ?? null, actor.type, actor.id, action, target.type, target.id, JSON.stringify(detail), new Date().toISOString());
  };
}
