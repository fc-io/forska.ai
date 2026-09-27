type ServerShutdownHandler = () => Promise<void> | void

type ServerShutdownState = {
  handlers: ServerShutdownHandler[]
  signal: string | null
  signalHandlersRegistered: boolean
  startedAtMs: number | null
}

declare global {
  var __forskaServerShutdownState: ServerShutdownState | undefined
}

const getServerShutdownState = () => {
  globalThis.__forskaServerShutdownState ??= {
    handlers: [],
    signal: null,
    signalHandlersRegistered: false,
    startedAtMs: null,
  }

  return globalThis.__forskaServerShutdownState
}

export const isServerShutdownInProgress = () => {
  return getServerShutdownState().startedAtMs !== null
}

export const getServerShutdownSignal = () => {
  return getServerShutdownState().signal
}

export const markServerShutdownStarted = (signal: string, nowMs = Date.now()) => {
  const state = getServerShutdownState()

  if (state.startedAtMs !== null) {
    return false
  }

  state.signal = signal
  state.startedAtMs = nowMs
  return true
}

export const markServerShutdownSignalHandlersRegistered = () => {
  const state = getServerShutdownState()

  if (state.signalHandlersRegistered) {
    return false
  }

  state.signalHandlersRegistered = true
  return true
}

export const registerServerShutdownHandler = (handler: ServerShutdownHandler) => {
  const state = getServerShutdownState()
  state.handlers = [...state.handlers, handler]
}

export const runServerShutdownHandlers = async () => {
  const results = await Promise.allSettled(
    getServerShutdownState().handlers.map(async (handler) => {
      return handler()
    }),
  )

  return results.flatMap((result) => {
    return result.status === 'rejected' ? [result.reason as unknown] : []
  })
}

export const resetServerShutdownStateForTests = () => {
  globalThis.__forskaServerShutdownState = {
    handlers: [],
    signal: null,
    signalHandlersRegistered: false,
    startedAtMs: null,
  }
}
