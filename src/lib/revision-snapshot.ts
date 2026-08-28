import type { ElementAsset, Environment, Flow, FlowStep, Variable } from "./mock-data";

const stepKeys = [
  "id",
  "action",
  "element",
  "value",
  "timeout",
  "failurePolicy",
  "assertMatch",
  "assertVisibility",
  "assertOperator",
  "assertAttribute",
  "trimCompare",
  "output",
  "outputSource",
  "outputAttribute",
  "outputParameter",
  "responseUrl",
  "outputPath",
  "outputPublic",
] as const;

const environmentKeys = [
  "id",
  "baseUrl",
  "browser",
  "auth",
  "timeout",
  "testIdAttribute",
  "keepBrowserOpenOnFailure",
  "headless",
] as const;

function pick<T extends Record<string, unknown>, K extends readonly string[]>(
  value: T,
  keys: K,
) {
  return Object.fromEntries(
    keys
      .filter((key) => key in value)
      .map((key) => [key, value[key]]),
  ) as Record<K[number], T[K[number]]>;
}

export function canonicalStep(step: FlowStep) {
  return pick(step as unknown as Record<string, unknown>, stepKeys);
}

export function variableReference(variable: Variable) {
  return `${variable.scope === "环境" ? "env" : "project"}.${variable.name}`;
}

export function requiredSecretVariables(variables: Variable[], steps: FlowStep[]) {
  return variables.filter((variable) => {
    if (!variable.secret || (variable.scope !== "环境" && variable.scope !== "项目")) return false;
    const reference = variableReference(variable).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const token = new RegExp(`{{\\s*${reference}\\s*}}`);
    return steps.some((step) => token.test(step.value));
  });
}

export function snapshotVariables(variables: Variable[]) {
  return Object.fromEntries(
    variables
      .filter((variable) => !variable.secret && (variable.scope === "项目" || variable.scope === "环境"))
      .map((variable) => [variableReference(variable), variable.value]),
  );
}

export function revisionFlow(flow: Flow, variables: Record<string, string>) {
  return {
    id: flow.id,
    name: flow.name,
    description: flow.description,
    steps: (flow.definition ?? []).map(canonicalStep),
    variables,
  };
}

export function revisionEnvironment(environment: Environment) {
  return pick(environment as unknown as Record<string, unknown>, environmentKeys);
}

export function revisionElements(elements: ElementAsset[]) {
  return [...elements]
    .sort((left, right) => {
      if (left.id !== right.id) return left.id.localeCompare(right.id);
      if (left.name !== right.name) return left.name.localeCompare(right.name);
      return left.value.localeCompare(right.value);
    })
    .map((element) => ({
      id: element.id,
      name: element.name,
      path: element.path,
      method: element.method,
      value: element.value,
      environment: element.environment,
    }));
}

export function revisionInput(
  flow: Flow,
  environment: Environment,
  elements: ElementAsset[],
  variables: Variable[],
) {
  return {
    flow: revisionFlow(flow, snapshotVariables(variables)),
    environment: revisionEnvironment(environment),
    elements: revisionElements(
      elements.filter((e) => !e.environment || e.environment === environment.id),
    ),
    secretNames: requiredSecretVariables(variables, flow.definition ?? []).map(variableReference),
  };
}
