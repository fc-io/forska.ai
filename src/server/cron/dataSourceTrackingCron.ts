import {cron} from '@elysiajs/cron'
import {Elysia} from 'elysia'

import {type DataSourceTrackingWorker, getDataSourceTrackingWorker} from '../services/dataSourceTrackingWorker.ts'
import {writeRuntimeFailureLogEvent} from '../utils/runtimeLogger.ts'
import {isExpectedDuckdbOwnerRoleLossError, shouldCurrentServerRunMaintenanceLoops} from '../utils/serverRuntimeRole.ts'

const DATA_SOURCE_TRACKING_INTERVAL = '0 * * * * *'
const START_DELAY_MS = 2000

export type DataSourceTrackingCronWakeResult =
  | {reason: 'maintenance-role'; status: 'skipped'}
  | {result: Awaited<ReturnType<DataSourceTrackingWorker['wake']>>; status: 'ran'}

const logCronError = (error: unknown) => {
  if (isExpectedDuckdbOwnerRoleLossError(error)) {
    return
  }

  writeRuntimeFailureLogEvent({
    attrs: {error},
    event: 'data-source-tracking.cron.failure',
    message: '[data-source-tracking] cron wake failed',
    terminalArgs: [error instanceof Error ? error.message : error],
  })
}

export const runDataSourceTrackingCronWake = async ({
  shouldRunMaintenanceLoops = shouldCurrentServerRunMaintenanceLoops,
  worker = getDataSourceTrackingWorker(),
}: {
  shouldRunMaintenanceLoops?: () => boolean
  worker?: DataSourceTrackingWorker
} = {}): Promise<DataSourceTrackingCronWakeResult> => {
  if (!shouldRunMaintenanceLoops()) {
    return {reason: 'maintenance-role', status: 'skipped'}
  }

  return {result: await worker.wake(), status: 'ran'}
}

export const dataSourceTrackingCron = new Elysia().use(
  cron({
    name: 'data-source-tracking',
    pattern: DATA_SOURCE_TRACKING_INTERVAL,
    startAt: new Date(Date.now() + START_DELAY_MS),
    run: async () => {
      try {
        await runDataSourceTrackingCronWake()
      } catch (error) {
        logCronError(error)
      }
    },
  }),
)
