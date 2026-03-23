import {type as arktype} from 'arktype'

const inferenceRuntimeShape = arktype({
  activeModelNames: 'string | null | undefined',
  bunConfigMaxHttpRequests: 'string | null | undefined',
  codexMaxInflight: 'number | string.integer.parse',
  dpSize: 'number | string.integer.parse',
  gpuGpusPerNode: 'number | string.integer.parse',
  gpuNnodes: 'number | string.integer.parse',
  gpuShape: 'string | null | undefined',
  gpuTotalGpus: 'number | string.integer.parse',
  judgeChunkMaxParallel: 'number | string.integer.parse',
  judgeFirstRequestLogFull: arktype('"true" | "false" | boolean').pipe((value) => {
    return typeof value === 'string' ? value.toLowerCase() === 'true' : value
  }),
  judgeFirstRequestPreviewChars: 'number | string.integer.parse',
  judgmentsAddToQueueMaxBatchSize: 'number | string.integer.parse',
  judgmentsReadyTargetMultiplier: 'number | string.integer.parse',
  localWorkerUrls: 'string | null | undefined',
  ppSize: 'number | string.integer.parse',
  providerKind: 'string | null | undefined',
  remoteWorkerUrls: 'string | null | undefined',
  sglangApiMaxBurstRequests: 'number | string.integer.parse',
  sglangApiMaxInflightRequests: 'number | string.integer.parse',
  sglangMaxRunningRequests: 'number | string.integer.parse',
  sshJumpHost: 'string | null | undefined',
  tpSize: 'number | string.integer.parse',
})

const getTrimmedValue = (value: string | null | undefined): string | null => {
  const normalized = String(value ?? '').trim()

  return normalized === '' ? null : normalized
}

const getFirstConfiguredValue = ({
  envValues,
  fallback,
  keys,
}: {
  envValues: Record<string, string | undefined>
  fallback: string
  keys: string[]
}): string => {
  const configuredValue = keys.reduce<string | null>((resolved, key) => {
    return resolved ?? getTrimmedValue(envValues[key])
  }, null)

  return configuredValue ?? fallback
}

const splitCsvValue = (value: string | null | undefined): string[] => {
  return String(value ?? '')
    .split(',')
    .map((entry) => {
      return entry.trim()
    })
    .filter((entry) => {
      return entry.length > 0
    })
}

const getDisplayWorkerUrls = (remoteWorkerUrls: string[], localWorkerUrls: string[]): string[] => {
  return remoteWorkerUrls.map((remoteWorkerUrl, index) => {
    return localWorkerUrls[index] ?? remoteWorkerUrl
  })
}

export const getInferenceRuntimeConfig = ({
  envValues = process.env,
}: {envValues?: Record<string, string | undefined>} = {}) => {
  const gpuNnodes = getFirstConfiguredValue({
    envValues,
    fallback: '0',
    keys: ['FORSKA_RUNTIME_GPU_NNODES', 'GPU_NNODES'],
  })
  const gpuGpusPerNode = getFirstConfiguredValue({
    envValues,
    fallback: '0',
    keys: ['FORSKA_RUNTIME_GPU_GPUS_PER_NODE', 'GPU_GPUS_PER_NODE'],
  })
  const parsed = inferenceRuntimeShape.assert({
    activeModelNames: getFirstConfiguredValue({envValues, fallback: '', keys: ['FORSKA_RUNTIME_ACTIVE_MODEL_NAMES']}),
    bunConfigMaxHttpRequests: getTrimmedValue(envValues.BUN_CONFIG_MAX_HTTP_REQUESTS),
    codexMaxInflight: getFirstConfiguredValue({envValues, fallback: '0', keys: ['CODEX_MAX_INFLIGHT']}),
    dpSize: getFirstConfiguredValue({envValues, fallback: '0', keys: ['FORSKA_RUNTIME_DP_SIZE', 'DP_SIZE']}),
    gpuGpusPerNode,
    gpuNnodes,
    gpuShape: getFirstConfiguredValue({
      envValues,
      fallback: 'not set',
      keys: ['FORSKA_RUNTIME_GPU_SHAPE', 'GPU_SHAPE'],
    }),
    gpuTotalGpus: getFirstConfiguredValue({
      envValues,
      fallback: String(Number(gpuNnodes) * Number(gpuGpusPerNode) || 0),
      keys: ['FORSKA_RUNTIME_GPU_TOTAL_GPUS', 'GPU_TOTAL_GPUS'],
    }),
    judgeChunkMaxParallel: getFirstConfiguredValue({envValues, fallback: '0', keys: ['JUDGE_CHUNK_MAX_PARALLEL']}),
    judgeFirstRequestLogFull: getFirstConfiguredValue({
      envValues,
      fallback: 'false',
      keys: ['JUDGE_FIRST_REQUEST_LOG_FULL'],
    }),
    judgeFirstRequestPreviewChars: getFirstConfiguredValue({
      envValues,
      fallback: '0',
      keys: ['JUDGE_FIRST_REQUEST_PREVIEW_CHARS'],
    }),
    judgmentsAddToQueueMaxBatchSize: getFirstConfiguredValue({
      envValues,
      fallback: '10000',
      keys: ['JUDGMENTS_ADD_TO_QUEUE_MAX_BATCH_SIZE'],
    }),
    judgmentsReadyTargetMultiplier: getFirstConfiguredValue({
      envValues,
      fallback: '10',
      keys: ['JUDGMENTS_READY_TARGET_MULTIPLIER'],
    }),
    localWorkerUrls: getFirstConfiguredValue({
      envValues,
      fallback: '',
      keys: ['FORSKA_RUNTIME_LOCAL_WORKER_URLS', 'NVIDIA_SMI_WORKER_URLS_LOCAL'],
    }),
    ppSize: getFirstConfiguredValue({envValues, fallback: '0', keys: ['FORSKA_RUNTIME_PP_SIZE', 'PP_SIZE']}),
    providerKind: getFirstConfiguredValue({envValues, fallback: '', keys: ['FORSKA_RUNTIME_PROVIDER_KIND']}),
    remoteWorkerUrls: getFirstConfiguredValue({
      envValues,
      fallback: '',
      keys: ['FORSKA_RUNTIME_REMOTE_WORKER_URLS', 'NVIDIA_SMI_WORKER_URLS'],
    }),
    sglangApiMaxBurstRequests: getFirstConfiguredValue({
      envValues,
      fallback: '0',
      keys: ['FORSKA_RUNTIME_SGLANG_API_MAX_BURST_REQUESTS', 'SGLANG_API_MAX_BURST_REQUESTS'],
    }),
    sglangApiMaxInflightRequests: getFirstConfiguredValue({
      envValues,
      fallback: '0',
      keys: ['FORSKA_RUNTIME_SGLANG_API_MAX_INFLIGHT_REQUESTS', 'SGLANG_API_MAX_INFLIGHT_REQUESTS'],
    }),
    sglangMaxRunningRequests: getFirstConfiguredValue({
      envValues,
      fallback: '0',
      keys: ['FORSKA_RUNTIME_SGLANG_MAX_RUNNING_REQUESTS', 'SGLANG_MAX_RUNNING_REQUESTS'],
    }),
    sshJumpHost: getFirstConfiguredValue({
      envValues,
      fallback: '',
      keys: ['FORSKA_RUNTIME_SSH_JUMP_HOST', 'NVIDIA_SMI_SSH_JUMP_HOST'],
    }),
    tpSize: getFirstConfiguredValue({envValues, fallback: '0', keys: ['FORSKA_RUNTIME_TP_SIZE', 'TP_SIZE']}),
  })
  const remoteWorkerUrls = splitCsvValue(parsed.remoteWorkerUrls)
  const localWorkerUrls = splitCsvValue(parsed.localWorkerUrls)

  return {
    activeModelNames: splitCsvValue(parsed.activeModelNames),
    bunConfigMaxHttpRequests: getTrimmedValue(parsed.bunConfigMaxHttpRequests),
    codexMaxInflight: parsed.codexMaxInflight,
    displayWorkerUrls: getDisplayWorkerUrls(remoteWorkerUrls, localWorkerUrls),
    dpSize: parsed.dpSize,
    gpuGpusPerNode: parsed.gpuGpusPerNode,
    gpuNnodes: parsed.gpuNnodes,
    gpuShape: getTrimmedValue(parsed.gpuShape),
    gpuTotalGpus: parsed.gpuTotalGpus,
    judgeChunkMaxParallel: parsed.judgeChunkMaxParallel,
    judgeFirstRequestLogFull: parsed.judgeFirstRequestLogFull,
    judgeFirstRequestPreviewChars: parsed.judgeFirstRequestPreviewChars,
    judgmentsAddToQueueMaxBatchSize: parsed.judgmentsAddToQueueMaxBatchSize,
    judgmentsReadyTargetMultiplier: parsed.judgmentsReadyTargetMultiplier,
    localWorkerUrls,
    ppSize: parsed.ppSize,
    providerKind: getTrimmedValue(parsed.providerKind),
    remoteWorkerUrls,
    sglangApiMaxBurstRequests: parsed.sglangApiMaxBurstRequests,
    sglangApiMaxInflightRequests: parsed.sglangApiMaxInflightRequests,
    sglangMaxRunningRequests: parsed.sglangMaxRunningRequests,
    sshJumpHost: getTrimmedValue(parsed.sshJumpHost),
    tpSize: parsed.tpSize,
  }
}

export type InferenceRuntimeConfig = ReturnType<typeof getInferenceRuntimeConfig>

export const inferenceRuntimeConfig = getInferenceRuntimeConfig()
