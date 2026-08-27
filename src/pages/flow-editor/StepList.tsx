import { Button, Checkbox, Dropdown } from "antd";
import {
  DragOutlined,
  MoreOutlined,
  PlayCircleFilled,
  PlusOutlined,
} from "@ant-design/icons";
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { FlowStep } from "../../lib/mock-data";

/**
 * 步骤列表渲染：拖拽排序（DndContext/SortableContext）、步骤卡片、底部添加按钮。
 * DnD 机制内聚在此；DragEnd 结果上抛为 onMove(from, to)，排序数据变更仍归页面编排。
 */
export function StepList({
  steps,
  selectedStepId,
  selectedStepIds,
  onSelect,
  onToggleSelection,
  onMove,
  onRemove,
  onAdd,
}: {
  steps: FlowStep[];
  selectedStepId?: string;
  selectedStepIds: string[];
  onSelect: (stepId: string) => void;
  onToggleSelection: (stepId: string, checked: boolean) => void;
  onMove: (from: number, to: number) => void;
  onRemove: (stepId: string) => void;
  onAdd: () => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = steps.findIndex((step) => step.id === active.id);
    const to = steps.findIndex((step) => step.id === over.id);
    if (from >= 0 && to >= 0) onMove(from, to);
  };
  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={steps.map((step) => step.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className="step-list">
            {steps.map((step, index) => (
              <SortableStep
                key={step.id}
                step={step}
                index={index}
                isSelected={step.id === selectedStepId}
                total={steps.length}
                selectable={step.action.includes("断言")}
                selected={selectedStepIds.includes(step.id)}
                onToggleSelection={onToggleSelection}
                onSelect={() => onSelect(step.id)}
                onMove={onMove}
                onRemove={onRemove}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      <Button className="add-step" icon={<PlusOutlined />} onClick={onAdd}>
        添加步骤
      </Button>
    </>
  );
}

function SortableStep({
  step,
  index,
  total,
  isSelected,
  selectable,
  selected,
  onToggleSelection,
  onSelect,
  onMove,
  onRemove,
}: {
  step: FlowStep;
  index: number;
  total: number;
  isSelected: boolean;
  selectable: boolean;
  selected: boolean;
  onToggleSelection: (stepId: string, checked: boolean) => void;
  onSelect: () => void;
  onMove: (from: number, to: number) => void;
  onRemove: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: step.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`step-item ${selectable ? "has-select" : ""} ${
        isSelected ? "selected" : ""
      } ${isDragging ? "dragging" : ""}`}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") onSelect();
      }}
      role="button"
      tabIndex={0}
    >
      {selectable && (
        <span
          className="step-select"
          onClick={(event) => event.stopPropagation()}
        >
          <Checkbox
            aria-label={`选择步骤：${step.title}`}
            checked={selected}
            onChange={(event) => onToggleSelection(step.id, event.target.checked)}
          />
        </span>
      )}
      <span className="step-index">{index + 1}</span>
      <button
        className="step-drag-handle"
        type="button"
        aria-label={`拖拽排序：${step.title}`}
        onClick={(event) => event.stopPropagation()}
        {...attributes}
        {...listeners}
      >
        <DragOutlined />
      </button>
      <span className={`step-kind ${step.status}`}>
        <PlayCircleFilled />
      </span>
      <span className="step-copy">
        <strong>{step.title}</strong>
        <small>{step.action}</small>
      </span>
      <Dropdown
        menu={{
          items: [
            {
              key: "up",
              label: "上移",
              disabled: index === 0,
              onClick: () => onMove(index, index - 1),
            },
            {
              key: "down",
              label: "下移",
              disabled: index === total - 1,
              onClick: () => onMove(index, index + 1),
            },
            {
              key: "delete",
              label: "删除步骤",
              danger: true,
              onClick: () => onRemove(step.id),
            },
          ],
        }}
        trigger={["click"]}
      >
        <Button
          type="text"
          icon={<MoreOutlined />}
          aria-label={`步骤 ${step.title} 操作`}
          onClick={(event) => event.stopPropagation()}
        />
      </Dropdown>
    </div>
  );
}
