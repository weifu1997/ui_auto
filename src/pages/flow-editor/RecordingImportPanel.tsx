import { useEffect } from "react";
import { Alert, Button, Checkbox, Form, Input, Popover, Select, Tag, Tooltip } from "antd";
import {
  CheckCircleFilled,
  CloseCircleFilled,
  DeleteOutlined,
  ExclamationCircleFilled,
  FileSearchOutlined,
  LoadingOutlined,
  PlusOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { variableReference } from "../../lib/revision-snapshot";
import { elementValidationLoginMessage } from "../../lib/element-validation";
import { elementValidationLabel } from "./element-validation";
import type {
  ElementEditPatch,
  ElementValidationResult,
  ElementValidationStatus,
  ValidationTotals,
} from "./element-validation";
import type { ElementAsset, Environment, Variable } from "../../lib/mock-data";
import type { RecordingResult } from "../../api/platform-api";
import type { RecordingImportPlan } from "../../lib/recording-editor-state";

/**
 * 录制导入候选面板：录制结果弹窗的主体内容（步骤列表、候选断言勾选、secret
 * 绑定、新增元素定位器校验与编辑）。纯展示 + 回调上抛，全部状态仍归页面
 * （页面级 useWorkspaceStore / recording-editor-state / 校验状态）。
 */
export function RecordingImportPanel({
  recordingResult,
  eventCount,
  draftPlan,
  selectedAssertionIds,
  effectiveNewElements,
  validationTotals,
  validationResults,
  hasValidated,
  loginValidationErrors,
  elementEdits,
  expandedElementId,
  variables,
  environments,
  recordingSecretMap,
  onDeleteStep,
  onToggleAssertion,
  onSetSecretBinding,
  onCreateSecret,
  onExpandElement,
  onSaveElementEdit,
  onRetryValidation,
}: {
  recordingResult: RecordingResult;
  eventCount: number;
  draftPlan: RecordingImportPlan | null;
  selectedAssertionIds: Set<string>;
  effectiveNewElements: ElementAsset[];
  validationTotals: ValidationTotals;
  validationResults: Record<string, ElementValidationResult>;
  hasValidated: boolean;
  loginValidationErrors: string[];
  elementEdits: Record<string, Partial<ElementAsset>>;
  expandedElementId: string | null;
  variables: Variable[];
  environments: Environment[];
  recordingSecretMap: Record<string, string>;
  onDeleteStep: (stepIndex: number) => void;
  onToggleAssertion: (assertionId: string, checked: boolean) => void;
  onSetSecretBinding: (stepId: string, value: string) => void;
  onCreateSecret: (stepId: string) => void;
  onExpandElement: (elementId: string | null) => void;
  onSaveElementEdit: (element: ElementAsset, patch: ElementEditPatch) => void;
  onRetryValidation: (elementId: string) => void;
}) {
  return (
    <div className="recording-result">
      <p>共录制 {recordingResult.steps.length} 步，{recordingResult.elements.length} 个元素；已收到 {eventCount} 个事件。</p>
      <ol className="recording-steps-list">
        {recordingResult.steps.map((step, index) => (
          <li key={String(step.id ?? index)} className="recording-step-item">
            <span className="recording-step-content">
              <span className="recording-step-index">{index + 1}.</span>
              <span>{String(step.title ?? step.action ?? "录制步骤")} {step.element ? ` · ${String(step.element)}` : ""}</span>
            </span>
            <Tooltip title="删除此步骤">
              <Button
                type="text"
                size="small"
                danger
                icon={<DeleteOutlined />}
                onClick={() => onDeleteStep(index)}
              />
            </Tooltip>
          </li>
        ))}
      </ol>
      <ul>
        {recordingResult.elements.map((element, index) => (
          <li key={String(element.id ?? index)}>
            {String(element.name ?? `元素 ${index + 1}`)}：{String(element.method ?? "css")}={String(element.value ?? "")}
            {element.matchCount !== undefined ? `（匹配 ${String(element.matchCount)} 个）` : "（待校验）"}
          </li>
        ))}
      </ul>
      {draftPlan && draftPlan.generatedAssertions.length > 0 && (
        <div className="recording-assertions">
          <p>候选断言（含可见性，以及可挑选的文本/属性建议草稿；默认不勾选）：</p>
          {draftPlan.generatedAssertions.map((assertion) => (
            <label key={assertion.id} className="recording-assertion-row">
              <Checkbox
                checked={selectedAssertionIds.has(assertion.id)}
                onChange={(event) =>
                  onToggleAssertion(assertion.id, event.target.checked)
                }
              >
                {assertion.title}
              </Checkbox>
            </label>
          ))}
        </div>
      )}
      {recordingResult.warnings.length > 0 && (
        <ul>
          {recordingResult.warnings.map((warning, index) => (
            <li key={index}>{warning}</li>
          ))}
        </ul>
      )}
      {recordingResult.requiredBindings.length > 0 && (
        <div className="recording-bindings">
          <p>以下敏感输入必须绑定现有 secret 变量后才能导入：</p>
          {recordingResult.requiredBindings.map((binding) => (
            <label key={binding.stepId} className="recording-binding-row">
              <span>{binding.fieldHint}</span>
              <div className="recording-binding-actions">
                <Select
                  aria-label={`绑定 ${binding.fieldHint}`}
                  placeholder="搜索或选择 secret 变量"
                  showSearch
                  optionFilterProp="label"
                  filterOption
                  value={recordingSecretMap[binding.stepId]}
                  onChange={(value) => onSetSecretBinding(binding.stepId, value)}
                  options={variables
                    .filter((variable) => variable.secret && (variable.scope === "环境" || variable.scope === "项目"))
                    .map((variable) => ({ value: variableReference(variable), label: variable.name }))}
                />
                <Button
                  type="dashed"
                  icon={<PlusOutlined />}
                  onClick={() => onCreateSecret(binding.stepId)}
                >
                  新建并绑定
                </Button>
              </div>
            </label>
          ))}
        </div>
      )}
      {effectiveNewElements.length > 0 && (
        <div className="recording-bindings">
          <p style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
            新增元素定位器校验（{effectiveNewElements.length} 个）
            <span className="validation-summary-tags">
              {validationTotals.success > 0 && (
                <Tag color="success" icon={<CheckCircleFilled />}>成功 {validationTotals.success}</Tag>
              )}
              {validationTotals.ambiguous > 0 && (
                <Tag color="warning" icon={<ExclamationCircleFilled />}>匹配多个 {validationTotals.ambiguous}</Tag>
              )}
              {validationTotals.missed > 0 && (
                <Tag color="error" icon={<CloseCircleFilled />}>未匹配 {validationTotals.missed}</Tag>
              )}
              {validationTotals.error > 0 && (
                <Tag color="error">异常 {validationTotals.error}</Tag>
              )}
              {(validationTotals.pending + validationTotals.running) > 0 && (
                <Tag icon={<LoadingOutlined />}>校验中 {validationTotals.pending + validationTotals.running}</Tag>
              )}
            </span>
          </p>
          {loginValidationErrors.length > 0 && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: "var(--space-3)" }}
              message={`${loginValidationErrors.length} 个元素需要登录态才能校验`}
              description={elementValidationLoginMessage(loginValidationErrors[0]) ?? undefined}
            />
          )}
          {effectiveNewElements.map((element) => {
            const result = validationResults[element.id] ?? { status: "pending" as ElementValidationStatus };
            const expanded = expandedElementId === element.id;
            const statusIcon =
              result.status === "success" ? (
                <CheckCircleFilled style={{ color: "var(--success)" }} />
              ) : result.status === "ambiguous" ? (
                <ExclamationCircleFilled style={{ color: "var(--warning)" }} />
              ) : result.status === "missed" || result.status === "error" ? (
                <CloseCircleFilled style={{ color: "var(--danger)" }} />
              ) : result.status === "running" ? (
                <LoadingOutlined />
              ) : (
                <FileSearchOutlined style={{ color: "var(--text-secondary)" }} />
              );
            return (
              <div key={element.id} className="element-validation-row">
                <div className="element-validation-main">
                  <Tooltip title={elementValidationLabel(result, hasValidated)}>
                    <span className="element-validation-icon">{statusIcon}</span>
                  </Tooltip>
                  <span className="element-validation-name">{element.name}</span>
                  <Tag className="element-validation-method">
                    {element.method}
                  </Tag>
                  <Popover
                    content={<code style={{ whiteSpace: "pre-wrap" }}>{element.value}</code>}
                    title="定位值"
                    trigger="click"
                  >
                    <span className="element-validation-value" title={element.value}>
                      {element.value.length > 40 ? `${element.value.slice(0, 40)}…` : element.value}
                    </span>
                  </Popover>
                  <span className="element-validation-spacer" />
                  <Tooltip title="重新校验该元素">
                    <Button
                      type="text"
                      size="small"
                      icon={<ReloadOutlined />}
                      onClick={() => onRetryValidation(element.id)}
                      disabled={result.status === "running"}
                    />
                  </Tooltip>
                  <Button
                    type="text"
                    size="small"
                    onClick={() =>
                      onExpandElement(expanded ? null : element.id)
                    }
                  >
                    {expanded ? "收起" : "编辑"}
                  </Button>
                </div>
                {expanded && (
                  <div className="element-validation-edit">
                    <ElementEditForm
                      element={element}
                      environments={environments}
                      initialPatch={elementEdits[element.id]}
                      onCancel={() => onExpandElement(null)}
                      onSubmit={(patch) => onSaveElementEdit(element, patch)}
                    />
                  </div>
                )}
              </div>
            );
          })}
          {!draftPlan && (
            <Alert
              type="warning"
              showIcon
              message="无法生成导入计划"
              description="当前录制结果与元素库或 secret 绑定不兼容，请先完成 requiredBindings 的 secret 绑定后再校验。"
            />
          )}
        </div>
      )}
    </div>
  );
}

function ElementEditForm({
  element,
  environments,
  initialPatch,
  onCancel,
  onSubmit,
}: {
  element: ElementAsset;
  environments: Environment[];
  initialPatch?: Partial<ElementAsset>;
  onCancel: () => void;
  onSubmit: (patch: ElementEditPatch) => void;
}) {
  const [form] = Form.useForm();
  const method = Form.useWatch("method", form);
  const merged: ElementAsset = initialPatch ? { ...element, ...initialPatch } : element;
  useEffect(() => {
    form.setFieldsValue({
      path: merged.path,
      method: merged.method,
      value: merged.value,
      environment: merged.environment,
    });
  }, [form, merged.path, merged.method, merged.value, merged.environment]);
  return (
    <Form
      form={form}
      layout="vertical"
      className="element-edit-form"
      onFinish={(values) => {
        onSubmit({
          path: typeof values.path === "string" ? values.path.trim() : undefined,
          method: values.method,
          value: typeof values.value === "string" ? values.value : undefined,
          environment: typeof values.environment === "string" ? values.environment : undefined,
        });
      }}
    >
      <div className="form-row">
        <Form.Item
          name="path"
          label="页面路径"
          rules={[{ required: true, message: "请输入路径" }]}
          style={{ flex: 2 }}
        >
          <Input placeholder="/login" />
        </Form.Item>
        <Form.Item
          name="environment"
          label="默认验证环境"
          style={{ flex: 1 }}
        >
          <Select
            options={environments.map((env) => ({ value: env.id, label: env.name }))}
          />
        </Form.Item>
      </div>
      <div className="form-row">
        <Form.Item
          name="method"
          label="定位方式"
          rules={[{ required: true }]}
          style={{ flex: 1 }}
        >
          <Select
            options={["testid", "role", "label", "text", "CSS", "XPath"].map((value) => ({
              value,
              label: value,
            }))}
          />
        </Form.Item>
        <Form.Item
          name="value"
          label="定位值"
          rules={[{ required: true, message: "请输入定位值" }]}
          style={{ flex: 2 }}
        >
          <Input
            placeholder={
              method === "testid"
                ? "login-submit"
                : method === "role"
                  ? 'button[name="登录"]'
                  : "请输入定位值"
            }
          />
        </Form.Item>
      </div>
      {(method === "CSS" || method === "XPath") && (
        <Alert
          showIcon
          type="warning"
          title="该定位方式稳定性较低"
          description="优先选择 testid、role 或 label。CSS/XPath 在页面结构变化后更容易失效。"
        />
      )}
      <div className="element-edit-actions">
        <Button onClick={onCancel}>取消</Button>
        <Button type="primary" htmlType="submit">保存并重校</Button>
      </div>
    </Form>
  );
}
