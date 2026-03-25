import {expect, test} from 'bun:test'

import {getProviderConnectionEffectiveBaseURL, getProviderConnectionWorkerState} from './providerRuntimeState.ts'

test('runtime worker mode uses runtime worker urls only', () => {
  const workerState = getProviderConnectionWorkerState({
    config: {manualWorkerUrls: ['http://localhost:30010'], workerUrlMode: 'runtime'},
    providerKind: 'sglang',
  })

  expect(workerState.effectiveWorkerUrls).toEqual([])
  expect(workerState.workerSource).toBe('none')
})

test('manual worker mode prefers saved worker urls', () => {
  const workerState = getProviderConnectionWorkerState({
    config: {manualWorkerUrls: ['http://localhost:30010'], workerUrlMode: 'manual'},
    providerKind: 'openai',
  })

  expect(workerState.effectiveWorkerUrls).toEqual(['http://localhost:30010'])
  expect(workerState.workerSource).toBe('manual')
})

test('manual worker mode falls back to none when saved worker urls are missing', () => {
  const workerState = getProviderConnectionWorkerState({
    config: {manualWorkerUrls: [], workerUrlMode: 'manual'},
    providerKind: 'openai',
  })

  expect(workerState.effectiveWorkerUrls).toEqual([])
  expect(workerState.workerSource).toBe('none')
})

test('runtime worker mode uses runtime summary urls when provider kinds match', () => {
  const workerState = getProviderConnectionWorkerState({
    config: {manualWorkerUrls: [], workerUrlMode: 'runtime'},
    providerKind: 'sglang',
    runtimeSummary: {activeModelNames: [], providerKind: 'sglang', workerUrls: ['http://localhost:30001']},
  })

  expect(workerState.effectiveWorkerUrls).toEqual(['http://localhost:30001'])
  expect(workerState.workerSource).toBe('runtime')
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
