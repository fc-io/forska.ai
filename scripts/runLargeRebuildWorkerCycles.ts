import {hostname} from 'node:os'

import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {
  runProjectMartLargeRebuildCycles,
  type ProjectMartLargeRebuildUntil,
} from '../src/server/services/projectMartLargeRebuildCyclesService.ts'

const defaultBatchSize = 1
const defaultLeaseMs = 30_000
const defaultHeartbeatMs = 10_000
const defaultMaxCycles = 10

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

const getUntil = (): ProjectMartLargeRebuildUntil | undefined => {
  const value = getArgValue(['--until'])

  return value === 'completed' || value === 'failed' || value === 'idle' || value === 'phase-change' || value === 'max-cycles'
    ? value
    : undefined
}

const runLargeRebuildWorkerCyclesCli = async () => {
  const workerId = getArgValue(['--workerId', '--worker-id']) ?? `large-rebuild-worker-cycles:${hostname()}:${process.pid}`

  try {
    const result = await runProjectMartLargeRebuildCycles({
      batchSize: getNumberArgValue(['--batchSize', '--batch-size']) ?? defaultBatchSize,
      heartbeatMs: getNumberArgValue(['--heartbeatMs', '--heartbeat-ms']) ?? defaultHeartbeatMs,
      leaseMs: getNumberArgValue(['--leaseMs', '--lease-ms']) ?? defaultLeaseMs,
      maxCycles: Math.max(1, Math.trunc(getNumberArgValue(['--maxCycles', '--max-cycles']) ?? defaultMaxCycles)),
      maxNoProgressBackoffs: getNumberArgValue(['--maxNoProgressBackoffs', '--max-no-progress-backoffs']),
      maxWakeMs: getNumberArgValue(['--maxWakeMs', '--max-wake-ms']),
      projectId: getArgValue(['--projectId', '--project-id']),
      until: getUntil(),
      workerId,
    })
    console.log(JSON.stringify(result))
    process.exitCode = result.status === 'failed' ? 1 : 0
  } finally {
    await getAppDatabaseService().close()
  }
}

void runLargeRebuildWorkerCyclesCli()
