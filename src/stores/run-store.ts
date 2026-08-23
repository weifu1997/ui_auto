import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { Run } from "../lib/mock-data";
import { migrateUnscopedStorageKey, userScopedStateStorage } from "../lib/user-scoped-storage";

export const runStorageKey = "autoflow-run-records";
migrateUnscopedStorageKey(runStorageKey);

export type ApiRun = Run;

type RunStore = {
  apiRuns: Record<string, ApiRun[]>;
  upsertRun: (projectId: string, run: ApiRun) => void;
  removeRuns: (projectId: string, runIds: string[]) => void;
  removeRun: (projectId: string, runId: string) => void;
};

export const useRunStore = create<RunStore>()(
  persist(
    (set) => ({
      apiRuns: {},
      upsertRun: (projectId, run) =>
        set((state) => {
          const current = state.apiRuns[projectId] ?? [];
          const exists = current.some((item) => item.id === run.id);
          return {
            apiRuns: {
              ...state.apiRuns,
              [projectId]: exists
                ? current.map((item) => (item.id === run.id ? { ...item, ...run } : item))
                : [run, ...current],
            },
          };
        }),
      removeRuns: (projectId, runIds) =>
        set((state) => {
          const current = state.apiRuns[projectId] ?? [];
          const idSet = new Set(runIds);
          return {
            apiRuns: {
              ...state.apiRuns,
              [projectId]: current.filter((item) => !idSet.has(item.id)),
            },
          };
        }),
      removeRun: (projectId, runId) =>
        set((state) => {
          const current = state.apiRuns[projectId] ?? [];
          return {
            apiRuns: {
              ...state.apiRuns,
              [projectId]: current.filter((item) => item.id !== runId),
            },
          };
        }),
    }),
    {
      name: runStorageKey,
      storage: createJSONStorage(() => userScopedStateStorage()),
      partialize: (state) => ({ apiRuns: state.apiRuns }),
    },
  ),
);
