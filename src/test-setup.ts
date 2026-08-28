import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => cleanup());

import '@testing-library/jest-dom/vitest'


// jsdom 缺少 antd 需要的浏览器 API，统一补齐桩实现。
if (typeof window !== "undefined") {
  if (!("ResizeObserver" in window)) {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (window as unknown as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
  }
  if (typeof window.matchMedia !== "function") {
    (window as unknown as Record<string, unknown>).matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    });
  }
}

// @tanstack/react-virtual 依赖容器 offsetHeight/offsetWidth 计算可视区；jsdom 无布局
// 引擎，这些值恒为 0，导致虚拟化行一概不渲染（virtual-core 在 outerSize===0 时返回
// 空 range）。仅对 `.virtual-list-scroll` 容器按内联 max-height（兜底 320px）/固定宽度
// 600px 提供桩尺寸；行测量返回 0 时 endIndex 仍会走到底（见 calculateRangeImpl 的全零
// measurements 分支），因此所有行都会进 DOM，测试可直接查询。真实浏览器走实际布局，
// 此补丁仅作用于测试环境。
const VIRTUAL_LIST_LAYOUT_MOCK = Symbol.for("ui_auto.virtualListLayoutMock");
if (typeof window !== "undefined" && !(window as unknown as Record<symbol, unknown>)[VIRTUAL_LIST_LAYOUT_MOCK]) {
  const proto = window.HTMLElement.prototype;
  Object.defineProperty(proto, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.classList?.contains("virtual-list-scroll")) {
        const px = Number.parseFloat(this.style.maxHeight);
        return Number.isFinite(px) ? px : 320;
      }
      return 0;
    },
  });
  Object.defineProperty(proto, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.classList?.contains("virtual-list-scroll")) {
        return 600;
      }
      return 0;
    },
  });
  (window as unknown as Record<symbol, unknown>)[VIRTUAL_LIST_LAYOUT_MOCK] = true;
}
