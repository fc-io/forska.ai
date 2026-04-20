import {bootstrapAppServerRuntime} from './server/utils/runtimeBootstrap.ts'
import {flushRuntimeLogs, writeRuntimeFailureLogEvent} from './server/utils/runtimeLogger.ts'

bootstrapAppServerRuntime()

try {
  await import('./appServerMain.ts')
} catch (error) {
  writeRuntimeFailureLogEvent({
    attrs: {error},
    event: 'app-server.startup.failure',
    message: '[app-server] startup failed',
  })
  await flushRuntimeLogs()
  throw error
}

export type {App} from './appServerMain.ts'
