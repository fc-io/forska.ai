import {hostname} from 'node:os'

import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {runProjectMartLargeRebuildCycle} from '../src/server/services/projectMartLargeRebuildRunner.ts'

type CliOptions = {
  batchSize: number
  heartbeatMs: number | undefined
  leaseMs: number
  workerId: string
}

const defaultBatchSize = 1
const defaultLeaseMs = 30_000
const defaultHeartbeatMs = 10_000

const getArgValue = (names: string[]) => {
  const matchedArgument = process.argv.slice(2).find((argument) => {
    return names.some((name) => {
      return argument.startsWith(`${name}=`)
    })
  })

  return matchedArgument?.slice(matchedArgument.indexOf('=') + 1).trim()
}

const getNumberArgValue = (names: string[]) => {
  const rawValue = getArgValue(names)
  const parsed = Number(rawValue)

  return rawValue === undefined || Number.isNaN(parsed) ? undefined : parsed
}

const getCliOptions = (): CliOptions => {
  return {
    batchSize: getNumberArgValue(['--batchSize', '--batch-size']) ?? defaultBatchSize,
    heartbeatMs: getNumberArgValue(['--heartbeatMs', '--heartbeat-ms']) ?? defaultHeartbeatMs,
    leaseMs: getNumberArgValue(['--leaseMs', '--lease-ms']) ?? defaultLeaseMs,
    workerId: getArgValue(['--workerId', '--worker-id']) ?? `project-mart-large-rebuild-cycle:${hostname()}:${process.pid}`,
  }
}

const runLargeRebuildCycleCli = async () => {
  const options = getCliOptions()

  try {
    const result = await runProjectMartLargeRebuildCycle(options)
    console.log(JSON.stringify(result))
    process.exitCode = result.status === 'failed' ? 1 : 0
  } finally {
    await getAppDatabaseService().close()
  }
}

void runLargeRebuildCycleCli()
