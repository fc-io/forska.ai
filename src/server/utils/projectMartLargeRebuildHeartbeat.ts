import {runProjectMartLargeRebuildCycles} from '../services/projectMartLargeRebuildCyclesService.ts'
import {
  getProjectMartLargeRebuildHeartbeatConfig,
  type ProjectMartLargeRebuildHeartbeatConfig,
} from './projectMartLargeRebuildTuning.ts'
import {createRateLimitedLogger} from './rateLimitedLogger.ts'
import {registerDuckdbOwnerDemotionHandler, shouldCurrentServerRunMaintenanceLoops} from './serverRuntimeRole.ts'

type ProjectMartLargeRebuildHeartbeatOptions = {batchSize?: number; maxCyclesPerWake?: number; pollIntervalMs?: number}

const largeRebuildLogger = createRateLimitedLogger({sink: 'file-only', windowMs: 30_000})
const largeRebuildWarningLogger = createRateLimitedLogger({sink: 'both', windowMs: 30_000})
const largeRebuildComponent = 'projectMartLargeRebuildHeartbeat'

const getErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : String(error)
}

const logLargeRebuildHeartbeatError = (error: unknown) => {
  return largeRebuildWarningLogger.warn(
    'project-mart-large-rebuild-heartbeat',
    '[projectMartLargeRebuild] background cycle failed',
    {component: largeRebuildComponent, errorMessage: getErrorMessage(error), event: 'cycleFailed'},
  )
}

export const startProjectMartLargeRebuildHeartbeat = (options: ProjectMartLargeRebuildHeartbeatOptions = {}) => {
  if (!shouldCurrentServerRunMaintenanceLoops()) {
    return () => {}
  }

  let stopped = false
  let running = false
  let scheduledTimeout: ReturnType<typeof setTimeout> | null = null
  let loggedConfigKey: string | null = null
  let configLogCount = 0
  let runCount = 0

  const getResolvedConfig = async (): Promise<ProjectMartLargeRebuildHeartbeatConfig> => {
    const resolvedConfig = await getProjectMartLargeRebuildHeartbeatConfig()

    return {
      ...resolvedConfig,
      batchSize: options.batchSize ?? resolvedConfig.batchSize,
      maxCyclesPerWake: options.maxCyclesPerWake ?? resolvedConfig.maxCyclesPerWake,
      pollIntervalMs: options.pollIntervalMs ?? resolvedConfig.pollIntervalMs,
    }
  }

  const logResolvedConfig = (resolvedConfig: ProjectMartLargeRebuildHeartbeatConfig) => {
    const nextConfigKey = JSON.stringify({
      batchSize: resolvedConfig.batchSize,
      maxCyclesPerWake: resolvedConfig.maxCyclesPerWake,
      pollIntervalMs: resolvedConfig.pollIntervalMs,
      sources: resolvedConfig.sources,
    })

    if (nextConfigKey === loggedConfigKey) {
      return
    }

    loggedConfigKey = nextConfigKey
    configLogCount += 1
    largeRebuildLogger.log(
      'project-mart-large-rebuild-heartbeat:loop-config',
      '[projectMartLargeRebuild] background loop config',
      {
        batchSize: resolvedConfig.batchSize,
        component: largeRebuildComponent,
        configLogCount,
        event: 'loopConfig',
        maxCyclesPerWake: resolvedConfig.maxCyclesPerWake,
        pollIntervalMs: resolvedConfig.pollIntervalMs,
        runCount,
        sources: resolvedConfig.sources,
      },
    )
  }

  const scheduleNextRun = async () => {
    if (stopped) {
      return
    }

    const resolvedConfig = await getResolvedConfig()

    logResolvedConfig(resolvedConfig)
    scheduledTimeout = setTimeout(() => {
      void runCycle()
    }, resolvedConfig.pollIntervalMs)
    scheduledTimeout.unref()
  }

  const runCycle = async () => {
    if (stopped || running) {
      return
    }

    running = true
    runCount += 1

    try {
      const resolvedConfig = await getResolvedConfig()

      logResolvedConfig(resolvedConfig)
      await runProjectMartLargeRebuildCycles({
        batchSize: resolvedConfig.batchSize,
        maxCycles: resolvedConfig.maxCyclesPerWake,
        workerId: `project-mart-large-rebuild-heartbeat:${process.pid}`,
      })
    } catch (error) {
      logLargeRebuildHeartbeatError(error)
    } finally {
      running = false
      await scheduleNextRun()
    }
  }
  void runCycle()

  const stop = () => {
    stopped = true

    if (scheduledTimeout !== null) {
      clearTimeout(scheduledTimeout)
      scheduledTimeout = null
    }
  }

  registerDuckdbOwnerDemotionHandler(() => {
    stop()
  })
  process.once('exit', stop)

  return stop
}

export {getProjectMartLargeRebuildHeartbeatConfig} from './projectMartLargeRebuildTuning.ts'
