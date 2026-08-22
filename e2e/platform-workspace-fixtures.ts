import type { Page } from "@playwright/test";

type ResourceType = "flows" | "elements" | "variables" | "environments";
type WorkspaceProject = {
  id: string;
  workspaceId: string;
  sourceProjectId: string;
  slug: string;
  name: string;
  description: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type ProjectDocument = {
  name: string;
  description: string;
  flows: Array<Record<string, unknown>>;
  elements: Array<Record<string, unknown>>;
  variables: Array<Record<string, unknown>>;
  environments: Array<Record<string, unknown>>;
  activeEnvironmentId: string;
  members: Array<Record<string, unknown>>;
};

const resourceTypes: ResourceType[] = ["flows", "elements", "variables", "environments"];

export async function installPlatformWorkspaceMock(page: Page) {
  const workspaceId = "test-workspace";
  const projectId = "project";
  let project: WorkspaceProject | undefined;
  let document: ProjectDocument = {
    name: "",
    description: "",
    flows: [],
    elements: [],
    variables: [],
    environments: [],
    activeEnvironmentId: "",
    members: [],
  };
  let version = 1;
  let settingsVersion = 1;

  const now = "2030-01-01T00:00:00.000Z";
  const resourceResponse = (type: ResourceType) => ({
    resources: document[type].map((data) => ({
      id: String(data.id),
      data,
      version,
      archivedAt: null,
      updatedAt: now,
      updatedBy: "playwright-user",
    })),
  });

  await page.route("**/api/workspaces/*/projects**", async (route) => {
    if (route.request().method() === "POST") {
      const input = route.request().postDataJSON() as { name?: string; description?: string };
      project = {
        id: projectId,
        workspaceId,
        sourceProjectId: "project",
        slug: "project",
        name: String(input.name ?? "Platform project"),
        description: String(input.description ?? ""),
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      document = {
        ...document,
        name: project.name,
        description: project.description,
      };
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ project }) });
      return;
    }
    const archived = new URL(route.request().url()).searchParams.get("archived") === "1";
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ projects: project && (archived || !project.archivedAt) ? [project] : [] }),
    });
  });

  await page.route(`**/api/platform/projects/${projectId}`, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }
    const input = route.request().postDataJSON() as { name?: string; description?: string; archived?: boolean };
    if (project) {
      project = {
        ...project,
        name: String(input.name ?? project.name),
        description: String(input.description ?? project.description),
        archivedAt: input.archived ? now : null,
        updatedAt: now,
      };
      document = { ...document, name: project.name, description: project.description };
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ project }) });
  });

  await page.route(`**/api/platform/projects/${projectId}/resources/**`, async (route) => {
    const url = new URL(route.request().url());
    const marker = `/resources/`;
    const suffix = url.pathname.split(marker)[1] ?? "";
    const [typeValue, resourceId] = suffix.split("/");
    if (!resourceTypes.includes(typeValue as ResourceType)) {
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "NOT_FOUND" }) });
      return;
    }
    const type = typeValue as ResourceType;
    if (route.request().method() === "GET") {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(resourceResponse(type)) });
      return;
    }
    if (route.request().method() === "POST") {
      const input = route.request().postDataJSON() as { id?: string; data?: Record<string, unknown> };
      const data = { ...(input.data ?? {}), id: String(input.id ?? input.data?.id ?? `${type}-1`) };
      document = { ...document, [type]: [...document[type], data] };
      version += 1;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ resource: { id: data.id, data, version, archivedAt: null, updatedAt: now, updatedBy: "playwright-user" } }) });
      return;
    }
    if (route.request().method() === "PUT" && resourceId) {
      const input = route.request().postDataJSON() as { data?: Record<string, unknown> };
      const data = { ...(input.data ?? {}), id: resourceId };
      document = { ...document, [type]: document[type].map((item) => String(item.id) === resourceId ? data : item) };
      version += 1;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ resource: { id: resourceId, data, version, archivedAt: null, updatedAt: now, updatedBy: "playwright-user" } }) });
      return;
    }
    if (route.request().method() === "DELETE" && resourceId) {
      document = { ...document, [type]: document[type].filter((item) => String(item.id) !== resourceId) };
      version += 1;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ id: resourceId, archived: true, version }) });
      return;
    }
    await route.continue();
  });

  await page.route(`**/api/platform/projects/${projectId}/settings`, async (route) => {
    if (route.request().method() === "PUT") {
      const input = route.request().postDataJSON() as { data?: Record<string, unknown> };
      document = { ...document, activeEnvironmentId: typeof input.data?.activeEnvironmentId === "string" ? input.data.activeEnvironmentId : document.activeEnvironmentId };
      settingsVersion += 1;
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ settings: { data: { activeEnvironmentId: document.activeEnvironmentId }, version: settingsVersion, updatedAt: now, updatedBy: "playwright-user" } }) });
  });

  await page.route(`**/api/platform/projects/${projectId}/document`, async (route) => {
    if (route.request().method() === "PUT") {
      const input = route.request().postDataJSON() as { data?: ProjectDocument };
      if (input.data) document = input.data;
      version += 1;
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: document, version }) });
  });

  // Flow pages load published revisions immediately. The run fixture installed
  // later replaces this empty baseline with the revisions it owns.
  await page.route(`**/api/platform/projects/${projectId}/revisions`, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ revisions: [] }),
    });
  });

  return { workspaceId, projectId };
}
