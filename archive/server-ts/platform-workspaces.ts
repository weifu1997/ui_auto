export type Role = "owner" | "admin" | "publisher" | "product" | "tester" | "operations" | "editor" | "viewer";
export type Capability =
  | "project.view" | "project.edit" | "flow.edit" | "element.manage"
  | "variable.manage" | "environment.manage" | "secret.manage"
  | "release.submit" | "release.publish" | "run.execute"
  | "dataset.manage" | "automation.manage" | "member.manage";

const allCapabilities: Capability[] = [
  "project.view", "project.edit", "flow.edit", "element.manage", "variable.manage",
  "environment.manage", "secret.manage", "release.submit", "release.publish",
  "run.execute", "dataset.manage", "automation.manage", "member.manage",
];

const roleCapabilities: Record<Role, Capability[]> = {
  owner: allCapabilities,
  admin: allCapabilities,
  publisher: ["project.view", "project.edit", "flow.edit", "element.manage", "variable.manage", "environment.manage", "secret.manage", "release.submit", "release.publish", "run.execute", "dataset.manage", "automation.manage"],
  product: ["project.view", "project.edit", "flow.edit", "variable.manage", "release.submit"],
  tester: ["project.view", "flow.edit", "element.manage", "variable.manage", "environment.manage", "secret.manage", "release.submit", "run.execute", "dataset.manage"],
  operations: ["project.view", "run.execute", "dataset.manage", "automation.manage"],
  editor: ["project.view", "project.edit", "flow.edit", "element.manage", "variable.manage", "environment.manage", "release.submit", "run.execute", "dataset.manage"],
  viewer: ["project.view"],
};

export function roleHasCapability(role: Role, capability: Capability) {
  return roleCapabilities[role].includes(capability);
}
