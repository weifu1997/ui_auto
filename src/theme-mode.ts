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
    colorSuccess: "#34c759",
    colorWarning: "#c68418",
    colorError: "#c44343",
    colorTextBase: "#1d1d1f",
    colorBgBase: "#ffffff",
    colorBgLayout: "#f5f5f7",
    surface2: "#f5f5f7",
    separator: "rgba(0, 0, 0, 0.08)",
  },
  dark: {
    colorPrimary: "#0a84ff",
    colorInfo: "#0a84ff",
    colorSuccess: "#30d158",
    colorWarning: "#e0a63c",
    colorError: "#ff6464",
    colorTextBase: "#f5f5f7",
    colorBgBase: "#1c1c1e",
    colorBgLayout: "#000000",
    surface2: "#2c2c2e",
    separator: "rgba(84, 84, 88, 0.65)",
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
