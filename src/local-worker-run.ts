import type { ElementAsset, Environment, FlowStep, Variable } from "./mock-data";
import type { RunRequest } from "./worker-api";

function variableReference(variable: Variable) {
  return `${variable.scope === "环境" ? "env" : "project"}.${variable.name}`;
}

export function localWorkerRunRequest(input: {
  environment: Environment;
  flow: { id: string; name: string };
  steps: FlowStep[];
  elements: ElementAsset[];
  variables: Variable[];
  secretValues: Record<string, string>;
  secretVariables: Variable[];
  upToStepId?: string;
}): RunRequest {
  const scopedVariables = input.variables.filter(
    (variable) => variable.scope === "环境" || variable.scope === "项目",
  );
  const secretKeys = input.secretVariables.map(variableReference);
  return {
    environment: input.environment,
    flow: { ...input.flow, steps: input.steps },
    elements: input.elements.filter(
      (element) => !element.environment || element.environment === input.environment.id,
    ),
    variables: Object.fromEntries(
      scopedVariables.map((variable) => [
        variableReference(variable),
        variable.secret ? input.secretValues[variable.id] ?? "" : variable.value,
      ]),
    ),
    secretKeys,
    upToStepId: input.upToStepId,
  };
}
