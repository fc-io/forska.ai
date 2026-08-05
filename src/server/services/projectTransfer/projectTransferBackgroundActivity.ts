type ProjectTransferBackgroundActivityState = {activeCount: number}

const projectTransferBackgroundActivityStateKey = Symbol.for('forska.projectTransfer.backgroundActivityState')

const getProjectTransferBackgroundActivityState = (): ProjectTransferBackgroundActivityState => {
  const globalState = globalThis as typeof globalThis & {
    [projectTransferBackgroundActivityStateKey]?: ProjectTransferBackgroundActivityState
  }

  globalState[projectTransferBackgroundActivityStateKey] ??= {activeCount: 0}

  return globalState[projectTransferBackgroundActivityStateKey]
}

export const hasActiveProjectTransferBackgroundActivity = () => {
  return getProjectTransferBackgroundActivityState().activeCount > 0
}

export const runWithProjectTransferBackgroundActivity = async <TValue>(operation: () => Promise<TValue>) => {
  const state = getProjectTransferBackgroundActivityState()
  state.activeCount += 1

  try {
    return await operation()
  } finally {
    state.activeCount = Math.max(0, state.activeCount - 1)
  }
}
