import {env} from '../../utils/env.ts'
import {getWorkerCount} from './getWorkerCount.ts'

export const getMaxNumberOfInflightRequests = (): number => {
  const inFlightOverride = Math.max(0, env.SGLANG_API_MAX_INFLIGHT_REQUESTS)
  const perEngine = Math.max(1, Number(env.SGLANG_MAX_RUNNING_REQUESTS || 0))
  const workerCount = getWorkerCount()

  const computed = perEngine * workerCount
  const computedInFlight = inFlightOverride * workerCount

  return inFlightOverride > 0 ? computedInFlight : computed
}
