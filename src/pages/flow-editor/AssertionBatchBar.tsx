import { Button, Select } from "antd";
import type { AssertMatch } from "../../domain/assertions";

/**
 * 批量编辑条：仅当勾选了断言步骤时渲染（页面级 rowSelection）。
 * 纯展示 + 回调上抛，选中集状态仍归页面。
 */
export function AssertionBatchBar({
  selectedCount,
  onApplyMatch,
  onApplyFailurePolicy,
  onClearSelection,
}: {
  selectedCount: number;
  onApplyMatch: (match: AssertMatch) => void;
  onApplyFailurePolicy: (policy: string) => void;
  onClearSelection: () => void;
}) {
  if (selectedCount === 0) return null;
  return (
    <div className="batch-step-bar" role="group" aria-label="批量编辑断言步骤">
      <span>已选 {selectedCount} 个断言步骤</span>
      <Select
        aria-label="批量匹配方式"
        placeholder="匹配方式"
        size="small"
        style={{ width: 140 }}
        options={[
          { value: "contains", label: "包含匹配" },
          { value: "exact", label: "精确匹配" },
        ]}
        onChange={(value) => onApplyMatch(value as AssertMatch)}
      />
      <Select
        aria-label="批量失败策略"
        placeholder="失败策略"
        size="small"
        style={{ width: 140 }}
        options={["立即失败", "继续执行", "重试 1 次"].map((value) => ({
          value,
        }))}
        onChange={(value) => onApplyFailurePolicy(value)}
      />
      <Button
        size="small"
        type="text"
        aria-label="清除步骤选择"
        onClick={onClearSelection}
      >
        清除选择
      </Button>
    </div>
  );
}
