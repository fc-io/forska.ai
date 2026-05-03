import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {
  type ProjectMartRefreshWorkerCycleOptions,
  runProjectMartRefreshWorkerOnce,
} from '../src/server/workers/projectMartRefreshWorker.ts'

type CliOptions = {
  heartbeatMs: number | undefined
  incrementalArticleThreshold: number | undefined
  leaseMs: number | undefined
  maxWakeMs: number | undefined
  workerId: string | undefined
}

const getArgValue = (names: string[]) => {
  const matchedArgument = process.argv.slice(2).find((argument) => {
    return names.some((name) => {
      return argument.startsWith(`${name}=`)
    })
  })

  return matchedArgument?.slice(matchedArgument.indexOf('=') + 1)
}

const getNumberArgValue = (names: string[]) => {
  const rawValue = getArgValue(names)
  const parsed = Number(rawValue)

  return rawValue === undefined || Number.isNaN(parsed) ? undefined : parsed
}

const getCliOptions = (): CliOptions => {
  return {
    heartbeatMs: getNumberArgValue(['--heartbeatMs', '--heartbeat-ms']),
    incrementalArticleThreshold: getNumberArgValue([
      '--incrementalArticleThreshold',
      '--incremental-article-threshold',
    ]),
    leaseMs: getNumberArgValue(['--leaseMs', '--lease-ms']),
    maxWakeMs: getNumberArgValue(['--maxWakeMs', '--max-wake-ms']),
    workerId: getArgValue(['--workerId', '--worker-id']),
  }
}

export const runProjectMartRefreshWorkerOnceCli = async () => {
  const options = getCliOptions()
  const workerOptions: ProjectMartRefreshWorkerCycleOptions = {
    heartbeatMs: options.heartbeatMs,
    incrementalArticleThreshold: options.incrementalArticleThreshold,
    leaseMs: options.leaseMs,
    maxWakeMs: options.maxWakeMs,
    workerId: options.workerId,
  }

  try {
    console.log(JSON.stringify(await runProjectMartRefreshWorkerOnce(workerOptions)))
  } finally {
    await getAppDatabaseService().close()
  }
}

if (import.meta.main) {
  await runProjectMartRefreshWorkerOnceCli()
}
