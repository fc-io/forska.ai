import {env} from '../../utils/env.ts'

export const getWorkerCount = (): number => {
  const estimatedWorkers = Math.max(
    1,
    Math.floor(
      Number(env.GPU_TOTAL_GPUS || 0) / (Math.max(1, Number(env.TP_SIZE || 1)) * Math.max(1, Number(env.PP_SIZE || 1))),
    ),
  )

  return Math.max(1, estimatedWorkers)
}
