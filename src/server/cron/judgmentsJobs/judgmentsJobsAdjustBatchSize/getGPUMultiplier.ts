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
  console.log('gpuType', gpuType)
  if (gpuType === 'H200') {
    return 4
  } else if (gpuType === 'A100-SXM4-80GB') {
    return 1.2
    // we only run A100 with tp=2
  } else if (gpuType === 'A100-SXM4-40GB') {
    return 1.4
  } else {
    return 1
  }
}
export const getGPUMultiplier = (): number => {
  const gpuTypeMultiplier = getGPUTypeMultiplier()
  const instance = env.GPU_TOTAL_GPUS / env.TP_SIZE

  return instance > 0 ? instance * gpuTypeMultiplier : 1
}
