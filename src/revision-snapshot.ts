import type { ElementAsset, Environment, Flow, FlowStep } from "./mock-data";

const stepKeys = [
  "id",
  "action",
  "element",
  "value",
  "timeout",
  "failurePolicy",
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
