// 主题模式：跟随系统 / 浅色 / 深色。持久化到 localStorage，并同步 <html data-theme>。
import { create } from "zustand";

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "autoflow-theme-mode";

// 与 src/theme.css 中的色板保持同源。
export const themePalettes = {
  light: {
    colorPrimary: "#0071e3",
    colorInfo: "#0071e3",
    colorSuccess: "#10b981",
    colorWarning: "#f59e0b",
    colorError: "#ef4444",
    colorTextBase: "#121417",
    colorBgBase: "#ffffff",
    colorBgLayout: "#f7f8fa",
    surface2: "#f2f4f7",
    separator: "rgba(0, 0, 0, 0.07)",
  },
  dark: {
    colorPrimary: "#3b82f6",
    colorInfo: "#3b82f6",
    colorSuccess: "#10b981",
    colorWarning: "#f59e0b",
    colorError: "#ef4444",
    colorTextBase: "#f3f4f6",
    colorBgBase: "#13151b",
    colorBgLayout: "#090a0f",
    surface2: "#1c1f28",
    separator: "rgba(255, 255, 255, 0.08)",
  },
} as const;

function readStoredMode(): ThemeMode {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
}

function systemPrefersDark() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === "system") return systemPrefersDark() ? "dark" : "light";
  return mode;
}

export function applyTheme(mode: ThemeMode): ResolvedTheme {
  const resolved = resolveTheme(mode);
  document.documentElement.dataset.theme = resolved;
  return resolved;
}

export const useThemeStore = create<{
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
}>((set) => ({
  mode: readStoredMode(),
  setMode: (mode) => {
    localStorage.setItem(STORAGE_KEY, mode);
    set({ mode });
  },
}));
