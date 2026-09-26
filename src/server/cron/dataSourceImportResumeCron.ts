import {cron} from '@elysiajs/cron'
import {Elysia} from 'elysia'

import {
  type DataSourceImportResumerWakeResult,
  runDataSourceImportResumerWake,
} from '../routes/DataSourcesImportRoutes/dataSourceImportResumer.ts'
import {writeRuntimeFailureLogEvent} from '../utils/runtimeLogger.ts'
import {
  canCurrentServerOwnDuckdb,
  isExpectedDuckdbOwnerRoleLossError,
  shouldCurrentServerRunMaintenanceLoops,
} from '../utils/serverRuntimeRole.ts'

const DATA_SOURCE_IMPORT_RESUME_INTERVAL = '*/30 * * * * *'
const START_DELAY_MS = 15_000

export type DataSourceImportResumeCronWakeResult =
  | {reason: 'maintenance-role'; status: 'skipped'}
  | {result: DataSourceImportResumerWakeResult; status: 'ran'}

const logCronError = (error: unknown) => {
  if (isExpectedDuckdbOwnerRoleLossError(error)) {
    return
  }

  writeRuntimeFailureLogEvent({
    attrs: {error},
    event: 'data-source-import.resume-cron.failure',
    message: '[dataSourceImport] resume cron wake failed',
    terminalArgs: [error instanceof Error ? error.message : error],
  })
}

const shouldCurrentServerResumeDataSourceImports = () => {
  return shouldCurrentServerRunMaintenanceLoops() && canCurrentServerOwnDuckdb()
}

export const runDataSourceImportResumeCronWake = async ({
  shouldResumeImports = shouldCurrentServerResumeDataSourceImports,
  wake = runDataSourceImportResumerWake,
}: {
  shouldResumeImports?: () => boolean
  wake?: () => Promise<DataSourceImportResumerWakeResult>
} = {}): Promise<DataSourceImportResumeCronWakeResult> => {
  if (!shouldResumeImports()) {
    return {reason: 'maintenance-role', status: 'skipped'}
  }

  return {result: await wake(), status: 'ran'}
}

export const dataSourceImportResumeCron = new Elysia().use(
  cron({
    name: 'data-source-import-resume',
    pattern: DATA_SOURCE_IMPORT_RESUME_INTERVAL,
    protect: true,
    startAt: new Date(Date.now() + START_DELAY_MS),
    run: async () => {
      try {
        await runDataSourceImportResumeCronWake()
      } catch (error) {
        logCronError(error)
      }
    },
  }),
)
