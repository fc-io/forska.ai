import {env} from '../../utils/env.ts'

export const getMaxNumberOfInflightRequests = (): number => {
  const inFlightOverride = Math.max(0, env.SGLANG_API_MAX_INFLIGHT_REQUESTS)
  const perEngine = Math.max(1, Number(env.SGLANG_MAX_RUNNING_REQUESTS || 0))

  // Prefer explicit worker URLs when router is enabled; otherwise
  // estimate workers from GPU/Tensor Parallel topology.
  const workerCountFromEnv = Array.isArray(env.WORKER_URLS) ? env.WORKER_URLS.length : 0
  const estimatedWorkers = Math.max(
    1,
    Math.floor(
      Number(env.GPU_TOTAL_GPUS || 0)
      / (Math.max(1, Number(env.TP_SIZE || 1)) * Math.max(1, Number(env.PP_SIZE || 1))),
    ),
  )
  const workerCount = Math.max(1, workerCountFromEnv > 0 ? workerCountFromEnv : estimatedWorkers)

  const computed = perEngine * workerCount
  return inFlightOverride > 0 ? inFlightOverride : computed
}
