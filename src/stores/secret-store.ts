import { create } from "zustand";

type SecretStore = {
  valuesByProject: Record<string, Record<string, string>>;
  setValues: (projectId: string, values: Record<string, string>) => void;
  clearValues: (projectId: string) => void;
};

export const useSecretStore = create<SecretStore>((set) => ({
  valuesByProject: {},
  setValues: (projectId, values) =>
    set((state) => ({
      valuesByProject: {
        ...state.valuesByProject,
        [projectId]: { ...(state.valuesByProject[projectId] ?? {}), ...values },
      },
    })),
  clearValues: (projectId) =>
    set((state) => {
      const { [projectId]: _cleared, ...remaining } = state.valuesByProject;
      return { valuesByProject: remaining };
    }),
}));
