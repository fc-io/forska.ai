import {expect, test} from 'bun:test'

import {getProviderConnectionWorkerState} from './providerRuntimeState.ts'

test('runtime worker mode uses runtime worker urls only', () => {
  const workerState = getProviderConnectionWorkerState({
    config: {manualWorkerUrls: ['http://localhost:30010'], workerUrlMode: 'runtime'},
    legacyWorkerUrls: ['http://localhost:30011'],
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

test('legacy worker urls stay as fallback when saved worker urls are missing', () => {
  const workerState = getProviderConnectionWorkerState({
    config: {manualWorkerUrls: [], workerUrlMode: 'manual'},
    legacyWorkerUrls: ['http://localhost:30011'],
    providerKind: 'openai',
  })

  expect(workerState.effectiveWorkerUrls).toEqual(['http://localhost:30011'])
  expect(workerState.workerSource).toBe('legacy')
})
