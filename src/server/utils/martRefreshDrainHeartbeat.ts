import {getDuckdbMartRefreshService} from '../services/getDuckdbMartRefreshService.ts'
import {createRateLimitedLogger} from './rateLimitedLogger.ts'
import {shouldCurrentServerRunWriterWork} from './serverRuntimeRole.ts'

type MartRefreshDrainHeartbeatOptions = {intervalMs?: number}

const martRefreshDrainHeartbeatLogger = createRateLimitedLogger({windowMs: 30_000})
const defaultMartRefreshDrainHeartbeatIntervalMs = 5_000

const drainMartRefreshQueue = async () => {
  return shouldCurrentServerRunWriterWork() ? getDuckdbMartRefreshService().flush() : undefined
}

const logMartRefreshDrainError = (error: unknown) => {
  return martRefreshDrainHeartbeatLogger.warn(
    'mart-refresh-drain-heartbeat',
    '[duckdbMartRefresh] periodic queue drain failed',
    error,
  )
}

export const startMartRefreshDrainHeartbeat = (options: MartRefreshDrainHeartbeatOptions = {}) => {
  const runDrain = () => {
    return void drainMartRefreshQueue().catch(logMartRefreshDrainError)
  }
  const interval = setInterval(runDrain, options.intervalMs ?? defaultMartRefreshDrainHeartbeatIntervalMs)
  const stop = () => {
    clearInterval(interval)
  }

  interval.unref()
  runDrain()
  process.once('exit', stop)

  return stop
}
