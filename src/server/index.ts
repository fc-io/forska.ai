import {bootstrapServerRuntime} from './utils/runtimeBootstrap.ts'
import {flushRuntimeLogs, writeRuntimeFailureLogEvent} from './utils/runtimeLogger.ts'

bootstrapServerRuntime()

try {
  await import('./serverMain.ts')
} catch (error) {
  writeRuntimeFailureLogEvent({attrs: {error}, event: 'server.startup.failure', message: '[server] startup failed'})
  await flushRuntimeLogs()
  throw error
}

export type {App} from './serverMain.ts'
