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
})
