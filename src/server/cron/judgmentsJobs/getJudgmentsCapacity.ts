import {env} from '../../utils/env.ts'
import {getWorkerCount} from './getWorkerCount.ts'

export const getJudgmentsCapacity = (
  runningJobCount: number,
): {
  workerCount: number
  perWorkerMaxRunningRequests: number
  perWorkerMaxInflightRequests: number
  perWorkerMaxBurstRequests: number
  maxInflight: number
  maxBurst: number
  readyTargetTotal: number
  readyTargetPerJob: number
  addToQueueMaxBatchSize: number
} => {
  const workerCount = getWorkerCount()
  const perWorkerMaxRunningRequests = Math.max(1, env.SGLANG_MAX_RUNNING_REQUESTS)

  const inflightOverridePerWorker = Math.max(0, env.SGLANG_API_MAX_INFLIGHT_REQUESTS)
  const perWorkerMaxInflightRequests =
    inflightOverridePerWorker > 0 ? inflightOverridePerWorker : perWorkerMaxRunningRequests

  const burstOverridePerWorker = Math.max(0, env.SGLANG_API_MAX_BURST_REQUESTS)
  const perWorkerMaxBurstRequests = burstOverridePerWorker > 0 ? burstOverridePerWorker : perWorkerMaxRunningRequests

  const maxInflight = perWorkerMaxInflightRequests * workerCount
  const maxBurst = perWorkerMaxBurstRequests * workerCount

  const readyTargetMultiplier = Math.max(1, env.JUDGMENTS_READY_TARGET_MULTIPLIER)
  const readyTargetTotal = maxInflight * readyTargetMultiplier
  const normalizedJobCount = Math.max(1, runningJobCount)
  const readyTargetPerJob = Math.max(1, Math.ceil(readyTargetTotal / normalizedJobCount))

  const addToQueueMaxBatchSize = Math.max(1, env.JUDGMENTS_ADD_TO_QUEUE_MAX_BATCH_SIZE)

  return {
    workerCount,
    perWorkerMaxRunningRequests,
    perWorkerMaxInflightRequests,
    perWorkerMaxBurstRequests,
    maxInflight,
    maxBurst,
    readyTargetTotal,
    readyTargetPerJob,
    addToQueueMaxBatchSize,
  }
}
