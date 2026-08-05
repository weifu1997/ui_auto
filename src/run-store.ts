import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Run } from "./mock-data";
import type { RunRequest } from "./worker-api";

export type ApiRun = Run & { request?: RunRequest };

type RunStore = {
  apiRuns: Record<string, ApiRun[]>;
  upsertRun: (projectId: string, run: ApiRun) => void;
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
    }),
    {
      name: "autoflow-run-records",
      partialize: (state) => ({
        apiRuns: Object.fromEntries(
          Object.entries(state.apiRuns).map(([projectId, runs]) => [
            projectId,
            runs.map(({ request: _request, ...run }) => run),
          ]),
        ),
      }),
    },
  ),
);
