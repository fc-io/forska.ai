import {expect, test} from 'bun:test'

import {
  getProviderConnectionEffectiveBaseURL,
  getProviderConnectionResolutionMode,
  getProviderConnectionRuntimeMatch,
  getProviderConnectionWorkerState,
} from './providerRuntimeState.ts'

test('runtime worker mode uses runtime worker urls only', () => {
  const workerState = getProviderConnectionWorkerState({
    baseURL: 'http://127.0.0.1:30000/v1',
    config: {manualWorkerUrls: ['http://localhost:30010'], workerUrlMode: 'runtime'},
    providerKind: 'sglang',
  })

  expect(workerState.effectiveWorkerUrls).toEqual([])
  expect(workerState.match.reason).toBe('runtime-provider-missing')
  expect(workerState.match.status).toBe('unreachable')
  expect(workerState.resolutionMode).toBe('auto-detect')
  expect(workerState.workerSource).toBe('none')
})

test('manual worker mode prefers saved worker urls', () => {
  const workerState = getProviderConnectionWorkerState({
    baseURL: 'http://127.0.0.1:11434/v1',
    config: {manualWorkerUrls: ['http://localhost:30010'], workerUrlMode: 'manual'},
    providerKind: 'openai',
  })

  expect(workerState.effectiveWorkerUrls).toEqual(['http://localhost:30010'])
  expect(workerState.match.effectiveBaseURL).toBe('http://127.0.0.1:11434/v1')
  expect(workerState.match.source).toBe('saved-manual-worker')
  expect(workerState.match.status).toBe('manual-only')
  expect(workerState.resolutionMode).toBe('manual')
  expect(workerState.workerSource).toBe('manual')
})

test('manual worker mode falls back to none when saved worker urls are missing', () => {
  const workerState = getProviderConnectionWorkerState({
    baseURL: 'https://api.openai.com/v1',
    config: {manualWorkerUrls: [], workerUrlMode: 'manual'},
    providerKind: 'openai',
  })

  expect(workerState.effectiveWorkerUrls).toEqual([])
  expect(workerState.match.reason).toBe('manual-base-url')
  expect(workerState.match.status).toBe('manual-only')
  expect(workerState.workerSource).toBe('none')
})

test('runtime worker mode uses runtime summary urls only when saved base url overlaps', () => {
  const workerState = getProviderConnectionWorkerState({
    baseURL: 'http://127.0.0.1:30000/v1',
    config: {manualWorkerUrls: [], workerUrlMode: 'runtime'},
    providerKind: 'sglang',
    runtimeSummary: {
      activeModelNames: [],
      providerKind: 'sglang',
      sourceMetadata: null,
      workerUrls: ['http://localhost:30001'],
    },
  })

  expect(workerState.effectiveWorkerUrls).toEqual([])
  expect(workerState.match.reason).toBe('runtime-url-missing')
  expect(workerState.match.status).toBe('unreachable')
  expect(workerState.workerSource).toBe('none')
})

test('runtime worker mode matches when the saved base url overlaps the detected runtime', () => {
  const workerState = getProviderConnectionWorkerState({
    baseURL: 'http://localhost:30001/v1',
    config: {manualWorkerUrls: [], workerUrlMode: 'runtime'},
    providerKind: 'sglang',
    runtimeSummary: {
      activeModelNames: ['Qwen/Qwen3'],
      providerKind: 'sglang',
      sourceMetadata: {cluster: null, jobId: null, kind: 'local', label: 'local', sshJumpHost: null},
      workerUrls: ['http://localhost:30001'],
    },
    savedModelIds: ['Qwen/Qwen3'],
  })

  expect(workerState.effectiveWorkerUrls).toEqual(['http://localhost:30001'])
  expect(workerState.match.detectedModelNames).toEqual(['Qwen/Qwen3'])
  expect(workerState.match.reason).toBe('runtime-auto-detect')
  expect(workerState.match.reasons).toEqual([
    'runtime-auto-detect',
    'runtime-base-url-overlap',
    'runtime-model-overlap',
  ])
  expect(workerState.match.sourceMetadata).toEqual({
    cluster: null,
    jobId: null,
    kind: 'local',
    label: 'local',
    sshJumpHost: null,
  })
  expect(workerState.match.status).toBe('matched')
  expect(workerState.workerSource).toBe('runtime')
})

test('saved model ids strengthen a url match but cannot replace missing url overlap', () => {
  const runtimeMatch = getProviderConnectionRuntimeMatch({
    baseURL: 'http://127.0.0.1:30000/v1',
    config: {manualWorkerUrls: [], workerUrlMode: 'runtime'},
    providerKind: 'sglang',
    runtimeSummary: {
      activeModelNames: ['Qwen/Qwen3'],
      providerKind: 'sglang',
      sourceMetadata: {cluster: null, jobId: null, kind: 'local', label: 'local', sshJumpHost: null},
      workerUrls: ['http://localhost:30001'],
    },
    savedModelIds: ['Qwen/Qwen3'],
  })

  expect(runtimeMatch.detectedModelNames).toEqual(['Qwen/Qwen3'])
  expect(runtimeMatch.reason).toBe('runtime-url-missing')
  expect(runtimeMatch.reasons).toEqual(['runtime-auto-detect', 'runtime-model-overlap'])
  expect(runtimeMatch.status).toBe('unreachable')
})

test('runtime worker mode is ambiguous when saved base and worker urls conflict', () => {
  const workerState = getProviderConnectionWorkerState({
    baseURL: 'http://localhost:30001/v1',
    config: {manualWorkerUrls: ['http://localhost:30002'], workerUrlMode: 'runtime'},
    providerKind: 'sglang',
    runtimeSummary: {
      activeModelNames: ['Qwen/Qwen3'],
      providerKind: 'sglang',
      sourceMetadata: {cluster: 'alvis', jobId: 'job-1', kind: 'launcher', label: 'Alvis', sshJumpHost: 'alvis2'},
      workerUrls: ['http://localhost:30001'],
    },
  })

  expect(workerState.effectiveWorkerUrls).toEqual([])
  expect(workerState.match.reason).toBe('runtime-url-conflict')
  expect(workerState.match.sourceMetadata).toEqual({
    cluster: 'alvis',
    jobId: 'job-1',
    kind: 'launcher',
    label: 'Alvis',
    sshJumpHost: 'alvis2',
  })
  expect(workerState.match.status).toBe('ambiguous')
  expect(workerState.workerSource).toBe('none')
})

test('legacy runtime worker mode resolves through auto-detect compatibility', () => {
  const resolutionMode = getProviderConnectionResolutionMode({
    config: {manualWorkerUrls: [], workerUrlMode: 'runtime'},
    providerKind: 'vllm',
  })

  expect(resolutionMode).toBe('auto-detect')
})

test('manual providers remain manual even when runtime mode is saved', () => {
  const resolutionMode = getProviderConnectionResolutionMode({
    config: {manualWorkerUrls: [], workerUrlMode: 'runtime'},
    providerKind: 'openai',
  })

  expect(resolutionMode).toBe('manual')
})

test('runtime match keeps the saved base url as fallback source of truth', () => {
  const runtimeMatch = getProviderConnectionRuntimeMatch({
    baseURL: 'http://127.0.0.1:30000/v1',
    config: {manualWorkerUrls: [], workerUrlMode: 'runtime'},
    providerKind: 'sglang',
    runtimeSummary: {
      activeModelNames: ['Qwen/Qwen3'],
      providerKind: 'vllm',
      sourceMetadata: {cluster: 'mn5', jobId: 'job-2', kind: 'launcher', label: 'MN5', sshJumpHost: 'alog'},
      workerUrls: ['http://localhost:30001'],
    },
  })

  expect(runtimeMatch).toEqual({
    candidate: null,
    detectedModelNames: [],
    effectiveBaseURL: 'http://127.0.0.1:30000/v1',
    effectiveWorkerUrls: [],
    localUrls: [],
    modelNames: [],
    reason: 'runtime-provider-mismatch',
    reasons: ['runtime-provider-mismatch'],
    remoteUrls: [],
    resolutionMode: 'auto-detect',
    sourceMetadata: {cluster: 'mn5', jobId: 'job-2', kind: 'launcher', label: 'MN5', sshJumpHost: 'alog'},
    source: 'none',
    status: 'unreachable',
  })
})

test('effective provider base url prefers runtime worker urls', () => {
  const baseURL = getProviderConnectionEffectiveBaseURL({
    baseURL: 'http://127.0.0.1:30000/v1',
    config: {manualWorkerUrls: [], workerUrlMode: 'runtime'},
    providerKind: 'sglang',
    runtimeSummary: {
      activeModelNames: [],
      providerKind: 'sglang',
      sourceMetadata: null,
      workerUrls: ['http://localhost:30001'],
    },
  })

  expect(baseURL).toBe('http://127.0.0.1:30000/v1')
})

test('effective provider base url uses the matched runtime url when saved and detected urls overlap', () => {
  const baseURL = getProviderConnectionEffectiveBaseURL({
    baseURL: 'http://localhost:30001/v1',
    config: {manualWorkerUrls: [], workerUrlMode: 'runtime'},
    providerKind: 'sglang',
    runtimeSummary: {
      activeModelNames: [],
      providerKind: 'sglang',
      sourceMetadata: null,
      workerUrls: ['http://localhost:30001'],
    },
  })

  expect(baseURL).toBe('http://localhost:30001/v1')
})

test('effective provider base url falls back to saved base url when no worker urls are active', () => {
  const baseURL = getProviderConnectionEffectiveBaseURL({
    baseURL: 'http://127.0.0.1:30000/v1',
    config: {manualWorkerUrls: [], workerUrlMode: 'runtime'},
    providerKind: 'sglang',
    runtimeSummary: {
      activeModelNames: [],
      providerKind: 'vllm',
      sourceMetadata: null,
      workerUrls: ['http://localhost:30001'],
    },
  })

  expect(baseURL).toBe('http://127.0.0.1:30000/v1')
})
