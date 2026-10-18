import {bootstrapServerRuntime} from './utils/runtimeBootstrap.ts'
import {getRuntimeDependencyPreflightMessage, getRuntimeDependencyProblems} from './utils/runtimeDependencyPreflight.ts'
import {
  exitWithRuntimeLogFlush,
  flushRuntimeLogs,
  writeRuntimeFailureLogEvent,
  writeRuntimeOperatorLogEvent,
} from './utils/runtimeLogger.ts'
import {isServerShutdownInProgress} from './utils/serverShutdownState.ts'

bootstrapServerRuntime()

const runtimeDependencyProblems = getRuntimeDependencyProblems()

if (runtimeDependencyProblems.length > 0) {
  writeRuntimeFailureLogEvent({
    attrs: {problems: runtimeDependencyProblems},
    event: 'server.startup.dependencies-missing',
    message: `[server] ${getRuntimeDependencyPreflightMessage(runtimeDependencyProblems)}`,
  })
  await exitWithRuntimeLogFlush({code: 1})
}

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
