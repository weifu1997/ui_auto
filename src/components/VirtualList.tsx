import { useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

/**
 * 通用长列表虚拟化（@tanstack/react-virtual）。
 *
 * 绝对定位行 + 动态测量：`estimateSize` 只做首屏估算，渲染后按实际行高校准。
 * 滚动容器固定 `maxHeight` 并 `overflow-y: auto`；行序语义用 role="list" /
 * role="listitem" 保留，视觉与无障碍与直接渲染长列表保持一致。
 */
type VirtualListProps<T> = {
  items: readonly T[];
  renderItem: (item: T, index: number) => ReactNode;
  estimateSize?: number;
  maxHeight?: number;
  overscan?: number;
  rowClassName?: string | ((item: T, index: number) => string | undefined);
  className?: string;
  ariaLabel?: string;
};

export function VirtualList<T>({
  items,
  renderItem,
  estimateSize = 40,
  maxHeight = 320,
  overscan = 12,
  rowClassName,
  className,
  ariaLabel,
}: VirtualListProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateSize,
    overscan,
  });

  if (items.length === 0) {
    return null;
  }

  return (
    <div
      className={className}
      ref={scrollRef}
      role="list"
      aria-label={ariaLabel}
      style={{ overflowY: "auto", maxHeight }}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const item = items[virtualRow.index];
          return (
            <div
              role="listitem"
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              className={
                typeof rowClassName === "function"
                  ? rowClassName(item, virtualRow.index)
                  : rowClassName
              }
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              {renderItem(item, virtualRow.index)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
