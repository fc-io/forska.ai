import {runProjectMartLargeRebuildCycles} from '../services/projectMartLargeRebuildCyclesService.ts'
import {createRateLimitedLogger} from './rateLimitedLogger.ts'
import {registerWriterDemotionHandler, shouldCurrentServerRunWriterWork} from './serverRuntimeRole.ts'

type ProjectMartLargeRebuildHeartbeatOptions = {batchSize?: number; maxCyclesPerWake?: number; pollIntervalMs?: number}

const defaultBatchSize = 128
const defaultMaxCyclesPerWake = 4
const defaultPollIntervalMs = 1_000
const largeRebuildLogger = createRateLimitedLogger({windowMs: 30_000})

const getEnvBatchSize = () => {
  const parsed = Number(process.env.PROJECT_MART_LARGE_REBUILD_BATCH_SIZE ?? '')
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultBatchSize
}

const getEnvPollIntervalMs = () => {
  const parsed = Number(process.env.PROJECT_MART_LARGE_REBUILD_POLL_INTERVAL_MS ?? '')
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultPollIntervalMs
}

const getEnvMaxCyclesPerWake = () => {
  const parsed = Number(process.env.PROJECT_MART_LARGE_REBUILD_MAX_CYCLES_PER_WAKE ?? '')
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultMaxCyclesPerWake
}

export const getProjectMartLargeRebuildHeartbeatConfig = () => {
  return {
    batchSize: getEnvBatchSize(),
    maxCyclesPerWake: getEnvMaxCyclesPerWake(),
    pollIntervalMs: getEnvPollIntervalMs(),
  }
}

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

  const pollIntervalMs = options.pollIntervalMs ?? getEnvPollIntervalMs()
  const batchSize = options.batchSize ?? getEnvBatchSize()
  const maxCyclesPerWake = options.maxCyclesPerWake ?? getEnvMaxCyclesPerWake()
  let stopped = false
  let running = false

  const runCycle = async () => {
    if (stopped || running) {
      return
    }

    running = true

    try {
      await runProjectMartLargeRebuildCycles({
        batchSize,
        maxCycles: maxCyclesPerWake,
        workerId: `project-mart-large-rebuild-heartbeat:${process.pid}`,
      })
    } catch (error) {
      logLargeRebuildHeartbeatError(error)
    } finally {
      running = false
    }
  }

  const interval = setInterval(() => {
    return void runCycle()
  }, pollIntervalMs)

  interval.unref()
  console.log(
    `[projectMartLargeRebuild] background loop starting batch_size=${batchSize} max_cycles_per_wake=${maxCyclesPerWake} poll_interval_ms=${pollIntervalMs}`,
  )
  void runCycle()

  const stop = () => {
    stopped = true
    clearInterval(interval)
  }

  registerWriterDemotionHandler(() => {
    stop()
  })
  process.once('exit', stop)

  return stop
}
