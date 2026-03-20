import {expect, test} from 'bun:test'

import {getInferenceRuntimeConfig} from './getInferenceRuntimeConfig.ts'

test('getInferenceRuntimeConfig applies runtime defaults', () => {
  const runtimeConfig = getInferenceRuntimeConfig({envValues: {}})

  expect(runtimeConfig.gpuNnodes).toBe(0)
  expect(runtimeConfig.gpuGpusPerNode).toBe(0)
  expect(runtimeConfig.gpuTotalGpus).toBe(0)
  expect(runtimeConfig.tpSize).toBe(0)
  expect(runtimeConfig.ppSize).toBe(0)
  expect(runtimeConfig.dpSize).toBe(0)
  expect(runtimeConfig.gpuShape).toBe('not set')
  expect(runtimeConfig.sglangMaxRunningRequests).toBe(0)
  expect(runtimeConfig.sglangApiMaxInflightRequests).toBe(0)
  expect(runtimeConfig.sglangApiMaxBurstRequests).toBe(0)
  expect(runtimeConfig.codexMaxInflight).toBe(0)
  expect(runtimeConfig.judgmentsReadyTargetMultiplier).toBe(10)
  expect(runtimeConfig.judgmentsAddToQueueMaxBatchSize).toBe(10000)
  expect(runtimeConfig.judgeFirstRequestPreviewChars).toBe(0)
  expect(runtimeConfig.judgeFirstRequestLogFull).toBe(false)
  expect(runtimeConfig.judgeChunkMaxParallel).toBe(0)
  expect(runtimeConfig.remoteWorkerUrls).toEqual([])
  expect(runtimeConfig.displayWorkerUrls).toEqual([])
  expect(runtimeConfig.sshJumpHost).toBeNull()
})

test('getInferenceRuntimeConfig prioritizes launcher runtime metadata', () => {
  const runtimeConfig = getInferenceRuntimeConfig({
    envValues: {
      DP_SIZE: '9',
      FORSKA_RUNTIME_DP_SIZE: '1',
      FORSKA_RUNTIME_GPU_GPUS_PER_NODE: '4',
      FORSKA_RUNTIME_GPU_NNODES: '2',
      FORSKA_RUNTIME_LOCAL_WORKER_URLS: 'http://localhost:30001',
      FORSKA_RUNTIME_REMOTE_WORKER_URLS: 'http://10.0.0.1:30000, http://10.0.0.2:30000',
      FORSKA_RUNTIME_SGLANG_API_MAX_BURST_REQUESTS: '64',
      FORSKA_RUNTIME_SGLANG_API_MAX_INFLIGHT_REQUESTS: '48',
      FORSKA_RUNTIME_SGLANG_MAX_RUNNING_REQUESTS: '32',
      FORSKA_RUNTIME_SSH_JUMP_HOST: 'alvis2',
      FORSKA_RUNTIME_TP_SIZE: '8',
      GPU_NNODES: '1',
      JUDGE_FIRST_REQUEST_LOG_FULL: 'true',
    },
  })

  expect(runtimeConfig.gpuNnodes).toBe(2)
  expect(runtimeConfig.gpuGpusPerNode).toBe(4)
  expect(runtimeConfig.gpuTotalGpus).toBe(8)
  expect(runtimeConfig.tpSize).toBe(8)
  expect(runtimeConfig.dpSize).toBe(1)
  expect(runtimeConfig.sglangMaxRunningRequests).toBe(32)
  expect(runtimeConfig.sglangApiMaxInflightRequests).toBe(48)
  expect(runtimeConfig.sglangApiMaxBurstRequests).toBe(64)
  expect(runtimeConfig.remoteWorkerUrls).toEqual(['http://10.0.0.1:30000', 'http://10.0.0.2:30000'])
  expect(runtimeConfig.displayWorkerUrls).toEqual(['http://localhost:30001', 'http://10.0.0.2:30000'])
  expect(runtimeConfig.sshJumpHost).toBe('alvis2')
  expect(runtimeConfig.judgeFirstRequestLogFull).toBe(true)
})

test('getInferenceRuntimeConfig falls back to legacy runtime wiring names', () => {
  const runtimeConfig = getInferenceRuntimeConfig({
    envValues: {
      GPU_NNODES: '1',
      GPU_GPUS_PER_NODE: '2',
      GPU_TOTAL_GPUS: '2',
      NVIDIA_SMI_SSH_JUMP_HOST: 'alog',
      NVIDIA_SMI_WORKER_URLS: 'http://10.1.0.1:30000',
      NVIDIA_SMI_WORKER_URLS_LOCAL: 'http://localhost:30001',
      SGLANG_API_MAX_BURST_REQUESTS: '16',
      SGLANG_API_MAX_INFLIGHT_REQUESTS: '12',
      SGLANG_MAX_RUNNING_REQUESTS: '8',
      TP_SIZE: '2',
    },
  })

  expect(runtimeConfig.gpuTotalGpus).toBe(2)
  expect(runtimeConfig.tpSize).toBe(2)
  expect(runtimeConfig.sglangMaxRunningRequests).toBe(8)
  expect(runtimeConfig.sglangApiMaxInflightRequests).toBe(12)
  expect(runtimeConfig.sglangApiMaxBurstRequests).toBe(16)
  expect(runtimeConfig.remoteWorkerUrls).toEqual(['http://10.1.0.1:30000'])
  expect(runtimeConfig.displayWorkerUrls).toEqual(['http://localhost:30001'])
  expect(runtimeConfig.sshJumpHost).toBe('alog')
})
