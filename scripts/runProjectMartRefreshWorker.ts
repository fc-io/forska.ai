import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {
  runProjectMartRefreshWorker,
  type ProjectMartRefreshWorkerLoopOptions,
} from '../src/server/workers/projectMartRefreshWorker.ts'

type CliOptions = {
  heartbeatMs: number | undefined
  leaseMs: number | undefined
  pollIntervalMs: number | undefined
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
    leaseMs: getNumberArgValue(['--leaseMs', '--lease-ms']),
    pollIntervalMs: getNumberArgValue(['--pollIntervalMs', '--poll-interval-ms']),
    workerId: getArgValue(['--workerId', '--worker-id']),
  }
}

export const runProjectMartRefreshWorkerCli = async () => {
  const options = getCliOptions()
  const abortController = new AbortController()
  const stop = () => {
    abortController.abort()
  }
  const workerOptions: ProjectMartRefreshWorkerLoopOptions = {
    heartbeatMs: options.heartbeatMs,
    leaseMs: options.leaseMs,
    pollIntervalMs: options.pollIntervalMs,
    signal: abortController.signal,
    workerId: options.workerId,
  }

  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  try {
    console.log(
      JSON.stringify({
        heartbeatMs: workerOptions.heartbeatMs,
        leaseMs: workerOptions.leaseMs,
        pollIntervalMs: workerOptions.pollIntervalMs,
        status: 'starting',
        workerId: workerOptions.workerId,
      }),
    )
    await runProjectMartRefreshWorker(workerOptions)
  } finally {
    await getAppDatabaseService().close()
  }
}

if (import.meta.main) {
  await runProjectMartRefreshWorkerCli()
}
