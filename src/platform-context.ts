import { platformCapabilities } from "./platform-api";
import type { PlatformCapability, PlatformSession, PlatformWorkspaceRole } from "./platform-api";

export const platformSessionStorageKey = "autoflow-platform-session";
export const platformProjectMapStorageKey = "autoflow-platform-project-map";
export const platformWorkspaceStorageKey = "autoflow-platform-workspace";
export const platformDocumentVersionsStorageKey = "autoflow-platform-document-versions";
export const platformContextChangedEvent = "autoflow-platform-context-changed";

type ProjectMaps = Record<string, Record<string, string>>;
type DocumentVersionMaps = Record<string, Record<string, number>>;
const workspaceRoles = new Set<PlatformWorkspaceRole>(["super_admin", "admin", "member"]);
const knownCapabilities = new Set<PlatformCapability>(platformCapabilities);

function isPlatformSession(value: unknown): value is PlatformSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const user = candidate.user;
  if (!user || typeof user !== "object" || Array.isArray(user)) return false;
  const userRecord = user as Record<string, unknown>;
  if (
    typeof candidate.token !== "string" ||
    typeof userRecord.id !== "string" ||
    typeof userRecord.email !== "string" ||
    typeof userRecord.name !== "string" ||
    (userRecord.globalRole !== null && userRecord.globalRole !== "super_admin") ||
    !Array.isArray(candidate.workspaces)
  ) {
    return false;
  }
  return candidate.workspaces.every((workspace) => {
    if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) return false;
    const item = workspace as Record<string, unknown>;
    return (
      typeof item.id === "string" &&
      typeof item.name === "string" &&
      typeof item.role === "string" &&
      workspaceRoles.has(item.role as PlatformWorkspaceRole) &&
      Array.isArray(item.capabilities) &&
      item.capabilities.every(
        (capability) => typeof capability === "string" && knownCapabilities.has(capability as PlatformCapability),
      )
    );
  });
}

export function readStoredPlatformSession() {
  try {
    const session: unknown = JSON.parse(localStorage.getItem(platformSessionStorageKey) ?? "");
    return isPlatformSession(session) ? session : undefined;
  } catch {
    return undefined;
  }
}

export function storePlatformSession(session?: PlatformSession) {
  if (session) localStorage.setItem(platformSessionStorageKey, JSON.stringify(session));
  else localStorage.removeItem(platformSessionStorageKey);
  notifyPlatformContextChanged();
}

export function readStoredPlatformWorkspaceId(session = readStoredPlatformSession()) {
  const stored = localStorage.getItem(platformWorkspaceStorageKey) ?? "";
  if (session?.workspaces.some((workspace) => workspace.id === stored)) return stored;
  return session?.workspaces[0]?.id ?? "";
}

export function storePlatformWorkspaceId(workspaceId: string) {
  localStorage.setItem(platformWorkspaceStorageKey, workspaceId);
}

function allDocumentVersions(): DocumentVersionMaps {
  try {
    const value = JSON.parse(localStorage.getItem(platformDocumentVersionsStorageKey) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(value).flatMap(([workspaceId, versions]) => (
        versions && typeof versions === "object" && !Array.isArray(versions)
          ? [[workspaceId, Object.fromEntries(
            Object.entries(versions).flatMap(([projectId, version]) => (
              typeof version === "number" && Number.isInteger(version) && version >= 0
                ? [[projectId, version]]
                : []
            )),
          )]]
          : []
      )),
    );
  } catch {
    return {};
  }
}

export function readPlatformDocumentVersion(projectId: string, workspaceId = readStoredPlatformWorkspaceId()) {
  return allDocumentVersions()[workspaceId]?.[projectId];
}

export function storePlatformDocumentVersion(projectId: string, version: number, workspaceId = readStoredPlatformWorkspaceId()) {
  if (!workspaceId || !Number.isInteger(version) || version < 0) return;
  const versions = allDocumentVersions();
  versions[workspaceId] = { ...(versions[workspaceId] ?? {}), [projectId]: version };
  localStorage.setItem(platformDocumentVersionsStorageKey, JSON.stringify(versions));
}

export function notifyPlatformContextChanged() {
  window.dispatchEvent(new Event(platformContextChangedEvent));
}

export function platformProjectContext(projectId: string) {
  const session = readStoredPlatformSession();
  const workspaceId = readStoredPlatformWorkspaceId(session);
  const mappedProjectId = readPlatformProjectMap(workspaceId)[projectId] ?? projectId;
  return session?.token && workspaceId && mappedProjectId ? { session, workspaceId, projectId: mappedProjectId } : undefined;
}
function allProjectMaps(session = readStoredPlatformSession()): ProjectMaps {
  try {
    const value = JSON.parse(localStorage.getItem(platformProjectMapStorageKey) ?? "{}") as Record<string, unknown>;
    if (Object.values(value).every((item) => typeof item === "string")) {
      const workspaceId = readStoredPlatformWorkspaceId(session);
      return workspaceId ? { [workspaceId]: value as Record<string, string> } : {};
    }
    return Object.fromEntries(
      Object.entries(value).flatMap(([workspaceId, mappings]) => (
        mappings && typeof mappings === "object" && !Array.isArray(mappings)
          ? [[workspaceId, Object.fromEntries(Object.entries(mappings).filter(([, projectId]) => typeof projectId === "string"))]]
          : []
      )),
    );
  } catch {
    return {};
  }
}

export function readPlatformProjectMap(workspaceId = readStoredPlatformWorkspaceId()) {
  return allProjectMaps()[workspaceId] ?? {};
}

export function storePlatformProjectMap(projectMap: Record<string, string>, workspaceId = readStoredPlatformWorkspaceId()) {
  if (!workspaceId) return;
  const maps = allProjectMaps();
  maps[workspaceId] = projectMap;
  localStorage.setItem(platformProjectMapStorageKey, JSON.stringify(maps));
}
