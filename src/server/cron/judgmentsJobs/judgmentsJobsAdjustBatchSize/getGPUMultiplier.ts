import {env} from '../../../utils/env.ts'

export const getGPUMultiplier = (): number => {
  const dp = env.DP_SIZE
  const nn = env.GPU_NNODES
  const product = dp * nn

  return product > 0 ? product : 1
}
