import type { PlatformSession } from "./platform-api";

export const platformSessionStorageKey = "autoflow-platform-session";
export const platformProjectMapStorageKey = "autoflow-platform-project-map";
export const platformWorkspaceStorageKey = "autoflow-platform-workspace";
export const platformDocumentVersionsStorageKey = "autoflow-platform-document-versions";
export const platformContextChangedEvent = "autoflow-platform-context-changed";

type ProjectMaps = Record<string, Record<string, string>>;
type DocumentVersionMaps = Record<string, Record<string, number>>;

export function readStoredPlatformSession() {
  try {
    const session = JSON.parse(localStorage.getItem(platformSessionStorageKey) ?? "") as PlatformSession;
    return session.token && Array.isArray(session.workspaces) ? session : undefined;
  } catch {
    return undefined;
  }
}

export function readStoredPlatformWorkspaceId(session = readStoredPlatformSession()) {
  const stored = localStorage.getItem(platformWorkspaceStorageKey) ?? "";
  if (session?.workspaces.some((workspace) => workspace.id === stored)) return stored;
  return session?.workspaces[0]?.id ?? "";
}

export function storePlatformWorkspaceId(workspaceId: string) {
  localStorage.setItem(platformWorkspaceStorageKey, workspaceId);
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

export function platformProjectContext(localProjectId: string) {
  const session = readStoredPlatformSession();
  const workspaceId = readStoredPlatformWorkspaceId(session);
  const projectId = readPlatformProjectMap(workspaceId)[localProjectId];
  return session?.token && workspaceId && projectId ? { session, workspaceId, projectId } : undefined;
}
