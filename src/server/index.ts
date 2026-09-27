import {bootstrapServerRuntime} from './utils/runtimeBootstrap.ts'
import {flushRuntimeLogs, writeRuntimeFailureLogEvent, writeRuntimeOperatorLogEvent} from './utils/runtimeLogger.ts'
import {isServerShutdownInProgress} from './utils/serverShutdownState.ts'

bootstrapServerRuntime()

try {
  await import('./serverMain.ts')
} catch (error) {
  if (!isServerShutdownInProgress()) {
    writeRuntimeFailureLogEvent({attrs: {error}, event: 'server.startup.failure', message: '[server] startup failed'})
    await flushRuntimeLogs()
    throw error
  }

  writeRuntimeOperatorLogEvent({
    attrs: {error},
    event: 'server.startup.interrupted-by-shutdown',
    message: '[server] startup stopped because graceful shutdown started',
    severity: 'INFO',
  })
}

export type {App} from './serverMain.ts'
