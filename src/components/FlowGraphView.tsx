import { useCallback, useMemo } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { FlowStep } from "../lib/mock-data";

// W3 试点：只读流程图。节点=步骤（按动作大类着色，断言步特殊标识），
// 边=执行顺序；点击节点回选中该步骤。刻意保持无状态、纯展示。

const ASSERTION_ACTIONS = new Set(["可见性断言", "文本断言", "数量断言", "属性断言"]);

function stepColor(step: FlowStep): string {
  if (ASSERTION_ACTIONS.has(step.action)) return "#722ed1"; // 断言：紫
  if (step.action === "打开页面") return "#13c2c2"; // 导航：青
  return "#1677ff"; // 普通操作：蓝
}

export type FlowGraphViewProps = {
  steps: FlowStep[];
  onSelectStep?: (stepId: string) => void;
};

export default function FlowGraphView({ steps, onSelectStep }: FlowGraphViewProps) {
  const nodes = useMemo<Node[]>(
    () =>
      steps.map((step, index) => ({
        id: step.id,
        position: { x: index % 2 === 0 ? 0 : 220, y: index * 90 },
        data: {
          label: `${index + 1}. ${step.title || step.action}${
            ASSERTION_ACTIONS.has(step.action) ? " ⟂" : ""
          }`,
        },
        style: {
          borderColor: stepColor(step),
          borderRadius: 8,
          padding: 6,
          width: 200,
          fontSize: 12,
        },
      })),
    [steps],
  );

  const edges = useMemo<Edge[]>(
    () =>
      steps.slice(1).map((step, index) => ({
        id: `edge-${index}`,
        source: steps[index].id,
        target: step.id,
        animated: false,
      })),
    [steps],
  );

  const handleNodeClick = useCallback<NodeMouseHandler>(
    (_event, node) => onSelectStep?.(node.id),
    [onSelectStep],
  );

  if (steps.length === 0) {
    return <p style={{ color: "#888" }}>暂无步骤，先在左侧添加一个步骤。</p>;
  }

  return (
    <div style={{ height: 420 }} aria-label="流程只读视图">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        onNodeClick={handleNodeClick}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={18} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
