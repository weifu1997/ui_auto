import { create } from "zustand";
import type { FlowStep } from "./mock-data";

type FlowStore = {
  steps: FlowStep[];
  selectedStepId: string;
  isDirty: boolean;
  setSelectedStep: (id: string) => void;
  updateStep: (patch: Partial<FlowStep>) => void;
  addStep: () => void;
  removeStep: (id: string) => void;
  moveStep: (from: number, to: number) => void;
  loadSteps: (steps: FlowStep[]) => void;
  appendSteps: (steps: FlowStep[]) => void;
  importRecordingSteps: (steps: FlowStep[]) => void;
  markSaved: () => void;
  reset: () => void;
};

function newStep(): FlowStep {
  return {
    id: `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: "新步骤",
    action: "点击",
    value: "",
    timeout: 10,
    failurePolicy: "立即失败",
    status: "pending",
  };
}

export const useFlowStore = create<FlowStore>((set) => ({
  steps: [],
  selectedStepId: "",
  isDirty: false,
  setSelectedStep: (selectedStepId) => set({ selectedStepId }),
  updateStep: (patch) =>
    set((state) => ({
      steps: state.steps.map((step) =>
        step.id === state.selectedStepId ? { ...step, ...patch } : step,
      ),
      isDirty: true,
    })),
  addStep: () =>
    set((state) => {
      const step = newStep();
      return {
        steps: [...state.steps, step],
        selectedStepId: step.id,
        isDirty: true,
      };
    }),
  removeStep: (id) =>
    set((state) => {
      const steps = state.steps.filter((step) => step.id !== id);
      return { steps, selectedStepId: steps[0]?.id ?? "", isDirty: true };
    }),
  moveStep: (from, to) =>
    set((state) => {
      if (to < 0 || to >= state.steps.length) return state;
      const steps = [...state.steps];
      const [item] = steps.splice(from, 1);
      steps.splice(to, 0, item);
      return { steps, isDirty: true };
    }),
  loadSteps: (steps) =>
    set({
      steps: steps.map((step) => ({ ...step })),
      selectedStepId: steps[0]?.id ?? "",
      isDirty: false,
    }),
  appendSteps: (newSteps) =>
    set((state) => ({
      steps: [...state.steps, ...newSteps.map((step) => ({ ...step }))],
      selectedStepId: state.selectedStepId || newSteps[0]?.id || "",
      isDirty: true,
    })),
  importRecordingSteps: (newSteps) =>
    set((state) => {
      const imported = newSteps.map((step) => ({ ...step }));
      return {
        steps: [...state.steps, ...imported],
        selectedStepId: imported[0]?.id ?? state.selectedStepId,
        isDirty: true,
      };
    }),
  markSaved: () => set({ isDirty: false }),
  reset: () => set({ steps: [], selectedStepId: "", isDirty: false }),
}));
