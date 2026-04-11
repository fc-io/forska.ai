import {getInferenceRuntimeConfig} from '../../utils/getInferenceRuntimeConfig.ts'
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
  const runtimeConfig = getInferenceRuntimeConfig()
  const workerCount = getWorkerCount()
  const perWorkerMaxRunningRequests = Math.max(1, runtimeConfig.sglangMaxRunningRequests)

  const inflightOverridePerWorker = Math.max(0, runtimeConfig.sglangApiMaxInflightRequests)
  const perWorkerMaxInflightRequests =
    inflightOverridePerWorker > 0 ? inflightOverridePerWorker : perWorkerMaxRunningRequests

  const burstOverridePerWorker = Math.max(0, runtimeConfig.sglangApiMaxBurstRequests)
  const perWorkerMaxBurstRequests = burstOverridePerWorker > 0 ? burstOverridePerWorker : perWorkerMaxRunningRequests

  const maxInflight = perWorkerMaxInflightRequests * workerCount
  const maxBurst = perWorkerMaxBurstRequests * workerCount

  const readyTargetMultiplier = Math.max(1, runtimeConfig.judgmentsReadyTargetMultiplier)
  const readyTargetTotal = maxInflight * readyTargetMultiplier
  const normalizedJobCount = Math.max(1, runningJobCount)
  const readyTargetPerJob = Math.max(1, Math.ceil(readyTargetTotal / normalizedJobCount))

  const addToQueueMaxBatchSize = Math.max(1, runtimeConfig.judgmentsAddToQueueMaxBatchSize)

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
