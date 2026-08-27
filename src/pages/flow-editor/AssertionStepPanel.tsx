import { AutoComplete, Button, Input, Select, Switch } from "antd";
import { PlayCircleFilled } from "@ant-design/icons";
import { actionOptions } from "../../lib/mock-data";
import type { ElementAsset, FlowStep } from "../../lib/mock-data";
import { useAssertionStepDraft } from "./assertion-step-draft";

const ASSERTION_ATTRIBUTE_SUGGESTIONS = [
  "value",
  "id",
  "name",
  "class",
  "href",
  "src",
  "placeholder",
  "type",
  "disabled",
  "checked",
  "title",
  "data-testid",
  "aria-label",
];

export function AssertionStepPanel({
  step,
  elements,
  onChange,
  runInFlight,
  onRunToHere,
}: {
  step: FlowStep;
  elements: ElementAsset[];
  onChange: (patch: Partial<FlowStep>) => void;
  runInFlight: boolean;
  onRunToHere: () => void;
}) {
  const isAssertion = step.action.includes("断言");
  const changeAction = useAssertionStepDraft(onChange);
  return (
    <div className="step-form">
      <label>
        <span>动作</span>
        <Select
          aria-label="步骤动作"
          showSearch
          optionFilterProp="label"
          value={step.action}
          options={actionOptions.map((value) => ({ value }))}
          onChange={(action) => changeAction(action)}
        />
      </label>
      {!["打开页面", "等待", "截图"].includes(step.action) && (
        <label>
          <span>元素</span>
          <Select
            aria-label="步骤元素"
            value={step.element}
            showSearch
            optionFilterProp="label"
            placeholder="选择元素"
            options={elements.map((element) => ({
              value: element.name,
              label: element.name,
            }))}
            onChange={(element) => onChange({ element })}
          />
        </label>
      )}
      {isAssertion && (
        <div className="assert-config">
          {step.action === "可见性断言" && (
            <label>
              <span>期望状态</span>
              <Select
                aria-label="期望状态"
                value={step.assertVisibility ?? "visible"}
                options={[
                  { value: "visible", label: "可见" },
                  { value: "hidden", label: "不可见" },
                ]}
                onChange={(assertVisibility) => onChange({ assertVisibility })}
              />
            </label>
          )}
          {(step.action === "文本断言" || step.action === "属性断言") && (
            <label>
              <span>匹配方式</span>
              <Select
                aria-label="匹配方式"
                value={step.assertMatch ?? "contains"}
                options={[
                  { value: "contains", label: "包含" },
                  { value: "exact", label: "完全匹配" },
                ]}
                onChange={(assertMatch) => onChange({ assertMatch })}
              />
            </label>
          )}
          {step.action === "数量断言" && (
            <label>
              <span>比较符</span>
              <Select
                aria-label="比较符"
                value={step.assertOperator ?? "="}
                options={["=", ">", "<", ">=", "<="].map((value) => ({ value }))}
                onChange={(assertOperator) => onChange({ assertOperator })}
              />
            </label>
          )}
          {step.action === "属性断言" && (
            <label>
              <span>属性名</span>
              <AutoComplete
                aria-label="属性名"
                value={step.assertAttribute ?? "value"}
                options={ASSERTION_ATTRIBUTE_SUGGESTIONS.map((value) => ({
                  value,
                }))}
                onChange={(assertAttribute) => onChange({ assertAttribute })}
              />
            </label>
          )}
        </div>
      )}
      {step.action !== "可见性断言" && (
        <label>
          <span>
            {step.action === "打开页面"
              ? "页面路径"
              : step.action === "数量断言"
                ? "期望数量"
                : isAssertion
                  ? "期望值"
                  : step.action === "等待"
                    ? "等待时长"
                    : "参数"}
          </span>
          <Input
            value={step.value}
            inputMode={step.action === "数量断言" ? "numeric" : undefined}
            onChange={(event) =>
              onChange({
                // W2-5：数量断言期望值只允许数字，配置期拦截非法输入。
                value:
                  step.action === "数量断言"
                    ? event.target.value.replace(/[^0-9]/g, "")
                    : event.target.value,
              })
            }
            placeholder={
              step.action === "数量断言"
                ? "纯数字，例如 3"
                : "支持 {{env.baseUrl}}、{{project.username}} 等变量引用"
            }
          />
        </label>
      )}
      <div className="form-row">
        <label>
          <span>超时（秒）</span>
          <Input
            value={step.timeout}
            type="number"
            onChange={(event) =>
              onChange({ timeout: Number(event.target.value) })
            }
          />
        </label>
        <label>
          <span>失败策略</span>
          <Select
            aria-label="失败策略"
            value={step.failurePolicy}
            options={["立即失败", "继续执行", "重试 1 次"].map((value) => ({
              value,
            }))}
            onChange={(failurePolicy) => onChange({ failurePolicy })}
          />
        </label>
      </div>
      <div className="step-output-config">
        <label>
          <span>保存流程输出</span>
          <Switch
            size="small"
            checked={Boolean(step.output)}
            onChange={(checked) => onChange(checked
              ? { output: "output", outputSource: "text", outputPublic: false }
              : { output: undefined, outputSource: undefined, outputAttribute: undefined, outputParameter: undefined, responseUrl: undefined, outputPath: undefined, outputPublic: undefined })}
          />
        </label>
        {step.output && (
          <>
            <label>
              <span>输出变量名</span>
              <Input value={step.output} onChange={(event) => onChange({ output: event.target.value })} placeholder="例如 orderId" />
            </label>
            <label>
              <span>提取来源</span>
              <Select
                value={step.outputSource ?? "text"}
                options={[
                  { value: "text", label: "元素文本" },
                  { value: "attribute", label: "元素属性" },
                  { value: "url", label: "当前 URL 参数" },
                  { value: "response", label: "JSON 响应" },
                ]}
                onChange={(outputSource) => onChange({ outputSource })}
              />
            </label>
            {step.outputSource === "attribute" && <label><span>属性名</span><Input value={step.outputAttribute ?? "value"} onChange={(event) => onChange({ outputAttribute: event.target.value })} /></label>}
            {step.outputSource === "url" && <label><span>URL 参数名</span><Input value={step.outputParameter ?? step.output} onChange={(event) => onChange({ outputParameter: event.target.value })} /></label>}
            {step.outputSource === "response" && <><label><span>响应地址包含</span><Input value={step.responseUrl ?? ""} onChange={(event) => onChange({ responseUrl: event.target.value })} /></label><label><span>JSON 路径</span><Input value={step.outputPath ?? step.output} onChange={(event) => onChange({ outputPath: event.target.value })} /></label></>}
            <label>
              <span>可在报告中显示</span>
              <Switch size="small" checked={step.outputPublic === true} onChange={(outputPublic) => onChange({ outputPublic })} />
            </label>
          </>
        )}
      </div>
      <div className="step-form-footer">
        <Button icon={<PlayCircleFilled />} disabled={runInFlight} onClick={onRunToHere}>
          运行至此步骤
        </Button>
        <span>在服务端直接试跑（不产生运行记录、不影响通过率统计）。</span>
      </div>
    </div>
  );
}
