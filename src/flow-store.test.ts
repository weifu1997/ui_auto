import { beforeEach, describe, expect, it } from 'vitest'
import { useFlowStore } from './flow-store'

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
