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
  expect(workerState.match.source).toBe('saved-manual-worker')
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
  expect(workerState.workerSource).toBe('none')
})

test('runtime worker mode uses runtime summary urls when provider kinds match', () => {
  const workerState = getProviderConnectionWorkerState({
    baseURL: 'http://127.0.0.1:30000/v1',
    config: {manualWorkerUrls: [], workerUrlMode: 'runtime'},
    providerKind: 'sglang',
    runtimeSummary: {activeModelNames: [], providerKind: 'sglang', workerUrls: ['http://localhost:30001']},
  })

  expect(workerState.effectiveWorkerUrls).toEqual(['http://localhost:30001'])
  expect(workerState.match.reason).toBe('runtime-auto-detect')
  expect(workerState.workerSource).toBe('runtime')
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
    runtimeSummary: {activeModelNames: ['Qwen/Qwen3'], providerKind: 'vllm', workerUrls: ['http://localhost:30001']},
  })

  expect(runtimeMatch).toEqual({
    candidate: null,
    localUrls: [],
    modelNames: [],
    reason: 'runtime-provider-mismatch',
    remoteUrls: [],
    resolutionMode: 'auto-detect',
    source: 'none',
    status: 'unavailable',
  })
})

test('effective provider base url prefers runtime worker urls', () => {
  const baseURL = getProviderConnectionEffectiveBaseURL({
    baseURL: 'http://127.0.0.1:30000/v1',
    config: {manualWorkerUrls: [], workerUrlMode: 'runtime'},
    providerKind: 'sglang',
    runtimeSummary: {activeModelNames: [], providerKind: 'sglang', workerUrls: ['http://localhost:30001']},
  })

  expect(baseURL).toBe('http://localhost:30001/v1')
})

test('effective provider base url falls back to saved base url when no worker urls are active', () => {
  const baseURL = getProviderConnectionEffectiveBaseURL({
    baseURL: 'http://127.0.0.1:30000/v1',
    config: {manualWorkerUrls: [], workerUrlMode: 'runtime'},
    providerKind: 'sglang',
    runtimeSummary: {activeModelNames: [], providerKind: 'vllm', workerUrls: ['http://localhost:30001']},
  })

  expect(baseURL).toBe('http://127.0.0.1:30000/v1')
})
