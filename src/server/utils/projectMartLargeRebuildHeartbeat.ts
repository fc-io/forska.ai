import {runProjectMartLargeRebuildCycles} from '../services/projectMartLargeRebuildCyclesService.ts'
import {
  getProjectMartLargeRebuildHeartbeatConfig,
  type ProjectMartLargeRebuildHeartbeatConfig,
} from './projectMartLargeRebuildTuning.ts'
import {createRateLimitedLogger} from './rateLimitedLogger.ts'
import {registerWriterDemotionHandler, shouldCurrentServerRunWriterWork} from './serverRuntimeRole.ts'

type ProjectMartLargeRebuildHeartbeatOptions = {batchSize?: number; maxCyclesPerWake?: number; pollIntervalMs?: number}

const largeRebuildLogger = createRateLimitedLogger({windowMs: 30_000})

const logLargeRebuildHeartbeatError = (error: unknown) => {
  return largeRebuildLogger.warn(
    'project-mart-large-rebuild-heartbeat',
    '[projectMartLargeRebuild] background cycle failed',
    error,
  )
}

export const startProjectMartLargeRebuildHeartbeat = (options: ProjectMartLargeRebuildHeartbeatOptions = {}) => {
  if (!shouldCurrentServerRunWriterWork()) {
    return () => {}
  }

  let stopped = false
  let running = false
  let scheduledTimeout: ReturnType<typeof setTimeout> | null = null
  let loggedConfigKey: string | null = null

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
    console.log(
      `[projectMartLargeRebuild] background loop config batch_size=${resolvedConfig.batchSize} max_cycles_per_wake=${resolvedConfig.maxCyclesPerWake} poll_interval_ms=${resolvedConfig.pollIntervalMs} sources=${JSON.stringify(resolvedConfig.sources)}`,
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

  registerWriterDemotionHandler(() => {
    stop()
  })
  process.once('exit', stop)

  return stop
}

export {getProjectMartLargeRebuildHeartbeatConfig} from './projectMartLargeRebuildTuning.ts'
