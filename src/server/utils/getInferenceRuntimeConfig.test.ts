import {expect, test} from 'bun:test'

import type {ProviderRuntimeRecord} from '../../utils/providerRuntimeRecords.ts'
import {getInferenceRuntimeConfig} from './getInferenceRuntimeConfig.ts'

const buildRuntimeRecord = (overrides: Partial<ProviderRuntimeRecord> = {}): ProviderRuntimeRecord => {
  return {
    activeModelNames: ['Qwen/Qwen3.5-122B-A10B'],
    dpSize: 1,
    gpuGpusPerNode: 4,
    gpuNnodes: 2,
    gpuShape: null,
    jobId: '12345',
    localWorkerUrls: ['http://localhost:30001'],
    modelName: 'Qwen/Qwen3.5-122B-A10B',
    ppSize: 1,
    providerKind: 'sglang',
    remoteWorkerUrls: ['http://10.0.0.1:30000', 'http://10.0.0.2:30000'],
    sglangApiMaxBurstRequests: 64,
    sglangApiMaxInflightRequests: 48,
    sglangMaxRunningRequests: 32,
    sourceCluster: 'remote',
    sshJumpHost: 'remote-jump',
    status: 'active',
    stoppedAt: null,
    tpSize: 8,
    updatedAt: 10_000,
    version: 1,
    ...overrides,
  }
}

test('getInferenceRuntimeConfig applies runtime defaults when launcher runtime records are explicitly empty', () => {
  const runtimeConfig = getInferenceRuntimeConfig({envValues: {}, launcherRecords: []})

  expect(runtimeConfig.gpuNnodes).toBe(0)
  expect(runtimeConfig.gpuGpusPerNode).toBe(0)
  expect(runtimeConfig.gpuTotalGpus).toBe(0)
  expect(runtimeConfig.activeModelNames).toEqual([])
  expect(runtimeConfig.tpSize).toBe(0)
  expect(runtimeConfig.ppSize).toBe(0)
  expect(runtimeConfig.dpSize).toBe(0)
  expect(runtimeConfig.gpuShape).toBe('not set')
  expect(runtimeConfig.sglangMaxRunningRequests).toBe(0)
  expect(runtimeConfig.sglangApiMaxInflightRequests).toBe(0)
  expect(runtimeConfig.sglangApiMaxBurstRequests).toBe(0)
  expect(runtimeConfig.codexMaxInflight).toBe(0)
  expect(runtimeConfig.judgmentsReadyTargetMultiplier).toBe(2)
  expect(runtimeConfig.judgmentsAddToQueueMaxBatchSize).toBe(10000)
  expect(runtimeConfig.judgeFirstRequestPreviewChars).toBe(0)
  expect(runtimeConfig.judgeFirstRequestLogFull).toBe(false)
  expect(runtimeConfig.judgeChunkMaxParallel).toBe(0)
  expect(runtimeConfig.remoteWorkerUrls).toEqual([])
  expect(runtimeConfig.displayWorkerUrls).toEqual([])
  expect(runtimeConfig.providerKind).toBeNull()
  expect(runtimeConfig.sshJumpHost).toBeNull()
})

test('getInferenceRuntimeConfig prioritizes launcher runtime metadata', () => {
  const runtimeConfig = getInferenceRuntimeConfig({
    launcherRecords: [],
    envValues: {
      DP_SIZE: '9',
      FORSKA_RUNTIME_DP_SIZE: '1',
      FORSKA_RUNTIME_ACTIVE_MODEL_NAMES: 'Qwen/Qwen3.5-122B-A10B',
      FORSKA_RUNTIME_GPU_GPUS_PER_NODE: '4',
      FORSKA_RUNTIME_GPU_NNODES: '2',
      FORSKA_RUNTIME_LOCAL_WORKER_URLS: 'http://localhost:30001',
      FORSKA_RUNTIME_PROVIDER_KIND: 'sglang',
      FORSKA_RUNTIME_REMOTE_WORKER_URLS: 'http://10.0.0.1:30000, http://10.0.0.2:30000',
      FORSKA_RUNTIME_SGLANG_API_MAX_BURST_REQUESTS: '64',
      FORSKA_RUNTIME_SGLANG_API_MAX_INFLIGHT_REQUESTS: '48',
      FORSKA_RUNTIME_SGLANG_MAX_RUNNING_REQUESTS: '32',
      FORSKA_RUNTIME_SSH_JUMP_HOST: 'remote-jump',
      FORSKA_RUNTIME_TP_SIZE: '8',
      GPU_NNODES: '1',
      JUDGE_FIRST_REQUEST_LOG_FULL: 'true',
    },
  })

  expect(runtimeConfig.gpuNnodes).toBe(2)
  expect(runtimeConfig.gpuGpusPerNode).toBe(4)
  expect(runtimeConfig.gpuTotalGpus).toBe(8)
  expect(runtimeConfig.activeModelNames).toEqual(['Qwen/Qwen3.5-122B-A10B'])
  expect(runtimeConfig.tpSize).toBe(8)
  expect(runtimeConfig.dpSize).toBe(1)
  expect(runtimeConfig.sglangMaxRunningRequests).toBe(32)
  expect(runtimeConfig.sglangApiMaxInflightRequests).toBe(48)
  expect(runtimeConfig.sglangApiMaxBurstRequests).toBe(64)
  expect(runtimeConfig.remoteWorkerUrls).toEqual(['http://10.0.0.1:30000', 'http://10.0.0.2:30000'])
  expect(runtimeConfig.displayWorkerUrls).toEqual(['http://localhost:30001', 'http://10.0.0.2:30000'])
  expect(runtimeConfig.providerKind).toBe('sglang')
  expect(runtimeConfig.sshJumpHost).toBe('remote-jump')
  expect(runtimeConfig.judgeFirstRequestLogFull).toBe(true)
})

test('getInferenceRuntimeConfig falls back to legacy runtime wiring names when launcher runtime records are explicitly empty', () => {
  const runtimeConfig = getInferenceRuntimeConfig({
    launcherRecords: [],
    envValues: {
      GPU_NNODES: '1',
      GPU_GPUS_PER_NODE: '2',
      GPU_TOTAL_GPUS: '2',
      NVIDIA_SMI_SSH_JUMP_HOST: 'remote-jump',
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
  expect(runtimeConfig.sshJumpHost).toBe('remote-jump')
})

test('getInferenceRuntimeConfig prefers an active launcher runtime record over env wiring', () => {
  const runtimeConfig = getInferenceRuntimeConfig({
    envValues: {
      FORSKA_RUNTIME_ACTIVE_MODEL_NAMES: 'other/model',
      FORSKA_RUNTIME_LOCAL_WORKER_URLS: 'http://localhost:39999',
      FORSKA_RUNTIME_PROVIDER_KIND: 'vllm',
      FORSKA_RUNTIME_REMOTE_WORKER_URLS: 'http://10.9.0.1:30000',
    },
    launcherRecords: [buildRuntimeRecord()],
    now: 10_500,
  })

  expect(runtimeConfig.activeModelNames).toEqual(['Qwen/Qwen3.5-122B-A10B'])
  expect(runtimeConfig.providerKind).toBe('sglang')
  expect(runtimeConfig.remoteWorkerUrls).toEqual(['http://10.0.0.1:30000', 'http://10.0.0.2:30000'])
  expect(runtimeConfig.displayWorkerUrls).toEqual(['http://localhost:30001', 'http://10.0.0.2:30000'])
  expect(runtimeConfig.sshJumpHost).toBe('remote-jump')
})

test('getInferenceRuntimeConfig ignores stopped and stale launcher runtime records', () => {
  const runtimeConfig = getInferenceRuntimeConfig({
    envValues: {
      FORSKA_RUNTIME_ACTIVE_MODEL_NAMES: 'env/model',
      FORSKA_RUNTIME_LOCAL_WORKER_URLS: 'http://localhost:35555',
      FORSKA_RUNTIME_PROVIDER_KIND: 'sglang',
      FORSKA_RUNTIME_REMOTE_WORKER_URLS: 'http://10.8.0.1:30000',
    },
    launcherRecords: [
      buildRuntimeRecord({status: 'stopped', stoppedAt: 9_000, updatedAt: 9_000}),
      buildRuntimeRecord({jobId: '99999', updatedAt: 0}),
    ],
    now: 31_000,
  })

  expect(runtimeConfig.activeModelNames).toEqual(['env/model'])
  expect(runtimeConfig.displayWorkerUrls).toEqual(['http://localhost:35555'])
})
