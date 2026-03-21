type ForskaRuntimeEnvOptions = {
  dpSize: string
  gpuGpusPerNode: string
  gpuNnodes: string
  gpuShape?: string | null
  localWorkerUrls: string
  ppSize?: string | null
  providerKind: string
  remoteWorkerUrls: string
  sglangApiMaxBurstRequests: string
  sglangApiMaxInflightRequests: string
  sglangMaxRunningRequests: string
  sshJumpHost: string | null
  tpSize: string
}

const getTrimmedValue = (value: string | null | undefined): string | null => {
  const normalized = String(value ?? '').trim()

  return normalized === '' ? null : normalized
}

const getIntegerString = (value: string | null | undefined, fallback: string): string => {
  return getTrimmedValue(value) ?? fallback
}

const getGpuTotalGpus = ({gpuGpusPerNode, gpuNnodes}: {gpuGpusPerNode: string; gpuNnodes: string}): string => {
  const total = Number(gpuNnodes) * Number(gpuGpusPerNode)

  return Number.isFinite(total) ? String(total) : '0'
}

export const getForskaRuntimeEnv = ({
  dpSize,
  gpuGpusPerNode,
  gpuNnodes,
  gpuShape,
  localWorkerUrls,
  ppSize,
  providerKind,
  remoteWorkerUrls,
  sglangApiMaxBurstRequests,
  sglangApiMaxInflightRequests,
  sglangMaxRunningRequests,
  sshJumpHost,
  tpSize,
}: ForskaRuntimeEnvOptions): Record<string, string> => {
  const normalizedGpuNnodes = getIntegerString(gpuNnodes, '0')
  const normalizedGpuGpusPerNode = getIntegerString(gpuGpusPerNode, '0')

  return {
    FORSKA_RUNTIME_DP_SIZE: getIntegerString(dpSize, '0'),
    FORSKA_RUNTIME_GPU_GPUS_PER_NODE: normalizedGpuGpusPerNode,
    FORSKA_RUNTIME_GPU_NNODES: normalizedGpuNnodes,
    FORSKA_RUNTIME_GPU_SHAPE: getTrimmedValue(gpuShape) ?? '',
    FORSKA_RUNTIME_GPU_TOTAL_GPUS: getGpuTotalGpus({
      gpuGpusPerNode: normalizedGpuGpusPerNode,
      gpuNnodes: normalizedGpuNnodes,
    }),
    FORSKA_RUNTIME_LOCAL_WORKER_URLS: getTrimmedValue(localWorkerUrls) ?? '',
    FORSKA_RUNTIME_PP_SIZE: getIntegerString(ppSize, '1'),
    FORSKA_RUNTIME_PROVIDER_KIND: getTrimmedValue(providerKind) ?? '',
    FORSKA_RUNTIME_REMOTE_WORKER_URLS: getTrimmedValue(remoteWorkerUrls) ?? '',
    FORSKA_RUNTIME_SGLANG_API_MAX_BURST_REQUESTS: getIntegerString(sglangApiMaxBurstRequests, '0'),
    FORSKA_RUNTIME_SGLANG_API_MAX_INFLIGHT_REQUESTS: getIntegerString(sglangApiMaxInflightRequests, '0'),
    FORSKA_RUNTIME_SGLANG_MAX_RUNNING_REQUESTS: getIntegerString(sglangMaxRunningRequests, '0'),
    FORSKA_RUNTIME_SSH_JUMP_HOST: getTrimmedValue(sshJumpHost) ?? '',
    FORSKA_RUNTIME_TP_SIZE: getIntegerString(tpSize, '0'),
  }
}
