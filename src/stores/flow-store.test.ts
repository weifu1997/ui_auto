import { beforeEach, describe, expect, it } from 'vitest'
import { shouldReloadEditorSteps, useFlowStore } from './flow-store'

describe('flow editor draft store', () => {
  beforeEach(() => {
    useFlowStore.getState().reset()
  })

  it('marks a draft dirty when a step changes and resets it after saving', () => {
    useFlowStore.getState().addStep()
    useFlowStore.getState().updateStep({ value: '/account/login' })

    expect(useFlowStore.getState().isDirty).toBe(true)
    expect(useFlowStore.getState().steps[0].value).toBe('/account/login')

    useFlowStore.getState().markSaved()
    expect(useFlowStore.getState().isDirty).toBe(false)
  })

  it('reorders steps without losing any step', () => {
    useFlowStore.getState().addStep()
    useFlowStore.getState().addStep()
    useFlowStore.getState().addStep()
    const originalFirst = useFlowStore.getState().steps[0].id
    useFlowStore.getState().moveStep(0, 2)

    expect(useFlowStore.getState().steps).toHaveLength(3)
    expect(useFlowStore.getState().steps[2].id).toBe(originalFirst)
  })

  it('imports recording steps in one draft update and selects the first imported step', () => {
    useFlowStore.getState().loadSteps([
      { id: 'manual', title: 'Manual', action: '点击', value: '', timeout: 10, failurePolicy: '立即失败', status: 'pending' },
    ])
    const recorded = [
      { id: 'recorded-1', title: 'Open', action: '打开页面', value: '/login', timeout: 10, failurePolicy: '立即失败', status: 'pending' as const },
      { id: 'recorded-2', title: 'Click', action: '点击', value: '', timeout: 10, failurePolicy: '立即失败', status: 'pending' as const },
    ]

    useFlowStore.getState().importRecordingSteps(recorded)
    recorded[0].title = 'mutated outside the store'

    expect(useFlowStore.getState()).toMatchObject({
      selectedStepId: 'recorded-1',
      isDirty: true,
    })
    expect(useFlowStore.getState().steps.map((step) => step.title)).toEqual(['Manual', 'Open', 'Click'])
  })

  it('does not dirty a draft when an empty recording result is confirmed', () => {
    useFlowStore.getState().loadSteps([
      { id: 'manual', title: 'Manual', action: '点击', value: '', timeout: 10, failurePolicy: '立即失败', status: 'pending' },
    ])

    useFlowStore.getState().importRecordingSteps([])

    expect(useFlowStore.getState()).toMatchObject({ selectedStepId: 'manual', isDirty: false })
  })
})

describe('shouldReloadEditorSteps', () => {
  it('reloads on the first load and when switching to another flow', () => {
    expect(shouldReloadEditorSteps(null, { flowId: 'a', serialized: '[]' }, false)).toBe(true)
    expect(
      shouldReloadEditorSteps({ flowId: 'a', serialized: '[]' }, { flowId: 'b', serialized: '[]' }, false),
    ).toBe(true)
  })

  it('never overwrites a dirty draft with the same flow definition', () => {
    const last = { flowId: 'a', serialized: '[{"id":"saved"}]' }
    expect(shouldReloadEditorSteps(last, { flowId: 'a', serialized: '[{"id":"saved"}]' }, true)).toBe(false)
    expect(shouldReloadEditorSteps(last, { flowId: 'a', serialized: '[{"id":"remote"}]' }, true)).toBe(false)
  })

  it('skips a poll refresh whose content is unchanged so selection is preserved', () => {
    const last = { flowId: 'a', serialized: '[{"id":"saved"}]' }
    expect(shouldReloadEditorSteps(last, { flowId: 'a', serialized: '[{"id":"saved"}]' }, false)).toBe(false)
  })

  it('reloads a clean editor when the remote content actually changes', () => {
    const last = { flowId: 'a', serialized: '[{"id":"saved"}]' }
    expect(shouldReloadEditorSteps(last, { flowId: 'a', serialized: '[{"id":"remote"}]' }, false)).toBe(true)
  })
})
