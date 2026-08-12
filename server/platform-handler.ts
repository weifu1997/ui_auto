import type {PlatformServices} from "./platform";
import {PlatformError, asRecord, authorization, cleanProjectSlug, debugMaxDurationMs, digest, json, nextCronTime, now, parseJson, passwordHash, passwordMatches, platformArtifactDirectory, readBody, readJson, revisionNumber, safeArtifactName, sendJson, webhookMaxRuns, webhookSignatureMatches, webhookTimestampToleranceMs} from "./platform-core";
import {routeHandler} from "./http-utils";
import type {AgentRecord, AuthUser, Capability, DeliveryStatus, LocatorCandidate, NotificationChannelType, PlatformApi, RevisionStatus, Role, ValidatedNotificationTarget} from "./platform-core";
import {randomBytes, randomUUID} from "node:crypto";
import {createReadStream} from "node:fs";
import {mkdir, rm, writeFile} from "node:fs/promises";
import type {IncomingMessage} from "node:http";
import {join} from "node:path";
import type {Duplex} from "node:stream";
import {URL} from "node:url";
import {clearSessionCookie, setSessionCookie} from "./platform-auth";
import {publicResourceData as resourceData} from "./platform-resources";
import {rewriteTemplateReferences} from "./platform-templates";


const resourceCapabilities: Record<string, Capability> = {
  flows: "flow.edit",
  elements: "element.manage",
  variables: "variable.manage",
  environments: "environment.manage",
};

function assertSnapshotDepth(value: unknown, limit = 100, current = 0) {
  if (current > limit) throw new PlatformError(400, "SNAPSHOT_TOO_DEEP");
  if (Array.isArray(value)) {
    for (const item of value) assertSnapshotDepth(item, limit, current + 1);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) assertSnapshotDepth(item, limit, current + 1);
  }
}

export function createPlatformHandler(services: PlatformServices): PlatformApi {
  let lastMaintenanceAt = 0;
  const runMaintenance = () => {
    // expireDebugSessions 轻量且对空闲恢复时序敏感，每个请求保持执行。
    services.expireDebugSessions();
    const nowMs = Date.now();
    if (nowMs - lastMaintenanceAt < 2_000) return;
    lastMaintenanceAt = nowMs;
    services.recoverExpiredLeases();
    services.recoverStaleElementValidations();
    services.processDueSchedules();
  };
  const handle = routeHandler(async (request, response, url) => {
    if (!url.pathname.startsWith("/api/")) return false;
    runMaintenance();
    if (url.pathname === "/api/platform/health" && request.method === "GET") {
      const agents = services.database.prepare(`SELECT COUNT(*) AS count FROM agents WHERE status = 'online'`).get() as { count: number };
      sendJson(response, 200, { ok: true, service: "platform", onlineAgents: agents.count });
      return true;
    }

    const publicWebhook = url.pathname.match(/^\/api\/platform\/webhooks\/([^/]+)$/);
    if (publicWebhook && request.method === "POST") {
      const triggerId = decodeURIComponent(publicWebhook[1]);
      const timestamp = Array.isArray(request.headers["x-autoflow-timestamp"]) ? request.headers["x-autoflow-timestamp"][0] : request.headers["x-autoflow-timestamp"];
      const signature = Array.isArray(request.headers["x-autoflow-signature"]) ? request.headers["x-autoflow-signature"][0] : request.headers["x-autoflow-signature"];
      const deliveryId = Array.isArray(request.headers["x-autoflow-delivery-id"]) ? request.headers["x-autoflow-delivery-id"][0] : request.headers["x-autoflow-delivery-id"];
      if (!timestamp || !signature || !deliveryId || !/^\d{10,13}$/.test(timestamp) || deliveryId.length > 160) {
        throw new PlatformError(401, "WEBHOOK_SIGNATURE_REQUIRED");
      }
      const timestampMs = timestamp.length === 10 ? Number(timestamp) * 1000 : Number(timestamp);
      if (!Number.isSafeInteger(timestampMs) || Math.abs(Date.now() - timestampMs) > webhookTimestampToleranceMs) {
        throw new PlatformError(401, "WEBHOOK_TIMESTAMP_INVALID");
      }
      const body = await readBody(request, 1_000_000);
      const trigger = services.database.prepare(`SELECT id, project_id, revision_id, environment_id, dataset_version_id, enabled, signing_secret_iv, signing_secret_tag, signing_secret_ciphertext FROM webhook_triggers WHERE id = ? AND archived_at IS NULL`).get(triggerId) as { id: string; project_id: string; revision_id: string; environment_id: string; dataset_version_id: string | null; enabled: number; signing_secret_iv: string | null; signing_secret_tag: string | null; signing_secret_ciphertext: string | null } | undefined;
      if (!trigger || !trigger.enabled) throw new PlatformError(404, "WEBHOOK_TRIGGER_NOT_FOUND");
      if (!trigger.signing_secret_iv || !trigger.signing_secret_tag || !trigger.signing_secret_ciphertext) throw new PlatformError(409, "WEBHOOK_SIGNING_SECRET_REQUIRED");
      const secret = services.decrypt({ iv: trigger.signing_secret_iv, tag: trigger.signing_secret_tag, ciphertext: trigger.signing_secret_ciphertext });
      if (!webhookSignatureMatches(secret, timestamp, body, signature)) throw new PlatformError(401, "WEBHOOK_SIGNATURE_INVALID");
      if (!services.allowWebhookRequest(trigger.id)) throw new PlatformError(429, "WEBHOOK_RATE_LIMITED");
      const delivery = services.database.prepare(`INSERT OR IGNORE INTO webhook_deliveries (trigger_id, delivery_id, received_at) VALUES (?, ?, ?)`).run(trigger.id, deliveryId, now());
      if (delivery.changes === 0) {
        sendJson(response, 202, { accepted: true, duplicate: true, runIds: [] });
        return true;
      }
      let queued: ReturnType<PlatformServices["queuePublishedRuns"]>;
      try {
        queued = services.queuePublishedRuns({ projectId: trigger.project_id, revisionId: trigger.revision_id, environmentId: trigger.environment_id, datasetVersionId: trigger.dataset_version_id ?? undefined, createdBy: `webhook:${trigger.id}`, source: "webhook", maxRuns: webhookMaxRuns });
      } catch (error) {
        services.database.prepare(`DELETE FROM webhook_deliveries WHERE trigger_id = ? AND delivery_id = ?`).run(trigger.id, deliveryId);
        throw error;
      }
      services.database.prepare(`UPDATE webhook_triggers SET last_triggered_at = ? WHERE id = ?`).run(now(), trigger.id);
        const project = services.projectFor(trigger.project_id);
        services.audit(project.workspace_id, { type: "system", id: `webhook:${trigger.id}` }, "webhook.triggered", { type: "webhook_trigger", id: trigger.id }, { runIds: queued.runIds }, trigger.project_id);
        sendJson(response, 202, { accepted: true, runIds: queued.runIds });
        return true;
      }

      if (url.pathname === "/api/auth/register" && request.method === "POST") {
        const body = await readJson<{ email?: string; name?: string; password?: string; invitationToken?: string }>(request);
        const email = body.email?.trim().toLowerCase();
        const password = body.password?.trim();
        if (!email || !email.includes("@") || !password || password.length < 8 || password.length > 1024) throw new PlatformError(400, "REGISTER_INPUT_INVALID");
        let user = services.database.prepare(`SELECT id, email, name FROM platform_users WHERE email = ?`).get(email) as AuthUser | undefined;
        if (user) {
          const existingCredential = services.database.prepare(`SELECT user_id FROM platform_user_credentials WHERE user_id = ?`).get(user.id) as { user_id: string } | undefined;
          if (existingCredential) throw new PlatformError(409, "EMAIL_ALREADY_REGISTERED");
          const invitationToken = body.invitationToken?.trim();
          if (!invitationToken) throw new PlatformError(409, "INVITATION_VERIFICATION_REQUIRED");
          const invitation = services.database.prepare(`
            SELECT id FROM workspace_invitations
            WHERE user_id = ? AND token_hash = ? AND accepted_at IS NULL AND expires_at > ?
          `).get(user.id, digest(invitationToken), now()) as { id: string } | undefined;
          if (!invitation) throw new PlatformError(409, "INVITATION_TOKEN_INVALID");
          const created = now();
          services.database.prepare(`INSERT INTO platform_user_credentials (user_id, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)`)
            .run(user.id, passwordHash(password), created, created);
          services.database.prepare(`UPDATE workspace_invitations SET accepted_at = ? WHERE id = ?`).run(created, invitation.id);
        } else {
          user = { id: randomUUID(), email, name: body.name?.trim().slice(0, 100) || email.split("@")[0] };
          services.database.exec("BEGIN IMMEDIATE");
          try {
            services.database.prepare(`INSERT INTO platform_users (id, email, name, created_at) VALUES (?, ?, ?, ?)`).run(user.id, user.email, user.name, now());
            const created = now();
            services.database.prepare(`INSERT INTO platform_user_credentials (user_id, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)`)
              .run(user.id, passwordHash(password), created, created);
            services.createWorkspace(user, `${user.name}'s workspace`);
            services.database.exec("COMMIT");
          } catch (error) {
            services.database.exec("ROLLBACK");
            throw error;
          }
        }
        const session = services.createAuthSession(user);
        setSessionCookie(response, session.token, session.expiresAt);
        sendJson(response, 201, session);
        return true;
      }

      if (url.pathname === "/api/auth/login" && request.method === "POST") {
        const body = await readJson<{ email?: string; password?: string }>(request);
        const email = body.email?.trim().toLowerCase();
        const password = body.password?.trim();
        if (!email || !email.includes("@") || !password) throw new PlatformError(400, "LOGIN_INPUT_INVALID");
        const user = services.database.prepare(`SELECT id, email, name FROM platform_users WHERE email = ? AND enabled = 1`).get(email) as AuthUser | undefined;
        const credential = user ? services.database.prepare(`SELECT password_hash FROM platform_user_credentials WHERE user_id = ?`).get(user.id) as { password_hash: string } | undefined : undefined;
        if (!user || !credential || !passwordMatches(password, credential.password_hash)) throw new PlatformError(401, "LOGIN_INVALID");
        const session = services.createAuthSession(user);
        setSessionCookie(response, session.token, session.expiresAt);
        sendJson(response, 200, session);
        return true;
      }

      if (url.pathname === "/api/auth/logout" && request.method === "POST") {
        const token = authorization(request);
        if (token) services.database.prepare("DELETE FROM platform_sessions WHERE token_hash = ?").run(digest(token));
        clearSessionCookie(response);
        sendJson(response, 200, { loggedOut: true });
        return true;
      }

      if (url.pathname === "/api/auth/session" && request.method === "GET") {
        const user = services.sessionUser(request);
        const workspaces = services.database
          .prepare(`SELECT w.id, w.name, w.created_at, m.role FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id WHERE m.user_id = ? ORDER BY w.created_at ASC`)
          .all(user.id) as Array<{ id: string; name: string; created_at: string; role: Role }>;
        sendJson(response, 200, { user, workspaces: workspaces.map((item) => ({ id: item.id, name: item.name, createdAt: item.created_at, role: item.role })) });
        return true;
      }

      if (url.pathname === "/api/workspaces" && request.method === "GET") {
        const user = services.sessionUser(request);
        const workspaces = services.database
          .prepare(`SELECT w.id, w.name, w.created_at, m.role FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id WHERE m.user_id = ? ORDER BY w.created_at ASC`)
          .all(user.id) as Array<{ id: string; name: string; created_at: string; role: Role }>;
        sendJson(response, 200, { workspaces: workspaces.map((item) => ({ id: item.id, name: item.name, createdAt: item.created_at, role: item.role })) });
        return true;
      }

      if (url.pathname === "/api/workspaces" && request.method === "POST") {
        const user = services.sessionUser(request);
        const body = await readJson<{ name?: string }>(request);
        if (!body.name?.trim()) throw new PlatformError(400, "WORKSPACE_NAME_REQUIRED");
        sendJson(response, 201, { workspace: services.createWorkspace(user, body.name) });
        return true;
      }

      const workspaceMembers = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/members$/);
      if (workspaceMembers) {
        const user = services.sessionUser(request);
        const workspaceId = decodeURIComponent(workspaceMembers[1]);
        const actorRole = services.requireWorkspaceRole(workspaceId, user.id, request.method !== "GET");
        if (request.method === "GET") {
          const members = services.database.prepare(
            `SELECT u.id, u.email, u.name, u.enabled, CASE WHEN c.user_id IS NULL THEN 0 ELSE 1 END credential_configured, m.role FROM workspace_members m
             JOIN platform_users u ON u.id = m.user_id
             LEFT JOIN platform_user_credentials c ON c.user_id = u.id
             WHERE m.workspace_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'editor' THEN 2 ELSE 3 END, u.email`,
          ).all(workspaceId) as Array<{ id: string; email: string; name: string; enabled: number; credential_configured: number; role: Role }>;
          sendJson(response, 200, { members: members.map((member) => ({ ...member, enabled: Boolean(member.enabled), credentialConfigured: Boolean(member.credential_configured), credential_configured: undefined })) });
          return true;
        }
        if (request.method === "POST") {
          const body = await readJson<{ email?: string; name?: string; role?: Role }>(request);
          const email = body.email?.trim().toLowerCase();
          const role = services.normalizeRole(body.role ?? "viewer");
          if (!email || !email.includes("@")) throw new PlatformError(400, "WORKSPACE_MEMBER_EMAIL_INVALID");
          if (role === "owner" && actorRole !== "owner") throw new PlatformError(403, "WORKSPACE_OWNER_REQUIRED");
          let member = services.database.prepare(`SELECT id, email, name FROM platform_users WHERE email = ?`).get(email) as AuthUser | undefined;
          if (!member) {
            member = { id: randomUUID(), email, name: body.name?.trim().slice(0, 100) || email.split("@")[0] };
            services.database.prepare(`INSERT INTO platform_users (id, email, name, created_at) VALUES (?, ?, ?, ?)`).run(member.id, member.email, member.name, now());
          }
          const existing = services.database.prepare(`SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`).get(workspaceId, member.id) as { role: Role } | undefined;
          if (existing?.role === "owner" && actorRole !== "owner") throw new PlatformError(403, "WORKSPACE_OWNER_REQUIRED");
          services.database.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role`).run(workspaceId, member.id, role);
          const pendingInvitation = services.database.prepare(`SELECT user_id FROM platform_user_credentials WHERE user_id = ?`).get(member.id) as { user_id: string } | undefined;
          const invitation = pendingInvitation ? undefined : services.createWorkspaceInvitation(workspaceId, member.id, user.id);
          services.audit(workspaceId, { type: "user", id: user.id }, existing ? "workspace_member.role_changed" : "workspace_member.added", { type: "member", id: member.id }, { email, role });
          sendJson(response, existing ? 200 : 201, { member: { ...member, role }, invitationToken: invitation?.token, invitationExpiresAt: invitation?.expiresAt });
          return true;
        }
      }

      const workspaceMemberAccount = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/members\/([^/]+)\/(account|reset-password)$/);
      if (workspaceMemberAccount && (request.method === "PATCH" || request.method === "POST")) {
        const user = services.sessionUser(request);
        const workspaceId = decodeURIComponent(workspaceMemberAccount[1]);
        const memberId = decodeURIComponent(workspaceMemberAccount[2]);
        const action = workspaceMemberAccount[3];
        services.requireWorkspaceRole(workspaceId, user.id, true);
        const member = services.database.prepare("SELECT u.id, u.enabled, m.role FROM platform_users u JOIN workspace_members m ON m.user_id = u.id WHERE u.id = ? AND m.workspace_id = ?")
          .get(memberId, workspaceId) as { id: string; enabled: number; role: Role } | undefined;
        if (!member) throw new PlatformError(404, "WORKSPACE_MEMBER_NOT_FOUND");
        if (action === "account" && request.method === "PATCH") {
          const body = await readJson<{ enabled?: boolean }>(request);
          if (typeof body.enabled !== "boolean") throw new PlatformError(400, "ACCOUNT_STATUS_REQUIRED");
          if (!body.enabled) {
            const soleOwner = services.database.prepare(`
              SELECT m.workspace_id FROM workspace_members m
              WHERE m.user_id = ? AND m.role = 'owner'
                AND (SELECT COUNT(*) FROM workspace_members owners WHERE owners.workspace_id = m.workspace_id AND owners.role = 'owner') <= 1
              LIMIT 1
            `).get(memberId) as { workspace_id: string } | undefined;
            if (soleOwner) throw new PlatformError(409, "LAST_WORKSPACE_OWNER_REQUIRED");
          }
          services.database.prepare("UPDATE platform_users SET enabled = ? WHERE id = ?").run(body.enabled ? 1 : 0, memberId);
          if (!body.enabled) services.database.prepare("DELETE FROM platform_sessions WHERE user_id = ?").run(memberId);
          services.audit(workspaceId, { type: "user", id: user.id }, body.enabled ? "account.enabled" : "account.disabled", { type: "user", id: memberId });
          sendJson(response, 200, { memberId, enabled: body.enabled });
          return true;
        }
        if (action === "reset-password" && request.method === "POST") {
          const body = await readJson<{ password?: string }>(request);
          const password = body.password?.trim() ?? "";
          if (password.length < 8) throw new PlatformError(400, "PASSWORD_TOO_SHORT");
          const timestamp = now();
          services.database.prepare(`INSERT INTO platform_user_credentials (user_id, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET password_hash = excluded.password_hash, updated_at = excluded.updated_at`)
            .run(memberId, passwordHash(password), timestamp, timestamp);
          services.database.prepare("DELETE FROM platform_sessions WHERE user_id = ?").run(memberId);
          services.audit(workspaceId, { type: "user", id: user.id }, "account.password_reset", { type: "user", id: memberId });
          sendJson(response, 200, { memberId, passwordReset: true });
          return true;
        }
      }

      const workspaceMember = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/members\/([^/]+)$/);
      if (workspaceMember && (request.method === "PATCH" || request.method === "DELETE")) {
        const user = services.sessionUser(request);
        const workspaceId = decodeURIComponent(workspaceMember[1]);
        const memberId = decodeURIComponent(workspaceMember[2]);
        const actorRole = services.requireWorkspaceRole(workspaceId, user.id, true);
        const member = services.database.prepare(`SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`).get(workspaceId, memberId) as { role: Role } | undefined;
        if (!member) throw new PlatformError(404, "WORKSPACE_MEMBER_NOT_FOUND");
        if (member.role === "owner" && actorRole !== "owner") throw new PlatformError(403, "WORKSPACE_OWNER_REQUIRED");
        if (request.method === "PATCH") {
          const body = await readJson<{ role?: Role }>(request);
          const role = services.normalizeRole(body.role);
          if (role === "owner" && actorRole !== "owner") throw new PlatformError(403, "WORKSPACE_OWNER_REQUIRED");
          if (member.role === "owner" && role !== "owner") {
            const owners = services.database.prepare(`SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id = ? AND role = 'owner'`).get(workspaceId) as { count: number };
            if (owners.count <= 1) throw new PlatformError(409, "WORKSPACE_OWNER_REQUIRED");
          }
          services.database.prepare(`UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?`).run(role, workspaceId, memberId);
          services.audit(workspaceId, { type: "user", id: user.id }, "workspace_member.role_changed", { type: "member", id: memberId }, { role });
          sendJson(response, 200, { memberId, role });
          return true;
        }
        if (member.role === "owner") {
          const owners = services.database.prepare(`SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id = ? AND role = 'owner'`).get(workspaceId) as { count: number };
          if (owners.count <= 1) throw new PlatformError(409, "WORKSPACE_OWNER_REQUIRED");
        }
        services.database.prepare(`DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?`).run(workspaceId, memberId);
        services.audit(workspaceId, { type: "user", id: user.id }, "workspace_member.removed", { type: "member", id: memberId });
        sendJson(response, 200, { memberId, removed: true });
        return true;
      }

      const workspaceProjects = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/projects$/);
      if (workspaceProjects) {
        const user = services.sessionUser(request);
        const workspaceId = decodeURIComponent(workspaceProjects[1]);
        if (request.method === "GET") {
          services.requireWorkspaceRole(workspaceId, user.id);
          const archivedOnly = url.searchParams.get("archived") === "1";
          const projects = services.database
            .prepare(`SELECT id, workspace_id, source_project_id, slug, name, description, archived_at, created_at, updated_at FROM platform_projects WHERE workspace_id = ? AND ${archivedOnly ? "archived_at IS NOT NULL" : "archived_at IS NULL"} ORDER BY updated_at DESC`)
            .all(workspaceId) as Array<{ id: string; workspace_id: string; source_project_id: string | null; slug: string; name: string; description: string; archived_at: string | null; created_at: string; updated_at: string }>;
          sendJson(response, 200, { projects: projects.map(services.projectResponse) });
          return true;
        }
        if (request.method === "POST") {
          services.requireWorkspaceRole(workspaceId, user.id, true);
          const body = await readJson<{ name?: string; description?: string; slug?: string }>(request);
          if (!body.name?.trim()) throw new PlatformError(400, "PROJECT_NAME_REQUIRED");
          const project = {
            id: randomUUID(),
            workspaceId,
            slug: cleanProjectSlug(body.slug ?? body.name),
            name: body.name.trim().slice(0, 160),
            description: body.description?.trim().slice(0, 1000) ?? "",
            createdAt: now(),
          };
          try {
            services.database.prepare(`INSERT INTO platform_projects (id, workspace_id, slug, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
              .run(project.id, project.workspaceId, project.slug, project.name, project.description, project.createdAt, project.createdAt);
          } catch {
            throw new PlatformError(409, "PROJECT_SLUG_EXISTS");
          }
          services.putDocument(project.id, {});
          services.audit(workspaceId, { type: "user", id: user.id }, "project.created", { type: "project", id: project.id }, { name: project.name }, project.id);
          sendJson(response, 201, { project });
          return true;
        }
      }

      const importRoute = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/imports\/local-storage$/);
      if (importRoute && request.method === "POST") {
        const user = services.sessionUser(request);
        const workspaceId = decodeURIComponent(importRoute[1]);
        services.requireWorkspaceRole(workspaceId, user.id, true);
        const body = await readJson<{ sourceId?: string; data?: Record<string, unknown> }>(request, 5_000_000);
        const sourceId = body.sourceId?.trim();
        if (!sourceId) throw new PlatformError(400, "IMPORT_SOURCE_ID_REQUIRED");
        const existing = services.database.prepare(`SELECT result FROM platform_imports WHERE workspace_id = ? AND source_id = ?`).get(workspaceId, sourceId) as { result: string } | undefined;
        const existingProjects = existing ? parseJson<{ projects?: Array<{ sourceProjectId: string; projectId: string }> }>(existing.result, {}) : {};
        const existingMap = new Map((existingProjects.projects ?? []).map((item) => [item.sourceProjectId, item.projectId]));
        const source = asRecord(body.data);
        const projects = Array.isArray(source.projects) ? source.projects.map(asRecord) : [];
        const importedProjects: Array<{ sourceProjectId: string; projectId: string }> = [];
        let createdProjects = 0;
        services.database.exec("BEGIN IMMEDIATE");
        try {
          for (const sourceProject of projects) {
            const name = typeof sourceProject.name === "string" ? sourceProject.name.trim() : "";
            const sourceProjectId = typeof sourceProject.id === "string" ? sourceProject.id : randomUUID();
            if (!name) continue;
            let projectId = existingMap.get(sourceProjectId);
            if (projectId) {
              const current = services.database.prepare(`SELECT id FROM platform_projects WHERE id = ? AND workspace_id = ?`).get(projectId, workspaceId) as { id: string } | undefined;
              if (!current) projectId = undefined;
            }
            if (!projectId) {
              const existingSource = services.database
                .prepare(`SELECT id FROM platform_projects WHERE workspace_id = ? AND source_project_id = ?`)
                .get(workspaceId, sourceProjectId) as { id: string } | undefined;
              projectId = existingSource?.id;
            }
            if (!projectId) {
              projectId = randomUUID();
              let slug = cleanProjectSlug(`${name}-${sourceProjectId.slice(0, 6)}`);
              let suffix = 2;
              while (services.database.prepare(`SELECT id FROM platform_projects WHERE workspace_id = ? AND slug = ?`).get(workspaceId, slug)) {
                slug = `${cleanProjectSlug(name)}-${suffix++}`;
              }
              services.database.prepare(`INSERT INTO platform_projects (id, workspace_id, source_project_id, slug, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(projectId, workspaceId, sourceProjectId, slug, name.slice(0, 160), typeof sourceProject.description === "string" ? sourceProject.description.slice(0, 1000) : "", now(), now());
              createdProjects += 1;
            } else {
              services.database.prepare(`UPDATE platform_projects SET source_project_id = COALESCE(source_project_id, ?), archived_at = NULL, updated_at = ? WHERE id = ? AND workspace_id = ?`)
                .run(sourceProjectId, now(), projectId, workspaceId);
            }
            const data = {
              sourceProjectId,
              flows: asRecord(source.flowsByProject)[sourceProjectId] ?? [],
              elements: asRecord(source.elementsByProject)[sourceProjectId] ?? [],
              variables: asRecord(source.variablesByProject)[sourceProjectId] ?? [],
              environments: asRecord(source.environmentsByProject)[sourceProjectId] ?? [],
              activeEnvironmentId: asRecord(source.activeEnvironmentByProject)[sourceProjectId] ?? "",
              members: asRecord(source.membersByProject)[sourceProjectId] ?? [],
            };
            const document = services.documentFor(projectId);
            if (document.version === 0) {
              services.putDocument(projectId, data);
            } else if (typeof document.data.sourceProjectId !== "string") {
              services.putDocument(projectId, { ...document.data, sourceProjectId }, document.version);
            }
            importedProjects.push({ sourceProjectId, projectId });
          }
          const result = { projects: importedProjects };
          services.database.prepare(`INSERT INTO platform_imports (id, workspace_id, source_id, imported_at, result) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(workspace_id, source_id) DO UPDATE SET imported_at = excluded.imported_at, result = excluded.result`)
            .run(randomUUID(), workspaceId, sourceId, now(), json(result));
          services.database.exec("COMMIT");
          services.audit(workspaceId, { type: "user", id: user.id }, "workspace.local_storage_imported", { type: "import", id: sourceId }, { count: importedProjects.length });
          sendJson(response, createdProjects > 0 ? 201 : 200, { imported: createdProjects > 0, ...result });
          return true;
        } catch (error) {
          services.database.exec("ROLLBACK");
          throw error;
        }
      }

      const projectBase = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)$/);
      if (projectBase) {
        const user = services.sessionUser(request);
        const projectId = decodeURIComponent(projectBase[1]);
        const { project } = request.method === "GET" ? services.requireProjectRole(projectId, user.id) : services.requireProjectCapability(projectId, user.id, "project.edit");
        if (request.method === "GET") {
          sendJson(response, 200, { project: services.projectResponse(project) });
          return true;
        }
        if (request.method === "PATCH") {
          const body = await readJson<{ name?: string; description?: string; archived?: boolean }>(request);
          const name = body.name?.trim().slice(0, 160) || project.name;
          const description = body.description === undefined ? project.description : body.description.trim().slice(0, 1000);
          const archivedAt = body.archived === true ? now() : body.archived === false ? null : project.archived_at;
          services.database.prepare(`UPDATE platform_projects SET name = ?, description = ?, archived_at = ?, updated_at = ? WHERE id = ?`).run(name, description, archivedAt, now(), projectId);
          services.audit(project.workspace_id, { type: "user", id: user.id }, "project.updated", { type: "project", id: projectId }, { archived: body.archived }, projectId);
          sendJson(response, 200, { project: services.projectResponse(services.projectFor(projectId)) });
          return true;
        }
      }

      const projectDocument = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/document$/);
      if (projectDocument) {
        const user = services.sessionUser(request);
        const projectId = decodeURIComponent(projectDocument[1]);
        const { project } = request.method === "GET" ? services.requireProjectRole(projectId, user.id) : services.requireProjectCapability(projectId, user.id, "dataset.manage");
        if (request.method === "GET") {
          sendJson(response, 200, services.documentFor(projectId));
          return true;
        }
        if (request.method === "PUT") {
          const body = await readJson<{ data?: Record<string, unknown>; expectedVersion?: number }>(request, 5_000_000);
          if (!body.data) throw new PlatformError(400, "DOCUMENT_REQUIRED");
          for (const [key, capability] of Object.entries(resourceCapabilities)) {
            if (key in body.data) services.requireProjectCapability(projectId, user.id, capability);
          }
          const result = services.putDocument(projectId, asRecord(body.data), body.expectedVersion);
          services.database.prepare(`UPDATE platform_projects SET updated_at = ? WHERE id = ?`).run(now(), projectId);
          services.audit(project.workspace_id, { type: "user", id: user.id }, "project.document_saved", { type: "project", id: projectId }, { version: result.version }, projectId);
          sendJson(response, 200, result);
          return true;
        }
      }

      if (url.pathname === "/api/platform/templates") {
        const user = services.sessionUser(request);
        const workspaceId = url.searchParams.get("workspaceId") ?? "";
        services.requireWorkspaceRole(workspaceId, user.id, request.method === "POST");
        if (request.method === "GET") {
          const search = `%${(url.searchParams.get("q") ?? "").slice(0, 100)}%`;
          const category = url.searchParams.get("category");
          const rows = services.database.prepare(`SELECT t.id, t.name, t.description, t.category, t.source_project_id, t.source_revision_id, t.created_by, t.created_at, t.updated_at, CASE WHEN f.user_id IS NULL THEN 0 ELSE 1 END favorite FROM internal_templates t LEFT JOIN template_favorites f ON f.template_id = t.id AND f.user_id = ? WHERE t.workspace_id = ? AND t.deleted_at IS NULL AND (t.name LIKE ? OR t.description LIKE ?) AND (? IS NULL OR t.category = ?) ORDER BY favorite DESC, t.updated_at DESC`)
            .all(user.id, workspaceId, search, search, category, category) as Array<Record<string, string | number>>;
          sendJson(response, 200, { templates: rows.map((row) => ({ id: row.id, name: row.name, description: row.description, category: row.category, sourceProjectId: row.source_project_id, sourceRevisionId: row.source_revision_id, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at, favorite: Boolean(row.favorite) })) });
          return true;
        }
        if (request.method === "POST") {
          const body = await readJson<{ projectId?: string; revisionId?: string; name?: string; description?: string; category?: string }>(request);
          const projectId = body.projectId ?? "";
          const revisionId = body.revisionId ?? "";
          const { project } = services.requireProjectCapability(projectId, user.id, "release.publish");
          if (project.workspace_id !== workspaceId || !body.name?.trim()) throw new PlatformError(400, "TEMPLATE_INPUT_INVALID");
          const revision = services.database.prepare("SELECT id, status, flow_snapshot, environment_snapshot, element_snapshot FROM flow_revisions WHERE id = ? AND project_id = ?").get(revisionId, projectId) as { id: string; status: RevisionStatus; flow_snapshot: string; environment_snapshot: string; element_snapshot: string } | undefined;
          if (!revision || revision.status !== "published") throw new PlatformError(409, "PUBLISHED_REVISION_REQUIRED");
          const variables = services.database.prepare("SELECT data FROM project_resources WHERE project_id = ? AND resource_type = 'variables' AND archived_at IS NULL").all(projectId) as Array<{ data: string }>;
          const snapshot = {
            flow: parseJson(revision.flow_snapshot, {}),
            environments: [parseJson(revision.environment_snapshot, {})],
            elements: parseJson(revision.element_snapshot, []),
            variables: variables.map((row) => resourceData(parseJson(row.data, {}))),
          };
          const template = { id: randomUUID(), createdAt: now() };
          services.database.prepare("INSERT INTO internal_templates (id, workspace_id, source_project_id, source_revision_id, name, description, category, snapshot, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .run(template.id, workspaceId, projectId, revision.id, body.name.trim().slice(0, 160), body.description?.trim().slice(0, 1000) ?? "", body.category?.trim().slice(0, 80) || "通用", json(snapshot), user.id, template.createdAt, template.createdAt);
          services.audit(workspaceId, { type: "user", id: user.id }, "template.published", { type: "template", id: template.id }, { sourceRevisionId: revision.id }, projectId);
          sendJson(response, 201, { template: { id: template.id, name: body.name.trim(), description: body.description ?? "", category: body.category || "通用", favorite: false, createdAt: template.createdAt, updatedAt: template.createdAt } });
          return true;
        }
      }

      const templateRoute = url.pathname.match(/^\/api\/platform\/templates\/([^/]+)(?:\/(favorite|apply))?$/);
      if (templateRoute) {
        const user = services.sessionUser(request);
        const templateId = decodeURIComponent(templateRoute[1]);
        const action = templateRoute[2];
        const template = services.database.prepare("SELECT * FROM internal_templates WHERE id = ? AND deleted_at IS NULL").get(templateId) as { id: string; workspace_id: string; name: string; description: string; category: string; snapshot: string; created_by: string; source_project_id: string; source_revision_id: string; created_at: string; updated_at: string } | undefined;
        if (!template) throw new PlatformError(404, "TEMPLATE_NOT_FOUND");
        services.requireWorkspaceRole(template.workspace_id, user.id);
        if (!action && request.method === "GET") {
          sendJson(response, 200, { template: { id: template.id, name: template.name, description: template.description, category: template.category, snapshot: parseJson(template.snapshot, {}), sourceProjectId: template.source_project_id, sourceRevisionId: template.source_revision_id, createdBy: template.created_by, createdAt: template.created_at, updatedAt: template.updated_at } });
          return true;
        }
        if (!action && request.method === "PATCH") {
          if (template.created_by !== user.id) services.requireWorkspaceRole(template.workspace_id, user.id, true);
          const body = await readJson<{ name?: string; description?: string; category?: string }>(request);
          const name = body.name?.trim().slice(0, 160);
          if (!name) throw new PlatformError(400, "TEMPLATE_NAME_REQUIRED");
          const description = body.description?.trim().slice(0, 1_000) ?? "";
          const category = body.category?.trim().slice(0, 80) || "通用";
          const updatedAt = now();
          services.database.prepare("UPDATE internal_templates SET name = ?, description = ?, category = ?, updated_at = ? WHERE id = ?")
            .run(name, description, category, updatedAt, template.id);
          services.audit(template.workspace_id, { type: "user", id: user.id }, "template.updated", { type: "template", id: template.id }, { name, category });
          sendJson(response, 200, { template: { id: template.id, name, description, category, sourceProjectId: template.source_project_id, sourceRevisionId: template.source_revision_id, createdBy: template.created_by, createdAt: template.created_at, updatedAt } });
          return true;
        }
        if (action === "favorite" && (request.method === "POST" || request.method === "DELETE")) {
          if (request.method === "POST") services.database.prepare("INSERT OR IGNORE INTO template_favorites (template_id, user_id, created_at) VALUES (?, ?, ?)").run(template.id, user.id, now());
          else services.database.prepare("DELETE FROM template_favorites WHERE template_id = ? AND user_id = ?").run(template.id, user.id);
          sendJson(response, 200, { templateId, favorite: request.method === "POST" });
          return true;
        }
        if (action === "apply" && request.method === "POST") {
          const body = await readJson<{ projectId?: string }>(request);
          const projectId = body.projectId ?? "";
          const { project } = services.requireProjectCapability(projectId, user.id, "flow.edit");
          if (project.workspace_id !== template.workspace_id) throw new PlatformError(403, "TEMPLATE_WORKSPACE_MISMATCH");
          const snapshot = parseJson<Record<string, unknown>>(template.snapshot, {});
          const collections = { flows: [asRecord(snapshot.flow)], elements: Array.isArray(snapshot.elements) ? snapshot.elements.map(asRecord) : [], variables: Array.isArray(snapshot.variables) ? snapshot.variables.map(asRecord) : [], environments: Array.isArray(snapshot.environments) ? snapshot.environments.map(asRecord) : [] };
          const ids = new Map<string, string>();
          for (const resources of Object.values(collections)) for (const resource of resources) if (typeof resource.id === "string") ids.set(resource.id, randomUUID());
          const created: Record<string, string[]> = {};
          services.database.exec("BEGIN IMMEDIATE");
          try {
            for (const [type, resources] of Object.entries(collections)) {
              created[type] = [];
              for (const source of resources) {
                const oldId = typeof source.id === "string" ? source.id : randomUUID();
                const id = ids.get(oldId) ?? randomUUID();
                const rewritten = resourceData(rewriteTemplateReferences({ ...source, id }, ids));
                services.database.prepare("INSERT INTO project_resources (project_id, resource_type, resource_id, data, version, updated_at, updated_by) VALUES (?, ?, ?, ?, 1, ?, ?)").run(projectId, type, id, json(rewritten), now(), user.id);
                created[type].push(id);
              }
            }
            services.database.exec("COMMIT");
          } catch (error) {
            services.database.exec("ROLLBACK");
            throw error;
          }
          services.audit(template.workspace_id, { type: "user", id: user.id }, "template.applied", { type: "template", id: template.id }, { targetProjectId: projectId, created }, projectId);
          sendJson(response, 201, { templateId, projectId, created });
          return true;
        }
        if (!action && request.method === "DELETE") {
          if (template.created_by !== user.id) services.requireWorkspaceRole(template.workspace_id, user.id, true);
          services.database.prepare("UPDATE internal_templates SET deleted_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), template.id);
          services.audit(template.workspace_id, { type: "user", id: user.id }, "template.deleted", { type: "template", id: template.id });
          sendJson(response, 200, { templateId, deleted: true });
          return true;
        }
      }

      const resourceCollection = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/resources\/(flows|elements|variables|environments)$/);
      if (resourceCollection) {
        const user = services.sessionUser(request);
        const projectId = decodeURIComponent(resourceCollection[1]);
        const resourceType = resourceCollection[2];
        const capability = resourceCapabilities[resourceType];
        const { project } = request.method === "GET"
          ? services.requireProjectRole(projectId, user.id)
          : services.requireProjectCapability(projectId, user.id, capability);
        if (request.method === "GET") {
          const includeArchived = url.searchParams.get("archived") === "1";
          const rows = services.database.prepare(`
            SELECT resource_id, data, version, archived_at, updated_at, updated_by
            FROM project_resources
            WHERE project_id = ? AND resource_type = ? ${includeArchived ? "" : "AND archived_at IS NULL"}
            ORDER BY updated_at DESC
          `).all(projectId, resourceType) as Array<{ resource_id: string; data: string; version: number; archived_at: string | null; updated_at: string; updated_by: string }>;
          sendJson(response, 200, { resources: rows.map((row) => ({ id: row.resource_id, data: resourceData(parseJson(row.data, {})), version: row.version, archivedAt: row.archived_at, updatedAt: row.updated_at, updatedBy: row.updated_by })) });
          return true;
        }
        if (request.method === "POST") {
          const body = await readJson<{ id?: string; data?: Record<string, unknown> }>(request, 2_000_000);
          const data = resourceData(body.data);
          const id = body.id?.trim() || (typeof data.id === "string" ? data.id.trim() : "") || randomUUID();
          if (id.length > 240) throw new PlatformError(400, "RESOURCE_ID_INVALID");
          const timestamp = now();
          try {
            services.database.prepare(`INSERT INTO project_resources (project_id, resource_type, resource_id, data, version, updated_at, updated_by) VALUES (?, ?, ?, ?, 1, ?, ?)`)
              .run(projectId, resourceType, id, json({ ...data, id }), timestamp, user.id);
          } catch {
            throw new PlatformError(409, "RESOURCE_ALREADY_EXISTS");
          }
          services.audit(project.workspace_id, { type: "user", id: user.id }, `${resourceType}.created`, { type: resourceType, id }, {}, projectId);
          sendJson(response, 201, { resource: { id, data: { ...data, id }, version: 1, archivedAt: null, updatedAt: timestamp, updatedBy: user.id } });
          return true;
        }
      }

      const resourceDetail = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/resources\/(flows|elements|variables|environments)\/([^/]+)$/);
      if (resourceDetail) {
        const user = services.sessionUser(request);
        const projectId = decodeURIComponent(resourceDetail[1]);
        const resourceType = resourceDetail[2];
        const resourceId = decodeURIComponent(resourceDetail[3]);
        const capability = resourceCapabilities[resourceType];
        const { project } = request.method === "GET"
          ? services.requireProjectRole(projectId, user.id)
          : services.requireProjectCapability(projectId, user.id, capability);
        const current = services.database.prepare(`SELECT data, version, archived_at, updated_at, updated_by FROM project_resources WHERE project_id = ? AND resource_type = ? AND resource_id = ?`)
          .get(projectId, resourceType, resourceId) as { data: string; version: number; archived_at: string | null; updated_at: string; updated_by: string } | undefined;
        if (!current) throw new PlatformError(404, "RESOURCE_NOT_FOUND");
        if (request.method === "GET") {
          sendJson(response, 200, { resource: { id: resourceId, data: resourceData(parseJson(current.data, {})), version: current.version, archivedAt: current.archived_at, updatedAt: current.updated_at, updatedBy: current.updated_by } });
          return true;
        }
        if (request.method === "PUT" || request.method === "PATCH") {
          const body = await readJson<{ data?: Record<string, unknown>; expectedVersion?: number; archived?: boolean }>(request, 2_000_000);
          if (!Number.isInteger(body.expectedVersion)) throw new PlatformError(400, "EXPECTED_VERSION_REQUIRED");
          const expectedVersion = Number(body.expectedVersion);
          const previous = parseJson<Record<string, unknown>>(current.data, {});
          const data = resourceData(request.method === "PATCH" ? { ...previous, ...asRecord(body.data), id: resourceId } : { ...asRecord(body.data), id: resourceId });
          const timestamp = now();
          const archivedAt = body.archived === true ? timestamp : body.archived === false ? null : current.archived_at;
          const result = services.database.prepare(`UPDATE project_resources SET data = ?, version = version + 1, archived_at = ?, updated_at = ?, updated_by = ? WHERE project_id = ? AND resource_type = ? AND resource_id = ? AND version = ?`)
            .run(json(data), archivedAt, timestamp, user.id, projectId, resourceType, resourceId, expectedVersion);
          if (result.changes === 0) throw new PlatformError(409, "RESOURCE_VERSION_CONFLICT");
          const version = expectedVersion + 1;
          services.audit(project.workspace_id, { type: "user", id: user.id }, `${resourceType}.updated`, { type: resourceType, id: resourceId }, { version, archived: body.archived }, projectId);
          sendJson(response, 200, { resource: { id: resourceId, data, version, archivedAt, updatedAt: timestamp, updatedBy: user.id } });
          return true;
        }
        if (request.method === "DELETE") {
          const expectedVersion = Number(url.searchParams.get("expectedVersion"));
          if (!Number.isInteger(expectedVersion)) throw new PlatformError(400, "EXPECTED_VERSION_REQUIRED");
          const timestamp = now();
          const result = services.database.prepare(`UPDATE project_resources SET archived_at = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE project_id = ? AND resource_type = ? AND resource_id = ? AND version = ?`)
            .run(timestamp, timestamp, user.id, projectId, resourceType, resourceId, expectedVersion);
          if (result.changes === 0) throw new PlatformError(409, "RESOURCE_VERSION_CONFLICT");
          services.audit(project.workspace_id, { type: "user", id: user.id }, `${resourceType}.archived`, { type: resourceType, id: resourceId }, {}, projectId);
          sendJson(response, 200, { id: resourceId, archived: true, version: expectedVersion + 1 });
          return true;
        }
      }

      const projectSettings = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/settings$/);
      if (projectSettings) {
        const user = services.sessionUser(request);
        const projectId = decodeURIComponent(projectSettings[1]);
        const { project } = request.method === "GET"
          ? services.requireProjectRole(projectId, user.id)
          : services.requireProjectCapability(projectId, user.id, "project.edit");
        const current = services.database.prepare("SELECT data, version, updated_at, updated_by FROM project_settings WHERE project_id = ?").get(projectId) as { data: string; version: number; updated_at: string; updated_by: string } | undefined;
        if (request.method === "GET") {
          sendJson(response, 200, { settings: { data: parseJson(current?.data ?? null, {}), version: current?.version ?? 0, updatedAt: current?.updated_at, updatedBy: current?.updated_by } });
          return true;
        }
        if (request.method === "PUT") {
          const body = await readJson<{ data?: Record<string, unknown>; expectedVersion?: number }>(request);
          const expectedVersion = body.expectedVersion;
          if (!Number.isInteger(expectedVersion) || expectedVersion !== (current?.version ?? 0)) throw new PlatformError(409, "RESOURCE_VERSION_CONFLICT");
          const version = expectedVersion + 1;
          const timestamp = now();
          services.database.prepare(`INSERT INTO project_settings (project_id, data, version, updated_at, updated_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET data = excluded.data, version = excluded.version, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
            .run(projectId, json(asRecord(body.data)), version, timestamp, user.id);
          services.audit(project.workspace_id, { type: "user", id: user.id }, "project.settings_updated", { type: "project", id: projectId }, { version }, projectId);
          sendJson(response, 200, { settings: { data: asRecord(body.data), version, updatedAt: timestamp, updatedBy: user.id } });
          return true;
        }
      }

      const revisionRoot = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/revisions$/);
      if (revisionRoot) {
        const user = services.sessionUser(request);
        const projectId = decodeURIComponent(revisionRoot[1]);
        const { project } = services.requireProjectRole(projectId, user.id, request.method !== "GET");
        if (request.method === "GET") {
          const revisions = services.database.prepare(`SELECT id, flow_id, flow_name, environment_id, revision_number, status, checksum, created_by, created_at, published_at, flow_snapshot FROM flow_revisions WHERE project_id = ? ORDER BY revision_number DESC`).all(projectId) as Array<{ id: string; flow_id: string | null; flow_name: string | null; environment_id: string | null; revision_number: number; status: RevisionStatus; checksum: string; created_by: string; created_at: string; published_at: string | null; flow_snapshot: string }>;
          sendJson(response, 200, {
            revisions: revisions.map((item) => {
              const flow = parseJson<Record<string, unknown>>(item.flow_snapshot, {});
              const steps = Array.isArray(flow.steps) ? flow.steps : [];
              return {
                id: item.id,
                flowId: item.flow_id ?? (typeof flow.id === "string" ? flow.id : undefined),
                flowName: item.flow_name ?? (typeof flow.name === "string" ? flow.name : undefined),
                revisionNumber: item.revision_number,
                status: item.status,
                checksum: item.checksum,
                createdBy: item.created_by,
                createdAt: item.created_at,
                publishedAt: item.published_at,
                environmentId: item.environment_id ?? undefined,
                stepCount: steps.length,
              };
            }),
          });
          return true;
        }
        if (request.method === "POST") {
          services.requireProjectCapability(projectId, user.id, "release.submit");
          const body = await readJson<{ flowId?: string; environmentId?: string; flow?: Record<string, unknown>; environment?: Record<string, unknown>; elements?: unknown; dataset?: unknown; datasetVersionId?: string; secretNames?: unknown }>(request, 5_000_000);
          const resource = (type: string, id: string) => {
            const row = services.database.prepare("SELECT data FROM project_resources WHERE project_id = ? AND resource_type = ? AND resource_id = ? AND archived_at IS NULL").get(projectId, type, id) as { data: string } | undefined;
            return row ? parseJson<Record<string, unknown>>(row.data, {}) : undefined;
          };
          const requestedFlowId = body.flowId?.trim() || (typeof body.flow?.id === "string" ? body.flow.id.trim() : "");
          const requestedEnvironmentId = body.environmentId?.trim() || (typeof body.environment?.id === "string" ? body.environment.id.trim() : "");
          const flow = body.flow ?? (requestedFlowId ? resource("flows", requestedFlowId) : undefined);
          const environment = body.environment ?? (requestedEnvironmentId ? resource("environments", requestedEnvironmentId) : undefined);
          if (!flow || !environment) throw new PlatformError(400, "REVISION_SNAPSHOT_INCOMPLETE");
          const resourceElements = services.database.prepare("SELECT data FROM project_resources WHERE project_id = ? AND resource_type = 'elements' AND archived_at IS NULL ORDER BY updated_at").all(projectId) as Array<{ data: string }>;
          const elements = Array.isArray(body.elements) ? body.elements : resourceElements.map((row) => parseJson(row.data, {}));
          services.requireChromiumEnvironment(asRecord(environment));
          const flowId = typeof flow.id === "string" ? flow.id.trim() : "";
          if (!flowId) throw new PlatformError(400, "FLOW_ID_REQUIRED");
          const flowName = typeof flow.name === "string" ? flow.name.trim().slice(0, 240) : "";
          const environmentId = typeof environment.id === "string" ? environment.id.trim() : "";
          if (!environmentId) throw new PlatformError(400, "REVISION_ENVIRONMENT_REQUIRED");
          const secretNames = Array.isArray(body.secretNames)
            ? body.secretNames.filter((item): item is string => typeof item === "string")
            : [];
          const datasetVersion = body.datasetVersionId ? services.datasetVersionFor(projectId, body.datasetVersionId) : undefined;
          const dataset = datasetVersion
            ? { datasetId: datasetVersion.datasetId, versionId: datasetVersion.id, versionNumber: datasetVersion.versionNumber, checksum: datasetVersion.checksum, columns: datasetVersion.columns, rowCount: datasetVersion.rowCount }
            : body.dataset ?? null;
          assertSnapshotDepth(flow);
          assertSnapshotDepth(environment);
          assertSnapshotDepth(elements);
          assertSnapshotDepth(dataset);
          const flowSnapshot: Record<string, unknown> = { ...asRecord(flow), secretNames };
          const flowStepCount = Array.isArray(flowSnapshot.steps) ? flowSnapshot.steps.length : 0;
          const snapshot = {
            flow: flowSnapshot,
            environment: asRecord(environment),
            elements,
            dataset,
            secretNames,
          };
          services.database.exec("BEGIN IMMEDIATE");
          let revision: { id: string; number: number; checksum: string; createdAt: string };
          try {
            const rows = services.database.prepare(`SELECT revision_number FROM flow_revisions WHERE project_id = ?`).all(projectId) as Array<{ revision_number: number }>;
            revision = { id: randomUUID(), number: revisionNumber(rows), checksum: digest(json(snapshot)), createdAt: now() };
            services.database.prepare(`INSERT INTO flow_revisions (id, project_id, flow_id, flow_name, environment_id, revision_number, status, flow_snapshot, environment_snapshot, element_snapshot, dataset_snapshot, checksum, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`)
              .run(revision.id, projectId, flowId, flowName || null, environmentId, revision.number, json(snapshot.flow), json(snapshot.environment), json(snapshot.elements), json(snapshot.dataset), revision.checksum, user.id, revision.createdAt);
            services.database.exec("COMMIT");
          } catch (error) {
            services.database.exec("ROLLBACK");
            throw error;
          }
          services.audit(project.workspace_id, { type: "user", id: user.id }, "flow_revision.created", { type: "flow_revision", id: revision.id }, { revisionNumber: revision.number }, projectId);
          sendJson(response, 201, { revision: { id: revision.id, flowId, flowName: flowName || undefined, environmentId, stepCount: flowStepCount, revisionNumber: revision.number, status: "draft", checksum: revision.checksum, createdAt: revision.createdAt } });
          return true;
        }
      }

      const revisionAction = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/revisions\/([^/]+)\/(submit|publish|reject|deprecate|rollback)$/);
      if (revisionAction && request.method === "POST") {
        const user = services.sessionUser(request);
        const projectId = decodeURIComponent(revisionAction[1]);
        const revisionId = decodeURIComponent(revisionAction[2]);
        const action = revisionAction[3];
        const { project, role } = services.requireProjectCapability(projectId, user.id, action === "submit" ? "release.submit" : "release.publish");
        const revision = services.database.prepare(`SELECT * FROM flow_revisions WHERE id = ? AND project_id = ?`).get(revisionId, projectId) as {
          id: string; status: RevisionStatus; flow_id: string | null; flow_name: string | null; environment_id: string | null;
          flow_snapshot: string; environment_snapshot: string; element_snapshot: string; dataset_snapshot: string;
          checksum: string;
        } | undefined;
        if (!revision) throw new PlatformError(404, "REVISION_NOT_FOUND");
        if (!revision.flow_id || !revision.environment_id) throw new PlatformError(409, "REVISION_SCOPE_REQUIRED");
        const status = revision.status as RevisionStatus;
        const body = await readJson<{ note?: string }>(request);
        const note = body.note?.trim().slice(0, 2000) ?? "";
        if (action === "submit") {
          if (status !== "draft" && status !== "rejected") throw new PlatformError(409, "REVISION_NOT_SUBMITTABLE");
          services.database.prepare("UPDATE flow_revisions SET status = 'pending_review', submitted_at = ?, review_note = NULL, reviewed_by = NULL WHERE id = ?").run(now(), revisionId);
          services.audit(project.workspace_id, { type: "user", id: user.id }, "flow_revision.submitted", { type: "flow_revision", id: revisionId }, { note }, projectId);
          sendJson(response, 200, { revisionId, status: "pending_review" });
          return true;
        }
        if (action === "reject") {
          if (status !== "pending_review") throw new PlatformError(409, "REVISION_NOT_REVIEWABLE");
          if (!note) throw new PlatformError(400, "REJECTION_NOTE_REQUIRED");
          services.database.prepare("UPDATE flow_revisions SET status = 'rejected', reviewed_by = ?, review_note = ? WHERE id = ?").run(user.id, note, revisionId);
          services.audit(project.workspace_id, { type: "user", id: user.id }, "flow_revision.rejected", { type: "flow_revision", id: revisionId }, { note }, projectId);
          sendJson(response, 200, { revisionId, status: "rejected" });
          return true;
        }
        if (action === "deprecate") {
          if (status !== "published") throw new PlatformError(409, "REVISION_NOT_PUBLISHED");
          services.database.prepare("UPDATE flow_revisions SET status = 'deprecated', reviewed_by = ?, review_note = ? WHERE id = ?").run(user.id, note || null, revisionId);
          services.audit(project.workspace_id, { type: "user", id: user.id }, "flow_revision.deprecated", { type: "flow_revision", id: revisionId }, { note }, projectId);
          sendJson(response, 200, { revisionId, status: "deprecated" });
          return true;
        }
        if (action === "publish") {
          if (status !== "pending_review" && !(["owner", "admin"].includes(role) && status === "draft")) throw new PlatformError(409, "REVISION_NOT_REVIEWABLE");
          services.database.exec("BEGIN IMMEDIATE");
          try {
            services.database.prepare(`UPDATE flow_revisions SET status = 'superseded' WHERE project_id = ? AND flow_id = ? AND environment_id = ? AND status = 'published'`).run(projectId, revision.flow_id, revision.environment_id);
            services.database.prepare(`UPDATE flow_revisions SET status = 'published', published_at = ?, reviewed_by = ?, review_note = ? WHERE id = ?`).run(now(), user.id, note || null, revisionId);
            services.database.exec("COMMIT");
          } catch (error) {
            services.database.exec("ROLLBACK");
            throw error;
          }
          services.audit(project.workspace_id, { type: "user", id: user.id }, status === "draft" ? "flow_revision.review_bypassed" : "flow_revision.published", { type: "flow_revision", id: revisionId }, { note }, projectId);
          sendJson(response, 200, { revisionId, status: "published", action });
          return true;
        }
        const rows = services.database.prepare("SELECT revision_number FROM flow_revisions WHERE project_id = ?").all(projectId) as Array<{ revision_number: number }>;
        const rollbackId = randomUUID();
        const createdAt = now();
        services.database.exec("BEGIN IMMEDIATE");
        try {
          services.database.prepare(`UPDATE flow_revisions SET status = 'superseded' WHERE project_id = ? AND flow_id = ? AND environment_id = ? AND status = 'published'`).run(projectId, revision.flow_id, revision.environment_id);
          services.database.prepare(`INSERT INTO flow_revisions (id, project_id, flow_id, flow_name, environment_id, revision_number, status, flow_snapshot, environment_snapshot, element_snapshot, dataset_snapshot, checksum, created_by, created_at, published_at, submitted_at, reviewed_by, review_note) VALUES (?, ?, ?, ?, ?, ?, 'published', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(rollbackId, projectId, revision.flow_id, revision.flow_name ?? null, revision.environment_id, revisionNumber(rows), revision.flow_snapshot, revision.environment_snapshot, revision.element_snapshot, revision.dataset_snapshot, revision.checksum, user.id, createdAt, createdAt, createdAt, user.id, note || `Rollback to ${revisionId}`);
          services.database.exec("COMMIT");
        } catch (error) {
          services.database.exec("ROLLBACK");
          throw error;
        }
        services.audit(project.workspace_id, { type: "user", id: user.id }, "flow_revision.rolled_back", { type: "flow_revision", id: rollbackId }, { sourceRevisionId: revisionId, note }, projectId);
        sendJson(response, 201, { revisionId: rollbackId, sourceRevisionId: revisionId, status: "published", action });
        return true;
      }

      const projectSecrets = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/secrets$/);
      if (projectSecrets) {
        const user = services.sessionUser(request);
        const projectId = decodeURIComponent(projectSecrets[1]);
        const { project } = request.method === "GET" ? services.requireProjectRole(projectId, user.id) : services.requireProjectCapability(projectId, user.id, "secret.manage");
        if (request.method === "GET") {
          const secrets = services.database.prepare(`SELECT id, name, key_version, created_at, updated_at FROM project_secrets WHERE project_id = ? ORDER BY name`).all(projectId) as Array<{ id: string; name: string; key_version: number; created_at: string; updated_at: string }>;
          sendJson(response, 200, { secrets: secrets.map((item) => ({ id: item.id, name: item.name, keyVersion: item.key_version, createdAt: item.created_at, updatedAt: item.updated_at })) });
          return true;
        }
        if (request.method === "POST") {
          const body = await readJson<{ name?: string; value?: string }>(request);
          const name = body.name?.trim();
          if (!name || !body.value) throw new PlatformError(400, "SECRET_INPUT_INVALID");
          const encrypted = services.encrypt(body.value);
          const existing = services.database.prepare(`SELECT id, key_version, created_at FROM project_secrets WHERE project_id = ? AND name = ?`).get(projectId, name) as { id: string; key_version: number; created_at: string } | undefined;
          const id = existing?.id ?? randomUUID();
          const keyVersion = (existing?.key_version ?? 0) + 1;
          services.database.prepare(`INSERT INTO project_secrets (id, project_id, name, key_version, iv, tag, ciphertext, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, name) DO UPDATE SET key_version = excluded.key_version, iv = excluded.iv, tag = excluded.tag, ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`)
            .run(id, projectId, name, keyVersion, encrypted.iv, encrypted.tag, encrypted.ciphertext, existing?.created_at ?? now(), now());
          services.audit(project.workspace_id, { type: "user", id: user.id }, "secret.rotated", { type: "secret", id }, { name, keyVersion }, projectId);
          sendJson(response, 201, { secret: { id, name, keyVersion } });
          return true;
        }
      }

      const auditRoute = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/audit-events$/);
      if (auditRoute && request.method === "GET") {
        const user = services.sessionUser(request);
        const projectId = decodeURIComponent(auditRoute[1]);
        services.requireProjectRole(projectId, user.id);
        const events = services.database.prepare(`SELECT id, actor_type, actor_id, action, target_type, target_id, detail, created_at FROM audit_events WHERE project_id = ? ORDER BY created_at DESC LIMIT 500`).all(projectId) as Array<{ id: string; actor_type: string; actor_id: string; action: string; target_type: string; target_id: string; detail: string; created_at: string }>;
        sendJson(response, 200, { events: events.map((item) => ({ id: item.id, actorType: item.actor_type, actorId: item.actor_id, action: item.action, targetType: item.target_type, targetId: item.target_id, detail: parseJson(item.detail, {}), createdAt: item.created_at })) });
        return true;
      }

      const analyticsRoute = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/analytics$/);
      if (analyticsRoute && request.method === "GET") {
        const user = services.sessionUser(request);
        const projectId = decodeURIComponent(analyticsRoute[1]);
        services.requireProjectRole(projectId, user.id);
        sendJson(response, 200, { analytics: services.projectAnalytics(projectId) });
        return true;
      }

      const datasetRoot = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/datasets$/);
      if (datasetRoot) {
        const user = services.sessionUser(request);
        const projectId = decodeURIComponent(datasetRoot[1]);
        const { project } = services.requireProjectRole(projectId, user.id, request.method !== "GET");
        if (request.method === "GET") {
          const datasets = services.database.prepare(
            `SELECT d.id, d.name, d.description, d.created_at, d.updated_at,
                    v.id AS version_id, v.version_number, v.columns_json, v.row_count, v.checksum, v.source_name, v.created_at AS version_created_at
             FROM datasets d LEFT JOIN dataset_versions v ON v.id = (
               SELECT id FROM dataset_versions WHERE dataset_id = d.id ORDER BY version_number DESC LIMIT 1
             ) WHERE d.project_id = ? AND d.archived_at IS NULL ORDER BY d.updated_at DESC`,
          ).all(projectId) as Array<{ id: string; name: string; description: string; created_at: string; updated_at: string; version_id: string | null; version_number: number | null; columns_json: string | null; row_count: number | null; checksum: string | null; source_name: string | null; version_created_at: string | null }>;
          sendJson(response, 200, {
            datasets: datasets.map((dataset) => ({
              id: dataset.id,
              name: dataset.name,
              description: dataset.description,
              createdAt: dataset.created_at,
              updatedAt: dataset.updated_at,
              latestVersion: dataset.version_id ? {
                id: dataset.version_id,
                datasetId: dataset.id,
                projectId,
                versionNumber: dataset.version_number,
                columns: parseJson<string[]>(dataset.columns_json, []),
                rowCount: dataset.row_count,
                checksum: dataset.checksum,
                sourceName: dataset.source_name,
                createdAt: dataset.version_created_at,
              } : undefined,
            })),
          });
          return true;
        }
        if (request.method === "POST") {
          const body = await readJson<{ name?: string; description?: string; fileName?: string; contentBase64?: string }>(request, 18_000_000);
          const name = body.name?.trim().slice(0, 160);
          if (!name || !body.fileName || !body.contentBase64) throw new PlatformError(400, "DATASET_IMPORT_INPUT_INVALID");
          const parsed = await services.parseDatasetUpload(body.fileName, body.contentBase64);
          const dataset = { id: randomUUID(), name, createdAt: now() };
          services.database.exec("BEGIN IMMEDIATE");
          let version: { id: string; number: number; checksum: string; createdAt: string };
          try {
            services.database.prepare(`INSERT INTO datasets (id, project_id, name, description, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
              .run(dataset.id, projectId, dataset.name, body.description?.trim().slice(0, 1_000) ?? "", user.id, dataset.createdAt, dataset.createdAt);
            version = { id: randomUUID(), number: 1, checksum: digest(json({ columns: parsed.columns, rows: parsed.rows })), createdAt: now() };
            services.database.prepare(`INSERT INTO dataset_versions (id, dataset_id, version_number, columns_json, row_count, checksum, source_name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
              .run(version.id, dataset.id, version.number, json(parsed.columns), parsed.rows.length, version.checksum, parsed.sourceName, user.id, version.createdAt);
            const insert = services.database.prepare(`INSERT INTO dataset_rows (id, dataset_version_id, row_number, data_json) VALUES (?, ?, ?, ?)`);
            for (const [index, row] of parsed.rows.entries()) insert.run(randomUUID(), version.id, index + 1, json(row));
            services.database.exec("COMMIT");
          } catch (error) {
            services.database.exec("ROLLBACK");
            if (error instanceof PlatformError) throw error;
            throw new PlatformError(409, "DATASET_NAME_EXISTS");
          }
          services.audit(project.workspace_id, { type: "user", id: user.id }, "dataset.imported", { type: "dataset", id: dataset.id }, { versionId: version.id, rows: parsed.rows.length, sourceName: parsed.sourceName }, projectId);
          sendJson(response, 201, { dataset: { id: dataset.id, name: dataset.name, description: body.description?.trim() ?? "", createdAt: dataset.createdAt }, version: services.datasetVersionFor(projectId, version.id) });
          return true;
        }
      }

      const datasetDetail = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/datasets\/([^/]+)$/);
      if (datasetDetail && request.method === "DELETE") {
        const user = services.sessionUser(request);
        const projectId = decodeURIComponent(datasetDetail[1]);
        const datasetId = decodeURIComponent(datasetDetail[2]);
        const { project } = services.requireProjectCapability(projectId, user.id, "dataset.manage");
        const result = services.database.prepare("UPDATE datasets SET archived_at = ?, updated_at = ? WHERE id = ? AND project_id = ? AND archived_at IS NULL")
          .run(now(), now(), datasetId, projectId);
        if (result.changes === 0) throw new PlatformError(404, "DATASET_NOT_FOUND");
        services.audit(project.workspace_id, { type: "user", id: user.id }, "dataset.archived", { type: "dataset", id: datasetId }, {}, projectId);
        sendJson(response, 200, { datasetId, archived: true });
        return true;
      }

      const datasetVersionRoot = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/datasets\/([^/]+)\/versions$/);
      if (datasetVersionRoot) {
        const user = services.sessionUser(request);
        const projectId = decodeURIComponent(datasetVersionRoot[1]);
        const datasetId = decodeURIComponent(datasetVersionRoot[2]);
        const { project } = request.method === "GET" ? services.requireProjectRole(projectId, user.id) : services.requireProjectCapability(projectId, user.id, "dataset.manage");
        const dataset = services.database.prepare(`SELECT id, name FROM datasets WHERE id = ? AND project_id = ? AND archived_at IS NULL`).get(datasetId, projectId) as { id: string; name: string } | undefined;
        if (!dataset) throw new PlatformError(404, "DATASET_NOT_FOUND");
        if (request.method === "GET") {
          const versions = services.database.prepare(
            `SELECT v.id, v.dataset_id, d.project_id, v.version_number, v.columns_json, v.row_count, v.checksum, v.source_name, v.created_at
             FROM dataset_versions v JOIN datasets d ON d.id = v.dataset_id WHERE v.dataset_id = ? ORDER BY v.version_number DESC`,
          ).all(datasetId) as Array<{ id: string; dataset_id: string; project_id: string; version_number: number; columns_json: string; row_count: number; checksum: string; source_name: string; created_at: string }>;
          sendJson(response, 200, { versions: versions.map(services.datasetVersionResponse) });
          return true;
        }
        if (request.method === "POST") {
          const body = await readJson<{ fileName?: string; contentBase64?: string }>(request, 18_000_000);
          if (!body.fileName || !body.contentBase64) throw new PlatformError(400, "DATASET_IMPORT_INPUT_INVALID");
          const parsed = await services.parseDatasetUpload(body.fileName, body.contentBase64);
          services.database.exec("BEGIN IMMEDIATE");
          let version: { id: string; number: number; checksum: string; createdAt: string };
          try {
            const latest = services.database.prepare(`SELECT MAX(version_number) AS number FROM dataset_versions WHERE dataset_id = ?`).get(datasetId) as { number: number | null };
            version = { id: randomUUID(), number: Number(latest.number ?? 0) + 1, checksum: digest(json({ columns: parsed.columns, rows: parsed.rows })), createdAt: now() };
            services.database.prepare(`INSERT INTO dataset_versions (id, dataset_id, version_number, columns_json, row_count, checksum, source_name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
              .run(version.id, datasetId, version.number, json(parsed.columns), parsed.rows.length, version.checksum, parsed.sourceName, user.id, version.createdAt);
            const insert = services.database.prepare(`INSERT INTO dataset_rows (id, dataset_version_id, row_number, data_json) VALUES (?, ?, ?, ?)`);
            for (const [index, row] of parsed.rows.entries()) insert.run(randomUUID(), version.id, index + 1, json(row));
            services.database.exec("COMMIT");
          } catch (error) {
            services.database.exec("ROLLBACK");
            throw error;
          }
          services.database.prepare(`UPDATE datasets SET updated_at = ? WHERE id = ?`).run(now(), datasetId);
          services.audit(project.workspace_id, { type: "user", id: user.id }, "dataset.version_imported", { type: "dataset_version", id: version.id }, { datasetId, version: version.number, rows: parsed.rows.length }, projectId);
          sendJson(response, 201, { version: services.datasetVersionFor(projectId, version.id) });
          return true;
        }
      }

      const datasetVersionDetail = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/dataset-versions\/([^/]+)$/);
      if (datasetVersionDetail && request.method === "GET") {
        const user = services.sessionUser(request);
        const projectId = decodeURIComponent(datasetVersionDetail[1]);
        const version = services.datasetVersionFor(projectId, decodeURIComponent(datasetVersionDetail[2]));
        services.requireProjectRole(projectId, user.id);
        sendJson(response, 200, { version, rows: services.datasetRowsFor(version.id).slice(0, 100), truncated: version.rowCount > 100 });
        return true;
      }

      const scheduleRoot = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/schedules$/);
      if (scheduleRoot) {
        const user = services.sessionUser(request);
        const projectId = decodeURIComponent(scheduleRoot[1]);
        const { project } = request.method === "GET" ? services.requireProjectRole(projectId, user.id) : services.requireProjectCapability(projectId, user.id, "automation.manage");
        if (request.method === "GET") {
          const schedules = services.database.prepare(`SELECT id, revision_id, environment_id, dataset_version_id, name, cron_expression, timezone, enabled, last_run_at, next_run_at, created_at, updated_at FROM schedules WHERE project_id = ? AND archived_at IS NULL ORDER BY created_at DESC`).all(projectId) as Array<{ id: string; revision_id: string; environment_id: string; dataset_version_id: string | null; name: string; cron_expression: string; timezone: string; enabled: number; last_run_at: string | null; next_run_at: string; created_at: string; updated_at: string }>;
          sendJson(response, 200, { schedules: schedules.map((item) => ({ id: item.id, revisionId: item.revision_id, environmentId: item.environment_id, datasetVersionId: item.dataset_version_id, name: item.name, cron: item.cron_expression, timezone: item.timezone, enabled: Boolean(item.enabled), lastRunAt: item.last_run_at, nextRunAt: item.next_run_at, createdAt: item.created_at, updatedAt: item.updated_at })) });
          return true;
        }
        if (request.method === "POST") {
          const body = await readJson<{ name?: string; revisionId?: string; environmentId?: string; datasetVersionId?: string; cron?: string; timezone?: string }>(request);
          const name = body.name?.trim().slice(0, 160);
          const cron = body.cron?.trim();
          const timezone = body.timezone?.trim() || "Asia/Shanghai";
          if (!name || !cron || !body.environmentId) throw new PlatformError(400, "SCHEDULE_INPUT_INVALID");
          const revision = services.publishedRevisionFor(projectId, body.revisionId);
          services.requireRevisionEnvironment(revision, body.environmentId);
          if (body.datasetVersionId) services.datasetVersionFor(projectId, body.datasetVersionId);
          const schedule = { id: randomUUID(), nextRunAt: nextCronTime(cron, timezone), createdAt: now() };
          services.database.prepare(`INSERT INTO schedules (id, project_id, revision_id, environment_id, dataset_version_id, name, cron_expression, timezone, enabled, next_run_at, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`)
            .run(schedule.id, projectId, revision.id, body.environmentId, body.datasetVersionId ?? null, name, cron, timezone, schedule.nextRunAt, user.id, schedule.createdAt, schedule.createdAt);
          services.audit(project.workspace_id, { type: "user", id: user.id }, "schedule.created", { type: "schedule", id: schedule.id }, { revisionId: revision.id, environmentId: body.environmentId, datasetVersionId: body.datasetVersionId, cron, timezone }, projectId);
          sendJson(response, 201, { schedule: { id: schedule.id, name, revisionId: revision.id, environmentId: body.environmentId, datasetVersionId: body.datasetVersionId ?? null, cron, timezone, enabled: true, nextRunAt: schedule.nextRunAt } });
          return true;
        }
      }

      const scheduleDetail = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/schedules\/([^/]+)$/);
      if (scheduleDetail && request.method === "DELETE") {
        const user = services.sessionUser(request);
        const projectId = decodeURIComponent(scheduleDetail[1]);
        const scheduleId = decodeURIComponent(scheduleDetail[2]);
        const { project } = services.requireProjectCapability(projectId, user.id, "automation.manage");
        const result = services.database.prepare("UPDATE schedules SET archived_at = ?, enabled = 0, updated_at = ? WHERE id = ? AND project_id = ? AND archived_at IS NULL")
          .run(now(), now(), scheduleId, projectId);
        if (result.changes === 0) throw new PlatformError(404, "SCHEDULE_NOT_FOUND");
        services.audit(project.workspace_id, { type: "user", id: user.id }, "schedule.archived", { type: "schedule", id: scheduleId }, {}, projectId);
        sendJson(response, 200, { scheduleId, archived: true });
        return true;
      }

      const scheduleAction = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/schedules\/([^/]+)\/(enable|disable|run)$/);
      if (scheduleAction && request.method === "POST") {
        const user = services.sessionUser(request);
        const projectId = decodeURIComponent(scheduleAction[1]);
        const scheduleId = decodeURIComponent(scheduleAction[2]);
        const action = scheduleAction[3];
        const { project } = services.requireProjectCapability(projectId, user.id, "automation.manage");
        const schedule = services.database.prepare(`SELECT id, revision_id, environment_id, dataset_version_id FROM schedules WHERE id = ? AND project_id = ? AND archived_at IS NULL`).get(scheduleId, projectId) as { id: string; revision_id: string; environment_id: string; dataset_version_id: string | null } | undefined;
        if (!schedule) throw new PlatformError(404, "SCHEDULE_NOT_FOUND");
        if (action === "run") {
          const queued = services.queuePublishedRuns({ projectId, revisionId: schedule.revision_id, environmentId: schedule.environment_id, datasetVersionId: schedule.dataset_version_id ?? undefined, createdBy: `schedule:${schedule.id}`, source: "schedule" });
          services.database.prepare(`UPDATE schedules SET last_run_at = ?, updated_at = ? WHERE id = ?`).run(now(), now(), schedule.id);
          services.audit(project.workspace_id, { type: "user", id: user.id }, "schedule.run_requested", { type: "schedule", id: schedule.id }, { runIds: queued.runIds }, projectId);
          sendJson(response, 202, { runIds: queued.runIds });
          return true;
        }
        services.database.prepare(`UPDATE schedules SET enabled = ?, updated_at = ? WHERE id = ?`).run(action === "enable" ? 1 : 0, now(), schedule.id);
        services.audit(project.workspace_id, { type: "user", id: user.id }, action === "enable" ? "schedule.enabled" : "schedule.disabled", { type: "schedule", id: schedule.id }, {}, projectId);
        sendJson(response, 200, { scheduleId: schedule.id, enabled: action === "enable" });
        return true;
      }

      const webhookRoot = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/webhook-triggers$/);
      if (webhookRoot) {
        const user = services.sessionUser(request);
        const projectId = decodeURIComponent(webhookRoot[1]);
        const { project } = request.method === "GET" ? services.requireProjectRole(projectId, user.id) : services.requireProjectCapability(projectId, user.id, "automation.manage");
        if (request.method === "GET") {
          const triggers = services.database.prepare(`SELECT id, revision_id, environment_id, dataset_version_id, name, enabled, created_at, last_triggered_at FROM webhook_triggers WHERE project_id = ? AND archived_at IS NULL ORDER BY created_at DESC`).all(projectId) as Array<{ id: string; revision_id: string; environment_id: string; dataset_version_id: string | null; name: string; enabled: number; created_at: string; last_triggered_at: string | null }>;
          sendJson(response, 200, { triggers: triggers.map((item) => ({ id: item.id, revisionId: item.revision_id, environmentId: item.environment_id, datasetVersionId: item.dataset_version_id, name: item.name, enabled: Boolean(item.enabled), createdAt: item.created_at, lastTriggeredAt: item.last_triggered_at })) });
          return true;
        }
        if (request.method === "POST") {
          const body = await readJson<{ name?: string; revisionId?: string; environmentId?: string; datasetVersionId?: string }>(request);
          const name = body.name?.trim().slice(0, 160);
          if (!name || !body.environmentId) throw new PlatformError(400, "WEBHOOK_TRIGGER_INPUT_INVALID");
          const revision = services.publishedRevisionFor(projectId, body.revisionId);
          services.requireRevisionEnvironment(revision, body.environmentId);
          if (body.datasetVersionId) services.datasetVersionFor(projectId, body.datasetVersionId);
          const signingSecret = `whsec_${randomBytes(32).toString("base64url")}`;
          const encryptedSecret = services.encrypt(signingSecret);
          const trigger = { id: randomUUID(), createdAt: now() };
          services.database.prepare(`INSERT INTO webhook_triggers (id, project_id, revision_id, environment_id, dataset_version_id, name, token_hash, signing_secret_iv, signing_secret_tag, signing_secret_ciphertext, enabled, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
            .run(trigger.id, projectId, revision.id, body.environmentId, body.datasetVersionId ?? null, name, digest(randomBytes(32).toString("base64url")), encryptedSecret.iv, encryptedSecret.tag, encryptedSecret.ciphertext, user.id, trigger.createdAt);
          services.audit(project.workspace_id, { type: "user", id: user.id }, "webhook_trigger.created", { type: "webhook_trigger", id: trigger.id }, { revisionId: revision.id, environmentId: body.environmentId }, projectId);
          sendJson(response, 201, { trigger: { id: trigger.id, name, revisionId: revision.id, environmentId: body.environmentId, datasetVersionId: body.datasetVersionId ?? null, enabled: true, createdAt: trigger.createdAt }, triggerUrl: `/api/platform/webhooks/${encodeURIComponent(trigger.id)}`, signingSecret });
          return true;
        }
      }

      const webhookDetail = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/webhook-triggers\/([^/]+)$/);
      if (webhookDetail && request.method === "DELETE") {
        const user = services.sessionUser(request);
        const projectId = decodeURIComponent(webhookDetail[1]);
        const triggerId = decodeURIComponent(webhookDetail[2]);
        const { project } = services.requireProjectCapability(projectId, user.id, "automation.manage");
        const result = services.database.prepare("UPDATE webhook_triggers SET archived_at = ?, enabled = 0 WHERE id = ? AND project_id = ? AND archived_at IS NULL")
          .run(now(), triggerId, projectId);
        if (result.changes === 0) throw new PlatformError(404, "WEBHOOK_TRIGGER_NOT_FOUND");
        services.audit(project.workspace_id, { type: "user", id: user.id }, "webhook_trigger.archived", { type: "webhook_trigger", id: triggerId }, {}, projectId);
        sendJson(response, 200, { triggerId, archived: true });
        return true;
      }

      const webhookAction = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/webhook-triggers\/([^/]+)\/(enable|disable)$/);
      if (webhookAction && request.method === "POST") {
        const user = services.sessionUser(request);
        const projectId = decodeURIComponent(webhookAction[1]);
        const triggerId = decodeURIComponent(webhookAction[2]);
        const action = webhookAction[3];
        const { project } = services.requireProjectCapability(projectId, user.id, "automation.manage");
        const result = services.database.prepare(`UPDATE webhook_triggers SET enabled = ? WHERE id = ? AND project_id = ?`).run(action === "enable" ? 1 : 0, triggerId, projectId);
        if (result.changes === 0) throw new PlatformError(404, "WEBHOOK_TRIGGER_NOT_FOUND");
        services.audit(project.workspace_id, { type: "user", id: user.id }, action === "enable" ? "webhook_trigger.enabled" : "webhook_trigger.disabled", { type: "webhook_trigger", id: triggerId }, {}, projectId);
        sendJson(response, 200, { triggerId, enabled: action === "enable" });
        return true;
      }

      const notificationChannelRoot = url.pathname.match(/^\/api\/platform\/workspaces\/([^/]+)\/notification-channels$/);
      if (notificationChannelRoot) {
        const user = services.sessionUser(request);
        const workspaceId = decodeURIComponent(notificationChannelRoot[1]);
        if (request.method === "GET") services.requireWorkspaceRole(workspaceId, user.id);
        else services.requireWorkspaceCapability(workspaceId, user.id, "automation.manage");
        if (request.method === "GET") {
          const channels = services.database.prepare(`SELECT id, name, channel_type, enabled, created_at, updated_at FROM notification_channels WHERE workspace_id = ? AND archived_at IS NULL ORDER BY name`).all(workspaceId) as Array<{ id: string; name: string; channel_type: NotificationChannelType; enabled: number; created_at: string; updated_at: string }>;
          sendJson(response, 200, { channels: channels.map((item) => ({ id: item.id, name: item.name, type: item.channel_type, enabled: Boolean(item.enabled), createdAt: item.created_at, updatedAt: item.updated_at })) });
          return true;
        }
        if (request.method === "POST") {
          const body = await readJson<{ name?: string; type?: NotificationChannelType; config?: Record<string, unknown> }>(request);
          const name = body.name?.trim().slice(0, 160);
          const types: NotificationChannelType[] = ["webhook", "feishu", "dingtalk", "wecom", "email"];
          if (!name || !body.type || !types.includes(body.type) || !body.config || typeof body.config.url !== "string") {
            throw new PlatformError(400, "NOTIFICATION_CHANNEL_INPUT_INVALID");
          }
          let endpoint: ValidatedNotificationTarget;
          try {
            endpoint = await services.notificationTarget(body.config.url);
          } catch {
            throw new PlatformError(400, "NOTIFICATION_URL_INVALID");
          }
          const encrypted = services.encrypt(json({ url: endpoint.url.toString(), headers: asRecord(body.config.headers) }));
          const channel = { id: randomUUID(), createdAt: now() };
          try {
            services.database.prepare(`INSERT INTO notification_channels (id, workspace_id, name, channel_type, config_iv, config_tag, config_ciphertext, enabled, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
              .run(channel.id, workspaceId, name, body.type, encrypted.iv, encrypted.tag, encrypted.ciphertext, user.id, channel.createdAt, channel.createdAt);
          } catch {
            throw new PlatformError(409, "NOTIFICATION_CHANNEL_NAME_EXISTS");
          }
          services.audit(workspaceId, { type: "user", id: user.id }, "notification_channel.created", { type: "notification_channel", id: channel.id }, { name, type: body.type });
          sendJson(response, 201, { channel: { id: channel.id, name, type: body.type, enabled: true, createdAt: channel.createdAt } });
          return true;
        }
      }

      const notificationChannelDetail = url.pathname.match(/^\/api\/platform\/workspaces\/([^/]+)\/notification-channels\/([^/]+)$/);
      if (notificationChannelDetail && request.method === "DELETE") {
        const user = services.sessionUser(request);
        const workspaceId = decodeURIComponent(notificationChannelDetail[1]);
        const channelId = decodeURIComponent(notificationChannelDetail[2]);
        services.requireWorkspaceCapability(workspaceId, user.id, "automation.manage");
        const result = services.database.prepare("UPDATE notification_channels SET archived_at = ?, enabled = 0, updated_at = ? WHERE id = ? AND workspace_id = ? AND archived_at IS NULL")
          .run(now(), now(), channelId, workspaceId);
        if (result.changes === 0) throw new PlatformError(404, "NOTIFICATION_CHANNEL_NOT_FOUND");
        services.audit(workspaceId, { type: "user", id: user.id }, "notification_channel.archived", { type: "notification_channel", id: channelId });
        sendJson(response, 200, { channelId, archived: true });
        return true;
      }

      const notificationSubscriptions = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/notification-subscriptions$/);
      if (notificationSubscriptions) {
        const user = services.sessionUser(request);
        const projectId = decodeURIComponent(notificationSubscriptions[1]);
        const { project } = request.method === "GET" ? services.requireProjectRole(projectId, user.id) : services.requireProjectCapability(projectId, user.id, "automation.manage");
        if (request.method === "GET") {
          const subscriptions = services.database.prepare(
            `SELECT s.channel_id, s.on_success, s.on_failure, c.name, c.channel_type, c.enabled
             FROM notification_subscriptions s JOIN notification_channels c ON c.id = s.channel_id
             WHERE s.project_id = ? AND c.archived_at IS NULL ORDER BY c.name`,
          ).all(projectId) as Array<{ channel_id: string; on_success: number; on_failure: number; name: string; channel_type: NotificationChannelType; enabled: number }>;
          sendJson(response, 200, { subscriptions: subscriptions.map((item) => ({ channelId: item.channel_id, name: item.name, type: item.channel_type, channelEnabled: Boolean(item.enabled), onSuccess: Boolean(item.on_success), onFailure: Boolean(item.on_failure) })) });
          return true;
        }
        if (request.method === "PUT") {
          const body = await readJson<{ channelId?: string; onSuccess?: boolean; onFailure?: boolean }>(request);
          if (!body.channelId) throw new PlatformError(400, "NOTIFICATION_SUBSCRIPTION_INPUT_INVALID");
          const channel = services.database.prepare(`SELECT id FROM notification_channels WHERE id = ? AND workspace_id = ? AND archived_at IS NULL`).get(body.channelId, project.workspace_id) as { id: string } | undefined;
          if (!channel) throw new PlatformError(404, "NOTIFICATION_CHANNEL_NOT_FOUND");
          services.database.prepare(
            `INSERT INTO notification_subscriptions (project_id, channel_id, on_success, on_failure) VALUES (?, ?, ?, ?)
             ON CONFLICT(project_id, channel_id) DO UPDATE SET on_success = excluded.on_success, on_failure = excluded.on_failure`,
          ).run(projectId, channel.id, body.onSuccess ? 1 : 0, body.onFailure === false ? 0 : 1);
          services.audit(project.workspace_id, { type: "user", id: user.id }, "notification_subscription.saved", { type: "notification_channel", id: channel.id }, { onSuccess: Boolean(body.onSuccess), onFailure: body.onFailure !== false }, projectId);
          sendJson(response, 200, { channelId: channel.id, onSuccess: Boolean(body.onSuccess), onFailure: body.onFailure !== false });
          return true;
        }
      }

      const deliveryRoute = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/deliveries$/);
      if (deliveryRoute && request.method === "GET") {
        const user = services.sessionUser(request);
        const projectId = decodeURIComponent(deliveryRoute[1]);
        services.requireProjectRole(projectId, user.id);
        const deliveries = services.database.prepare(
          `SELECT d.id, d.run_id, d.status, d.attempt_count, d.response_code, d.error, d.created_at, d.delivered_at, c.name, c.channel_type
           FROM deliveries d JOIN platform_runs r ON r.id = d.run_id JOIN notification_channels c ON c.id = d.channel_id
           WHERE r.project_id = ? ORDER BY d.created_at DESC LIMIT 200`,
        ).all(projectId) as Array<{ id: string; run_id: string; status: DeliveryStatus; attempt_count: number; response_code: number | null; error: string | null; created_at: string; delivered_at: string | null; name: string; channel_type: NotificationChannelType }>;
        sendJson(response, 200, { deliveries: deliveries.map((item) => ({ id: item.id, runId: item.run_id, status: item.status, attempts: item.attempt_count, responseCode: item.response_code, error: item.error, createdAt: item.created_at, deliveredAt: item.delivered_at, channel: { name: item.name, type: item.channel_type } })) });
        return true;
      }

      if (url.pathname === "/api/agent-tokens" && request.method === "POST") {
        const user = services.sessionUser(request);
        const body = await readJson<{ workspaceId?: string; expiresInMinutes?: number }>(request);
        if (!body.workspaceId) throw new PlatformError(400, "WORKSPACE_REQUIRED");
        services.requireWorkspaceRole(body.workspaceId, user.id, true);
        const minutes = Math.max(1, Math.min(24 * 60, Number(body.expiresInMinutes ?? 30)));
        const token = `agt_${randomBytes(24).toString("base64url")}`;
        const item = { id: randomUUID(), expiresAt: new Date(Date.now() + minutes * 60_000).toISOString() };
        services.database.prepare(`INSERT INTO agent_tokens (id, workspace_id, token_hash, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(item.id, body.workspaceId, digest(token), item.expiresAt, user.id, now());
        services.audit(body.workspaceId, { type: "user", id: user.id }, "agent_token.created", { type: "agent_token", id: item.id }, { expiresAt: item.expiresAt });
        sendJson(response, 201, { registrationToken: token, expiresAt: item.expiresAt });
        return true;
      }

      if (url.pathname === "/api/agents/register" && request.method === "POST") {
        const body = await readJson<{ registrationToken?: string; name?: string; browserVersion?: string; os?: string; maxConcurrency?: number }>(request);
        const registrationToken = body.registrationToken?.trim();
        if (!registrationToken || !body.name?.trim()) throw new PlatformError(400, "AGENT_REGISTRATION_INPUT_INVALID");
        const token = services.database.prepare(`SELECT id, workspace_id, expires_at, used_at, revoked_at FROM agent_tokens WHERE token_hash = ?`).get(digest(registrationToken)) as { id: string; workspace_id: string; expires_at: string; used_at: string | null; revoked_at: string | null } | undefined;
        if (!token || token.used_at || token.revoked_at || token.expires_at <= now()) throw new PlatformError(401, "AGENT_REGISTRATION_TOKEN_INVALID");
        const maxConcurrency = Number(body.maxConcurrency ?? 1);
        if (maxConcurrency !== 1) throw new PlatformError(400, "AGENT_SINGLE_CONCURRENCY_REQUIRED");
        const agent = { id: randomUUID(), workspaceId: token.workspace_id, name: body.name.trim().slice(0, 120), credential: `agc_${randomBytes(32).toString("base64url")}`, createdAt: now() };
        services.database.exec("BEGIN IMMEDIATE");
        try {
          const consumed = services.database.prepare(`UPDATE agent_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`).run(now(), token.id, now());
          if (consumed.changes !== 1) throw new PlatformError(401, "AGENT_REGISTRATION_TOKEN_INVALID");
          services.database.prepare(`INSERT INTO agents (id, workspace_id, name, credential_hash, status, browser_version, os, max_concurrency, created_at) VALUES (?, ?, ?, ?, 'offline', ?, ?, 1, ?)`)
            .run(agent.id, agent.workspaceId, agent.name, digest(agent.credential), body.browserVersion?.slice(0, 160) ?? "Chromium", body.os?.slice(0, 160) ?? "unknown", agent.createdAt);
          services.database.exec("COMMIT");
        } catch (error) {
          services.database.exec("ROLLBACK");
          throw error;
        }
        services.audit(agent.workspaceId, { type: "agent", id: agent.id }, "agent.registered", { type: "agent", id: agent.id }, { name: agent.name });
        sendJson(response, 201, { agent: { id: agent.id, workspaceId: agent.workspaceId, name: agent.name, status: "offline", maxConcurrency: 1 }, credential: agent.credential });
        return true;
      }

      if (url.pathname === "/api/agents" && request.method === "GET") {
        const user = services.sessionUser(request);
        const workspaceId = url.searchParams.get("workspaceId");
        if (!workspaceId) throw new PlatformError(400, "WORKSPACE_REQUIRED");
        services.requireWorkspaceRole(workspaceId, user.id);
        const agents = services.database.prepare(`SELECT id, workspace_id, name, status, browser_version, os, max_concurrency, current_task, last_seen_at, created_at FROM agents WHERE workspace_id = ? ORDER BY created_at DESC`).all(workspaceId) as Array<AgentRecord & { workspace_id: string; browser_version: string; max_concurrency: number; current_task: string | null; last_seen_at: string | null; created_at: string }>;
        sendJson(response, 200, { agents: agents.map(services.mapAgent) });
        return true;
      }

      const heartbeatRoute = url.pathname.match(/^\/api\/agents\/([^/]+)\/heartbeat$/);
      if (heartbeatRoute && request.method === "POST") {
        const agent = services.agentByCredential(authorization(request));
        if (agent.id !== decodeURIComponent(heartbeatRoute[1])) throw new PlatformError(403, "AGENT_ID_MISMATCH");
        const body = await readJson<Record<string, unknown>>(request);
        const updated = services.updateAgentHeartbeat(agent, body);
        services.dispatchWaitingRuns();
        sendJson(response, 200, { agent: updated, heartbeatIntervalSeconds: 15 });
        return true;
      }

      const agentDisableRoute = url.pathname.match(/^\/api\/agents\/([^/]+)\/(disable|revoke)$/);
      if (agentDisableRoute && request.method === "POST") {
        const user = services.sessionUser(request);
        const agentId = decodeURIComponent(agentDisableRoute[1]);
        const action = agentDisableRoute[2];
        const agent = services.database.prepare(`SELECT id, workspace_id FROM agents WHERE id = ?`).get(agentId) as { id: string; workspace_id: string } | undefined;
        if (!agent) throw new PlatformError(404, "AGENT_NOT_FOUND");
        services.requireWorkspaceRole(agent.workspace_id, user.id, true);
        services.database.prepare(`UPDATE agents SET status = 'disabled', revoked_at = CASE WHEN ? = 'revoke' THEN ? ELSE revoked_at END WHERE id = ?`).run(action, now(), agentId);
        services.sockets.get(agentId)?.close(4003, "disabled");
        services.audit(agent.workspace_id, { type: "user", id: user.id }, `agent.${action}d`, { type: "agent", id: agentId });
        sendJson(response, 200, { agentId, status: "disabled", revoked: action === "revoke" });
        return true;
      }

      const bindingRoute = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/agent-bindings$/);
      if (bindingRoute) {
        const user = services.sessionUser(request);
        const projectId = decodeURIComponent(bindingRoute[1]);
        const { project } = request.method === "GET" ? services.requireProjectRole(projectId, user.id) : services.requireProjectAdmin(projectId, user.id);
        if (request.method === "GET") {
          const bindings = services.database.prepare(`SELECT b.environment_id, a.id, a.name, a.status, a.browser_version, a.last_seen_at FROM agent_bindings b JOIN agents a ON a.id = b.agent_id WHERE b.project_id = ? AND b.is_default = 1 ORDER BY b.environment_id, a.name`).all(projectId) as Array<{ environment_id: string; id: string; name: string; status: string; browser_version: string; last_seen_at: string | null }>;
          sendJson(response, 200, { bindings: bindings.map((item) => ({ environmentId: item.environment_id, agent: { id: item.id, name: item.name, status: item.status, browserVersion: item.browser_version, lastSeenAt: item.last_seen_at } })) });
          return true;
        }
        if (request.method === "PUT") {
          const body = await readJson<{ environmentId?: string; agentId?: string }>(request);
          if (!body.environmentId || !body.agentId) throw new PlatformError(400, "AGENT_BINDING_INPUT_INVALID");
          const document = services.documentFor(projectId);
          const environments = Array.isArray(document.data.environments) ? document.data.environments.map(asRecord) : [];
          const environment = environments.find((item) => item.id === body.environmentId);
          if (!environment) throw new PlatformError(404, "ENVIRONMENT_NOT_FOUND");
          services.requireChromiumEnvironment(environment);
          const agent = services.database.prepare(`SELECT workspace_id FROM agents WHERE id = ?`).get(body.agentId) as { workspace_id: string } | undefined;
          if (!agent) throw new PlatformError(404, "AGENT_NOT_FOUND");
          if (agent.workspace_id !== project.workspace_id) throw new PlatformError(409, "AGENT_WORKSPACE_MISMATCH");
          services.database.exec("BEGIN IMMEDIATE");
          try {
            services.database.prepare(`UPDATE agent_bindings SET is_default = 0 WHERE project_id = ? AND environment_id = ?`).run(projectId, body.environmentId);
            services.database.prepare(`INSERT INTO agent_bindings (project_id, environment_id, agent_id, is_default, created_at) VALUES (?, ?, ?, 1, ?)
              ON CONFLICT(project_id, environment_id, agent_id) DO UPDATE SET is_default = 1, created_at = excluded.created_at`).run(projectId, body.environmentId, body.agentId, now());
            services.database.exec("COMMIT");
          } catch (error) {
            services.database.exec("ROLLBACK");
            throw error;
          }
          services.audit(project.workspace_id, { type: "user", id: user.id }, "agent.bound", { type: "agent", id: body.agentId }, { environmentId: body.environmentId }, projectId);
          sendJson(response, 201, { projectId, environmentId: body.environmentId, agentId: body.agentId });
          return true;
        }
      }

      const debugSessionRoot = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/debug-sessions$/);
      if (debugSessionRoot) {
        const user = services.sessionUser(request);
        const projectId = decodeURIComponent(debugSessionRoot[1]);
        const { project } = request.method === "GET" ? services.requireProjectRole(projectId, user.id) : services.requireProjectCapability(projectId, user.id, "run.execute");
        if (request.method === "GET") {
          const rows = services.database
            .prepare(`SELECT id FROM debug_sessions WHERE project_id = ? ORDER BY created_at DESC LIMIT 100`)
            .all(projectId) as Array<{ id: string }>;
          sendJson(response, 200, { sessions: rows.map((row) => services.debugSessionResponse(services.debugSessionById(row.id))) });
          return true;
        }
        if (request.method === "POST") {
          const body = await readJson<{ revisionId?: string; environmentId?: string; startUrl?: string; startStep?: number; blank?: boolean }>(request);
          const blank = body.blank === true;
          let revision: { id: string; flow_snapshot: string; environment_snapshot: string; element_snapshot: string; dataset_snapshot: string; checksum: string } | undefined;
          let environment: Record<string, unknown> | undefined;
          let environmentId = body.environmentId ?? "";
          let startUrl = "";
          if (blank) {
            // Blank session: only environment (+ optional start URL); no published revision required.
            const document = services.documentFor(projectId);
            const environments = Array.isArray(document.data.environments) ? document.data.environments.map(asRecord) : [];
            environment = environments.find((item) => item.id === environmentId) as Record<string, unknown> | undefined;
            if (!environmentId || !environment) throw new PlatformError(404, "ENVIRONMENT_NOT_FOUND");
            services.requireChromiumEnvironment(environment);
            startUrl = typeof body.startUrl === "string" ? body.startUrl.trim().slice(0, 2048) : "";
          } else {
            revision = body.revisionId
              ? services.database
                  .prepare(`SELECT id, flow_snapshot, environment_snapshot, element_snapshot, dataset_snapshot, checksum FROM flow_revisions WHERE id = ? AND project_id = ? AND status = 'published'`)
                  .get(body.revisionId, projectId) as { id: string; flow_snapshot: string; environment_snapshot: string; element_snapshot: string; dataset_snapshot: string; checksum: string } | undefined
              : services.database
                  .prepare(`SELECT id, flow_snapshot, environment_snapshot, element_snapshot, dataset_snapshot, checksum FROM flow_revisions WHERE project_id = ? AND status = 'published' ORDER BY published_at DESC LIMIT 1`)
                  .get(projectId) as { id: string; flow_snapshot: string; environment_snapshot: string; element_snapshot: string; dataset_snapshot: string; checksum: string } | undefined;
            if (!revision) throw new PlatformError(409, "PUBLISHED_REVISION_REQUIRED");
            environment = parseJson<Record<string, unknown>>(revision.environment_snapshot, {});
            environmentId = body.environmentId ?? (typeof environment.id === "string" ? environment.id : "");
            if (!environmentId) throw new PlatformError(400, "ENVIRONMENT_REQUIRED");
            services.requireRevisionEnvironment(revision, environmentId);
            services.requireChromiumEnvironment(environment);
          }
          if (!environment) throw new PlatformError(404, "ENVIRONMENT_NOT_FOUND");
          const agent = services.candidateAgent(projectId, environmentId);
          if (!agent || !services.sockets.has(agent.id)) throw new PlatformError(409, "AGENT_UNAVAILABLE");
          const snapshot = {
            flowRevisionId: revision?.id ?? null,
            flowRevisionChecksum: revision?.checksum ?? null,
            environmentId,
            flow: revision ? parseJson<Record<string, unknown>>(revision.flow_snapshot, {}) : {},
            environment,
            elements: revision ? parseJson<unknown[]>(revision.element_snapshot, []) : [],
            dataset: revision ? parseJson<unknown>(revision.dataset_snapshot, null) : null,
            secretNames: revision ? (parseJson<Record<string, unknown>>(revision.flow_snapshot, {}).secretNames ?? []) : [],
            startUrl: blank ? startUrl : undefined,
            agent: { id: agent.id, name: agent.name, browserVersion: agent.browserVersion, os: agent.os, maxConcurrency: agent.maxConcurrency },
          };
          const createdAt = now();
          const maxExpiresAt = new Date(Date.now() + debugMaxDurationMs).toISOString();
          const session = {
            id: randomUUID(),
            projectId,
            revisionId: revision?.id ?? null,
            environmentId,
            agentId: agent.id,
            currentStep: Math.max(0, Math.floor(Number(body.startStep ?? 0))),
            createdAt,
            maxExpiresAt,
          };
          services.database
            .prepare(
              `INSERT INTO debug_sessions (id, project_id, revision_id, environment_id, agent_id, status, snapshot, current_step, idle_expires_at, max_expires_at, created_by, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              session.id,
              session.projectId,
              session.revisionId,
              session.environmentId,
              session.agentId,
              json(snapshot),
              session.currentStep,
              services.nextDebugIdleExpiry(maxExpiresAt),
              session.maxExpiresAt,
              user.id,
              session.createdAt,
              session.createdAt,
            );
          const persisted = services.debugSessionById(session.id);
          if (!services.sendAgent(agent.id, services.debugSessionPayload(persisted))) {
            services.database.prepare(`DELETE FROM debug_sessions WHERE id = ?`).run(session.id);
            throw new PlatformError(409, "AGENT_UNAVAILABLE");
          }
          services.appendDebugEvent(session.id, "session.requested", { revisionId: session.revisionId, environmentId, agentId: agent.id, currentStep: session.currentStep, blank });
          services.audit(project.workspace_id, { type: "user", id: user.id }, "debug_session.created", { type: "debug_session", id: session.id }, { revisionId: session.revisionId, environmentId, agentId: agent.id, blank }, projectId);
          sendJson(response, 202, { session: services.debugSessionResponse(services.debugSessionById(session.id)) });
          return true;
        }
      }

      const debugCommandRoute = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/debug-sessions\/([^/]+)\/commands$/);
      if (debugCommandRoute && request.method === "POST") {
        const user = services.sessionUser(request);
        const projectId = decodeURIComponent(debugCommandRoute[1]);
        const sessionId = decodeURIComponent(debugCommandRoute[2]);
        const { project } = services.requireProjectRole(projectId, user.id, true);
        const session = services.debugSessionById(sessionId);
        if (session.projectId !== projectId) throw new PlatformError(404, "DEBUG_SESSION_NOT_FOUND");
        const body = await readJson<{ command?: string }>(request);
        const command = body.command;
        if (!command || !["start", "continue", "runCurrent", "skip", "pause", "retry", "stop"].includes(command)) {
          throw new PlatformError(400, "DEBUG_COMMAND_INVALID");
        }
        if (["ended", "failed", "expired"].includes(session.status)) throw new PlatformError(409, "DEBUG_SESSION_CLOSED");
        if (session.status === "requested" && command !== "stop") {
          throw new PlatformError(409, "DEBUG_SESSION_NOT_READY");
        }
        const acknowledgement = await services.sendConfirmedDebugCommand(session.agentId, sessionId, command);
        if (!acknowledgement.accepted) throw new PlatformError(acknowledgement.reason === "DEBUG_COMMAND_ACK_TIMEOUT" ? 504 : 409, acknowledgement.reason ?? "DEBUG_COMMAND_REJECTED");
        const updated = services.touchDebugSession(session, {
          status: command === "stop" ? "ending" : "active",
          currentStep: command === "start" ? 0 : session.currentStep,
        });
        services.appendDebugEvent(sessionId, "command.requested", { command, actorId: user.id });
        services.audit(project.workspace_id, { type: "user", id: user.id }, "debug_session.commanded", { type: "debug_session", id: sessionId }, { command }, projectId);
        sendJson(response, 202, { session: services.debugSessionResponse(updated) });
        return true;
      }

      const pickerEnableRoute = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/debug-sessions\/([^/]+)\/picker\/enable$/);
      if (pickerEnableRoute && request.method === "POST") {
        const user = services.sessionUser(request);
        const projectId = decodeURIComponent(pickerEnableRoute[1]);
        const sessionId = decodeURIComponent(pickerEnableRoute[2]);
        const { project } = services.requireProjectRole(projectId, user.id, true);
        const session = services.debugSessionById(sessionId);
        if (session.projectId !== projectId) throw new PlatformError(404, "DEBUG_SESSION_NOT_FOUND");
        if (["ended", "failed", "expired"].includes(session.status)) throw new PlatformError(409, "DEBUG_SESSION_CLOSED");
        if (!services.sendAgent(session.agentId, { type: "picker.enable", sessionId })) throw new PlatformError(409, "DEBUG_AGENT_DISCONNECTED");
        services.appendDebugEvent(session.id, "picker.enabled", { actorId: user.id });
        services.audit(project.workspace_id, { type: "user", id: user.id }, "picker.enabled", { type: "debug_session", id: session.id }, {}, projectId);
        sendJson(response, 202, { session: services.debugSessionResponse(session) });
        return true;
      }

      const pickerCaptureRoot = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/debug-sessions\/([^/]+)\/picker-captures$/);
      if (pickerCaptureRoot && request.method === "GET") {
        const user = services.sessionUser(request);
        const projectId = decodeURIComponent(pickerCaptureRoot[1]);
        const sessionId = decodeURIComponent(pickerCaptureRoot[2]);
        services.requireProjectRole(projectId, user.id);
        const session = services.debugSessionById(sessionId);
        if (session.projectId !== projectId) throw new PlatformError(404, "DEBUG_SESSION_NOT_FOUND");
        const captures = services.database.prepare(`SELECT id, session_id, candidates, target, status, captured_at, confirmed_at FROM picker_captures WHERE session_id = ? ORDER BY captured_at DESC LIMIT 100`)
          .all(sessionId) as Array<{ id: string; session_id: string; candidates: string; target: string; status: string; captured_at: string; confirmed_at: string | null }>;
        sendJson(response, 200, { captures: captures.map(services.pickerCaptureResponse) });
        return true;
      }

      const pickerPreviewRoute = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/debug-sessions\/([^/]+)\/picker-captures\/([^/]+)\/preview$/);
      if (pickerPreviewRoute && request.method === "POST") {
        const user = services.sessionUser(request);
        const projectId = decodeURIComponent(pickerPreviewRoute[1]);
        const sessionId = decodeURIComponent(pickerPreviewRoute[2]);
        const captureId = decodeURIComponent(pickerPreviewRoute[3]);
        services.requireProjectRole(projectId, user.id, true);
        const session = services.debugSessionById(sessionId);
        if (session.projectId !== projectId) throw new PlatformError(404, "DEBUG_SESSION_NOT_FOUND");
        const capture = services.database.prepare(`SELECT id, session_id, candidates, target, status, captured_at, confirmed_at FROM picker_captures WHERE id = ? AND session_id = ?`).get(captureId, sessionId) as { id: string; session_id: string; candidates: string; target: string; status: string; captured_at: string; confirmed_at: string | null } | undefined;
        if (!capture) throw new PlatformError(404, "PICKER_CAPTURE_NOT_FOUND");
        const body = await readJson<{ candidateIndex?: number }>(request);
        const candidates = parseJson<LocatorCandidate[]>(capture.candidates, []);
        const candidateIndex = Number(body.candidateIndex);
        const candidate = candidates[candidateIndex];
        if (!Number.isInteger(candidateIndex) || !candidate) throw new PlatformError(400, "PICKER_CANDIDATE_INVALID");
        if (!services.sendAgent(session.agentId, { type: "picker.preview", sessionId, captureId, candidateIndex, candidate })) throw new PlatformError(409, "DEBUG_AGENT_DISCONNECTED");
        sendJson(response, 202, { capture: services.pickerCaptureResponse(capture), candidateIndex });
        return true;
      }

      const pickerConfirmRoute = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/debug-sessions\/([^/]+)\/picker-captures\/([^/]+)\/confirm$/);
      if (pickerConfirmRoute && request.method === "POST") {
        const user = services.sessionUser(request);
        const projectId = decodeURIComponent(pickerConfirmRoute[1]);
        const sessionId = decodeURIComponent(pickerConfirmRoute[2]);
        const captureId = decodeURIComponent(pickerConfirmRoute[3]);
        const { project } = services.requireProjectRole(projectId, user.id, true);
        const session = services.debugSessionById(sessionId);
        if (session.projectId !== projectId) throw new PlatformError(404, "DEBUG_SESSION_NOT_FOUND");
        const capture = services.database.prepare(`SELECT id, session_id, candidates, target, status, captured_at, confirmed_at FROM picker_captures WHERE id = ? AND session_id = ?`).get(captureId, sessionId) as { id: string; session_id: string; candidates: string; target: string; status: string; captured_at: string; confirmed_at: string | null } | undefined;
        if (!capture) throw new PlatformError(404, "PICKER_CAPTURE_NOT_FOUND");
        if (capture.status !== "pending") throw new PlatformError(409, "PICKER_CAPTURE_ALREADY_CONFIRMED");
        const body = await readJson<{ candidateIndex?: number; target?: "element" | "step"; name?: string; flowId?: string; stepId?: string }>(request);
        const candidates = parseJson<LocatorCandidate[]>(capture.candidates, []);
        const candidateIndex = Number(body.candidateIndex);
        const candidate = candidates[candidateIndex];
        if (!Number.isInteger(candidateIndex) || !candidate || (body.target !== "element" && body.target !== "step")) throw new PlatformError(400, "PICKER_CONFIRMATION_INVALID");
        const document = services.documentFor(projectId);
        const elements: unknown[] = Array.isArray(document.data.elements) ? [...document.data.elements] : [];
        const elementName = body.name?.trim().slice(0, 160) || capture.target || candidate.label;
        let path = "/";
        try {
          path = session.currentUrl ? new URL(session.currentUrl).pathname || "/" : "/";
        } catch {
          path = "/";
        }
        const element = {
          id: `element-${randomUUID()}`,
          name: elementName,
          description: "Captured from a debug browser session",
          path,
          method: candidate.method,
          value: candidate.value,
          environment: session.environmentId,
          validation: candidate.count === 1 ? "verified" : "unverified",
          updatedAt: now(),
        };
        elements.push(element);
        const nextData: Record<string, unknown> = { ...document.data, elements };
        if (body.target === "step") {
          const flows: Array<Record<string, unknown>> = Array.isArray(document.data.flows)
            ? document.data.flows.map((flow: unknown) => asRecord(flow))
            : [];
          const flow = flows.find((item) => item.id === body.flowId);
          if (!flow || !body.stepId) throw new PlatformError(400, "PICKER_STEP_TARGET_REQUIRED");
          const steps: Array<Record<string, unknown>> = Array.isArray(flow.steps)
            ? flow.steps.map((step: unknown) => asRecord(step))
            : [];
          const stepIndex = steps.findIndex((step) => step.id === body.stepId);
          if (stepIndex < 0) throw new PlatformError(404, "FLOW_STEP_NOT_FOUND");
          steps[stepIndex] = { ...steps[stepIndex], element: element.name };
          flow.steps = steps;
          nextData.flows = flows;
        }
        const saved = services.putDocument(projectId, nextData, document.version);
        services.database.prepare(`UPDATE picker_captures SET status = 'confirmed', confirmed_at = ? WHERE id = ?`).run(now(), capture.id);
        services.appendDebugEvent(session.id, "picker.confirmed", { captureId: capture.id, candidateIndex, target: body.target, elementId: element.id });
        services.audit(project.workspace_id, { type: "user", id: user.id }, "picker.confirmed", { type: "element", id: element.id }, { captureId: capture.id, candidateIndex, target: body.target, documentVersion: saved.version }, projectId);
        sendJson(response, 201, { element, documentVersion: saved.version, target: body.target });
        return true;
      }

      const debugSessionDetail = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/debug-sessions\/([^/]+)$/);
      if (debugSessionDetail && request.method === "GET") {
        const user = services.sessionUser(request);
        const projectId = decodeURIComponent(debugSessionDetail[1]);
        const sessionId = decodeURIComponent(debugSessionDetail[2]);
        services.requireProjectRole(projectId, user.id);
        const session = services.debugSessionById(sessionId);
        if (session.projectId !== projectId) throw new PlatformError(404, "DEBUG_SESSION_NOT_FOUND");
        sendJson(response, 200, { session: services.debugSessionResponse(session) });
        return true;
      }

      const debugArtifactUpload = url.pathname.match(/^\/api\/agents\/([^/]+)\/debug-sessions\/([^/]+)\/artifacts$/);
      if (debugArtifactUpload && request.method === "POST") {
        const agent = services.agentByCredential(authorization(request));
        if (agent.id !== decodeURIComponent(debugArtifactUpload[1])) throw new PlatformError(403, "AGENT_ID_MISMATCH");
        const session = services.agentOwnsDebugSession(agent.id, decodeURIComponent(debugArtifactUpload[2]));
        if (["ended", "failed", "expired"].includes(session.status)) throw new PlatformError(409, "DEBUG_SESSION_CLOSED");
        const body = await readJson<{ name?: string; contentType?: string; contentBase64?: string }>(request, 26_000_000);
        if (!body.contentBase64) throw new PlatformError(400, "ARTIFACT_CONTENT_REQUIRED");
        const content = Buffer.from(body.contentBase64, "base64");
        if (content.length === 0 || content.length > 18_000_000) throw new PlatformError(413, "ARTIFACT_TOO_LARGE");
        await mkdir(platformArtifactDirectory, { recursive: true });
        const artifact = { id: randomUUID(), name: safeArtifactName(body.name ?? "debug-artifact.bin"), contentType: body.contentType?.replace(/[^\x21-\x7e]/g, "").slice(0, 120) ?? "application/octet-stream" };
        const path = join(platformArtifactDirectory, `${artifact.id}-${artifact.name}`);
        await writeFile(path, content);
        try {
          services.database.prepare(`INSERT INTO debug_artifacts (id, session_id, project_id, name, content_type, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(artifact.id, session.id, session.projectId, artifact.name, artifact.contentType, path, now());
        } catch (error) {
          await rm(path, { force: true }).catch(() => undefined);
          throw error;
        }
        services.appendDebugEvent(session.id, "artifact.uploaded", { artifactId: artifact.id, name: artifact.name });
        sendJson(response, 201, { artifact: { id: artifact.id, name: artifact.name, contentType: artifact.contentType } });
        return true;
      }

      const debugArtifact = url.pathname.match(/^\/api\/platform\/debug-artifacts\/([^/]+)$/);
      if (debugArtifact && request.method === "GET") {
        const user = services.sessionUser(request);
        const artifact = services.database.prepare(`SELECT id, name, content_type, path, project_id FROM debug_artifacts WHERE id = ?`).get(decodeURIComponent(debugArtifact[1])) as { id: string; name: string; content_type: string; path: string; project_id: string } | undefined;
        if (!artifact) throw new PlatformError(404, "ARTIFACT_NOT_FOUND");
        services.requireProjectRole(artifact.project_id, user.id);
        response.writeHead(200, { "content-type": artifact.content_type, "content-disposition": `inline; filename="${safeArtifactName(artifact.name)}"` });
        createReadStream(artifact.path).on("error", () => response.destroy()).pipe(response);
        return true;
      }

      const platformRunRoot = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/runs$/);
      if (platformRunRoot) {
        const user = services.sessionUser(request);
        const projectId = decodeURIComponent(platformRunRoot[1]);
        const { project } = request.method === "GET" ? services.requireProjectRole(projectId, user.id) : services.requireProjectCapability(projectId, user.id, "run.execute");
        if (request.method === "GET") {
          const rows = services.database.prepare(`SELECT id FROM platform_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT 200`).all(projectId) as Array<{ id: string }>;
          sendJson(response, 200, { runs: rows.map((row) => services.runResponse(services.runById(row.id))) });
          return true;
        }
        if (request.method === "POST") {
          const body = await readJson<{ revisionId?: string; environmentId?: string; datasetVersionId?: string; upToStepId?: string }>(request);
          const queued = services.queuePublishedRuns({ projectId, revisionId: body.revisionId, environmentId: body.environmentId, datasetVersionId: body.datasetVersionId, upToStepId: body.upToStepId, createdBy: user.id, source: "manual" });
          const runs = queued.runIds.map((runId) => services.runResponse(services.runById(runId)));
          services.audit(project.workspace_id, { type: "user", id: user.id }, "run.created", { type: "run_batch", id: queued.runIds[0] ?? randomUUID() }, { revisionId: queued.revision.id, environmentId: queued.environmentId, datasetVersionId: queued.datasetVersionId, runIds: queued.runIds }, projectId);
          sendJson(response, 202, { run: runs[0], runs, runIds: queued.runIds, leaseOffered: runs.some((run) => run.status === "dispatched") });
          return true;
        }
      }

      const validationRoot = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/element-validations$/);
      if (validationRoot) {
        const user = services.sessionUser(request);
        const projectId = decodeURIComponent(validationRoot[1]);
        const { project } = request.method === "GET" ? services.requireProjectRole(projectId, user.id) : services.requireProjectCapability(projectId, user.id, "run.execute");
        if (request.method === "POST") {
          const body = await readJson<{ environmentId?: string; element?: Record<string, unknown> }>(request);
          if (!body.environmentId || !body.element) throw new PlatformError(400, "ELEMENT_VALIDATION_INPUT_INVALID");
          const element = asRecord(body.element);
          const validation = services.createElementValidation(projectId, body.environmentId, element, user.id);
          services.audit(project.workspace_id, { type: "user", id: user.id }, "element.validation_started", { type: "element_validation", id: validation.id }, { environmentId: body.environmentId, elementId: body.element.id }, projectId);
          sendJson(response, 202, { validation });
          return true;
        }
      }

      const validationArtifact = url.pathname.match(/^\/api\/platform\/validation-artifacts\/([^/]+)$/);
      if (validationArtifact && request.method === "GET") {
        const user = services.sessionUser(request);
        const artifact = services.database.prepare("SELECT id, name, content_type, path, project_id FROM element_validation_artifacts WHERE id = ?")
          .get(decodeURIComponent(validationArtifact[1])) as { id: string; name: string; content_type: string; path: string; project_id: string } | undefined;
        if (!artifact) throw new PlatformError(404, "ARTIFACT_NOT_FOUND");
        services.requireProjectRole(artifact.project_id, user.id);
        response.writeHead(200, { "content-type": artifact.content_type, "content-disposition": `inline; filename="${safeArtifactName(artifact.name)}"` });
        createReadStream(artifact.path).on("error", () => response.destroy()).pipe(response);
        return true;
      }

      const validationDetail = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/element-validations\/([^/]+)$/);
      if (validationDetail && request.method === "GET") {
        const user = services.sessionUser(request);
        const projectId = decodeURIComponent(validationDetail[1]);
        services.requireProjectRole(projectId, user.id);
        const validation = services.elementValidationById(decodeURIComponent(validationDetail[2]));
        if (validation.projectId !== projectId) throw new PlatformError(404, "ELEMENT_VALIDATION_NOT_FOUND");
        sendJson(response, 200, { validation });
        return true;
      }

      const platformRunDetail = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/runs\/([^/]+)(?:\/(cancel|retry))?$/);
      if (platformRunDetail) {
        const user = services.sessionUser(request);
        const projectId = decodeURIComponent(platformRunDetail[1]);
        const runId = decodeURIComponent(platformRunDetail[2]);
        const action = platformRunDetail[3];
        if (request.method === "GET") services.requireProjectRole(projectId, user.id);
        else services.requireProjectCapability(projectId, user.id, "run.execute");
        const run = services.runById(runId);
        if (run.projectId !== projectId) throw new PlatformError(404, "RUN_NOT_FOUND");
        if (request.method === "GET" && !action) {
          sendJson(response, 200, { run: services.runResponse(run) });
          return true;
        }
        if (request.method === "POST" && action === "cancel") {
          const executor = services.database.prepare("SELECT executor_type FROM platform_runs WHERE id = ?").get(run.id) as { executor_type: string };
          services.database.prepare(`UPDATE platform_runs SET cancellation_requested = 1, status = CASE WHEN status = 'queued' THEN 'canceled' ELSE status END, updated_at = ? WHERE id = ?`).run(now(), run.id);
          if (executor.executor_type === "managed") services.cancelManagedRun(run.id);
          else {
            const lease = services.activeLeaseForRun(run.id);
            if (lease) services.sendAgent(lease.agentId, { type: "run.cancel", leaseId: lease.id, runId: run.id });
          }
          services.appendRunEvent(run.id, "run.cancel_requested", { actorId: user.id });
          sendJson(response, 202, { run: services.runResponse(services.runById(run.id)) });
          return true;
        }
        if (request.method === "POST" && action === "retry") {
          if (!["failed", "canceled"].includes(run.status)) throw new PlatformError(409, "RUN_NOT_RETRYABLE");
          const queued = services.queuePublishedRuns({ projectId, revisionId: run.revisionId, environmentId: run.environmentId, createdBy: user.id, source: "manual" });
          services.database.prepare("UPDATE platform_runs SET retry_of_run_id = ? WHERE id = ?").run(run.id, queued.runIds[0]);
          services.appendRunEvent(queued.runIds[0], "run.retried", { priorRunId: run.id, actorId: user.id });
          sendJson(response, 202, { runIds: queued.runIds, runs: queued.runIds.map((id) => services.runResponse(services.runById(id))) });
          return true;
        }
      }

      const uploadRoute = url.pathname.match(/^\/api\/agents\/([^/]+)\/leases\/([^/]+)\/artifacts$/);
      if (uploadRoute && request.method === "POST") {
        const agent = services.agentByCredential(authorization(request));
        if (agent.id !== decodeURIComponent(uploadRoute[1])) throw new PlatformError(403, "AGENT_ID_MISMATCH");
        const lease = services.activeLeaseForAgent(agent.id, decodeURIComponent(uploadRoute[2]));
        if (!lease) throw new PlatformError(409, "LEASE_NOT_ACTIVE");
        const body = await readJson<{ name?: string; contentType?: string; contentBase64?: string }>(request, 26_000_000);
        if (!body.contentBase64) throw new PlatformError(400, "ARTIFACT_CONTENT_REQUIRED");
        const content = Buffer.from(body.contentBase64, "base64");
        if (content.length === 0 || content.length > 18_000_000) throw new PlatformError(413, "ARTIFACT_TOO_LARGE");
        const run = services.runById(lease.runId);
        await mkdir(platformArtifactDirectory, { recursive: true });
        const artifact = { id: randomUUID(), name: safeArtifactName(body.name ?? "artifact.bin"), contentType: body.contentType?.replace(/[^\x21-\x7e]/g, "").slice(0, 120) ?? "application/octet-stream" };
        const path = join(platformArtifactDirectory, `${artifact.id}-${artifact.name}`);
        await writeFile(path, content);
        try {
          services.database.prepare(`INSERT INTO platform_artifacts (id, run_id, project_id, name, content_type, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(artifact.id, run.id, run.projectId, artifact.name, artifact.contentType, path, now());
        } catch (error) {
          await rm(path, { force: true }).catch(() => undefined);
          throw error;
        }
        services.appendRunEvent(run.id, "artifact.uploaded", { artifactId: artifact.id, name: artifact.name });
        sendJson(response, 201, { artifact: { id: artifact.id, name: artifact.name, contentType: artifact.contentType } });
        return true;
      }

      const platformArtifact = url.pathname.match(/^\/api\/platform\/artifacts\/([^/]+)$/);
      if (platformArtifact && request.method === "GET") {
        const user = services.sessionUser(request);
        const artifactId = decodeURIComponent(platformArtifact[1]);
        const artifact = services.database.prepare(`SELECT a.id, a.name, a.content_type, a.path, a.project_id FROM platform_artifacts a WHERE a.id = ?`).get(artifactId) as { id: string; name: string; content_type: string; path: string; project_id: string } | undefined;
        if (!artifact) throw new PlatformError(404, "ARTIFACT_NOT_FOUND");
        services.requireProjectRole(artifact.project_id, user.id);
        response.writeHead(200, { "content-type": artifact.content_type, "content-disposition": `inline; filename="${safeArtifactName(artifact.name)}"` });
        createReadStream(artifact.path).on("error", () => response.destroy()).pipe(response);
        return true;
      }

      return false;
  }, {
    rateLimit: {
      windowMs: 60_000,
      max: 10,
      key: (request, url) => url.pathname === "/api/auth/login" ? request.socket.remoteAddress ?? "unknown" : undefined,
    },
    errorResponse: { internalCode: "PLATFORM_INTERNAL_ERROR" },
  });

  function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    if (url.pathname !== "/api/agents/connect") return false;
    try {
      const agent = services.agentByCredential(authorization(request));
      if (url.searchParams.get("agentId") !== agent.id) throw new PlatformError(403, "AGENT_ID_MISMATCH");
      services.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        services.webSocketServer.emit("connection", webSocket, request, agent);
      });
      return true;
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return true;
    }
  }

  return { handle: handle as PlatformApi["handle"], handleUpgrade };
}
