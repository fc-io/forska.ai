import {
  getServerShutdownSignal,
  markServerShutdownSignalHandlersRegistered,
  markServerShutdownStarted,
} from './serverShutdownState.ts'

export type ServerShutdownSignal = 'SIGINT' | 'SIGTERM'

type ServerShutdownSignalSource = {on: (signal: ServerShutdownSignal, listener: () => void) => unknown}

type ServerShutdownSignalLogEntry = {
  attrs: Record<string, unknown>
  event: string
  message: string
  severity: 'ERROR' | 'INFO' | 'WARN'
}

export type ServerShutdownSignalHandlersInput = {
  exit: (code: number) => Promise<void> | void
  forceExitAfterMs: number
  log: (entry: ServerShutdownSignalLogEntry) => void
  runShutdown: (signal: ServerShutdownSignal) => Promise<unknown>
  signalSource?: ServerShutdownSignalSource
}

const serverShutdownSignals: ServerShutdownSignal[] = ['SIGINT', 'SIGTERM']

const startServerShutdownForceExitTimer = (input: ServerShutdownSignalHandlersInput, signal: ServerShutdownSignal) => {
  return setTimeout(() => {
    input.log({
      attrs: {forceExitAfterMs: input.forceExitAfterMs, signal},
      event: 'server.shutdown.force-exit',
      message: `[server] graceful shutdown did not finish within ${input.forceExitAfterMs}ms; exiting`,
      severity: 'ERROR',
    })
    void input.exit(1)
  }, input.forceExitAfterMs)
}

const runServerShutdownForSignal = (input: ServerShutdownSignalHandlersInput, signal: ServerShutdownSignal) => {
  const forceExitTimer = startServerShutdownForceExitTimer(input, signal)

  void input.runShutdown(signal).then(
    () => {
      clearTimeout(forceExitTimer)
      void input.exit(0)
    },
    (error: unknown) => {
      clearTimeout(forceExitTimer)
      input.log({
        attrs: {error, signal},
        event: 'server.shutdown.failure',
        message: `[server] graceful shutdown failed on ${signal}`,
        severity: 'ERROR',
      })
      void input.exit(1)
    },
  )
}

const logIgnoredServerShutdownSignal = (input: ServerShutdownSignalHandlersInput, signal: ServerShutdownSignal) => {
  input.log({
    attrs: {firstSignal: getServerShutdownSignal(), signal},
    event: 'server.shutdown.signal-ignored',
    message: `[server] ${signal} ignored; graceful shutdown is already in progress (send SIGKILL to force)`,
    severity: 'WARN',
  })
}

const handleServerShutdownSignal = (input: ServerShutdownSignalHandlersInput, signal: ServerShutdownSignal) => {
  if (!markServerShutdownStarted(signal)) {
    logIgnoredServerShutdownSignal(input, signal)
    return
  }

  runServerShutdownForSignal(input, signal)
}

export const registerServerShutdownSignalHandlers = (input: ServerShutdownSignalHandlersInput) => {
  if (!markServerShutdownSignalHandlersRegistered()) {
    return false
  }

  const signalSource = input.signalSource ?? process

  serverShutdownSignals.map((signal) => {
    return signalSource.on(signal, () => {
      handleServerShutdownSignal(input, signal)
    })
  })

  return true
}
