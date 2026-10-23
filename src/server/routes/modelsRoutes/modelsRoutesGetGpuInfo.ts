import {getInferenceRuntimeConfig} from '../../utils/getInferenceRuntimeConfig.ts'

export const modelsRoutesGetGpuInfo = async () => {
  const runtimeConfig = getInferenceRuntimeConfig()

  return {
    data: {
      DP_SIZE: runtimeConfig.dpSize,
      GPU_GPUS_PER_NODE: runtimeConfig.gpuGpusPerNode,
      GPU_NNODES: runtimeConfig.gpuNnodes,
      GPU_SHAPE: runtimeConfig.gpuShape,
      GPU_TOTAL_GPUS: runtimeConfig.gpuTotalGpus,
      SGLANG_MAX_RUNNING_REQUESTS: runtimeConfig.sglangMaxRunningRequests,
      TP_SIZE: runtimeConfig.tpSize,
    },
  }
}
