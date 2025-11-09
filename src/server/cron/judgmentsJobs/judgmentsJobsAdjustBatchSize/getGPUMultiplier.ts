import {env} from '../../../utils/env.ts'

const parseGpuFamily = (shape: unknown): string => {
  if (typeof shape === 'string') {
    const sepIndex = shape.indexOf(':')
    return sepIndex === -1 ? shape : shape.slice(0, sepIndex)
  }
  return 'unknown'
}

const getGPUTypeMultiplier = (): number => {
  const gpuType = parseGpuFamily(env.GPU_SHAPE)

  if (gpuType === 'H200') {
    return 3
  } else if (gpuType === 'A100fat') {
    return 2
  } else if (gpuType === 'A100') {
    return 2
  } else {
    return 2
  }
}
export const getGPUMultiplier = (): number => {
  const gpuTypeMultiplier = getGPUTypeMultiplier()
  const instance = env.GPU_TOTAL_GPUS / env.TP_SIZE

  return instance > 0 ? instance * gpuTypeMultiplier : 1
}
