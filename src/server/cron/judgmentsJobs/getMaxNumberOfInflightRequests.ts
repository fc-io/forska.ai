import {env} from '../../utils/env.ts'

export const getMaxNumberOfInflightRequests = (): number => {
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

  return perEngine * workerCount
}
