import {inferenceRuntimeConfig} from '../../utils/getInferenceRuntimeConfig.ts'

export const getWorkerCount = (): number => {
  const estimatedWorkers = Math.max(
    1,
    Math.floor(
      Number(inferenceRuntimeConfig.gpuTotalGpus || 0)
        / (Math.max(1, Number(inferenceRuntimeConfig.tpSize || 1))
          * Math.max(1, Number(inferenceRuntimeConfig.ppSize || 1))),
    ),
  )

  return Math.max(1, estimatedWorkers)
}
