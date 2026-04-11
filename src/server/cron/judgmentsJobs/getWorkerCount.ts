import {getInferenceRuntimeConfig} from '../../utils/getInferenceRuntimeConfig.ts'

export const getWorkerCount = (): number => {
  const runtimeConfig = getInferenceRuntimeConfig()
  const estimatedWorkers = Math.max(
    1,
    Math.floor(
      Number(runtimeConfig.gpuTotalGpus || 0)
        / (Math.max(1, Number(runtimeConfig.tpSize || 1)) * Math.max(1, Number(runtimeConfig.ppSize || 1))),
    ),
  )

  return Math.max(1, estimatedWorkers)
}
