import {expect, test} from 'bun:test'

import {getPersistedProviderConnectionConfigValue} from './providerDbUtils.ts'

test('provider connection config persistence drops empty default manual config', () => {
  const persisted = getPersistedProviderConnectionConfigValue({
    config: {manualWorkerUrls: [], workerUrlMode: 'manual'},
    providerKind: 'openai',
  })

  expect(persisted).toBeNull()
})

test('provider connection config persistence keeps runtime worker mode for runtime providers', () => {
  const persisted = getPersistedProviderConnectionConfigValue({
    config: {manualWorkerUrls: [], workerUrlMode: 'runtime'},
    providerKind: 'sglang',
  })

  expect(persisted).toEqual({archived: false, disabledModelIds: [], manualWorkerUrls: [], workerUrlMode: 'runtime'})
})

test('provider connection config persistence drops default llama.cpp server mode', () => {
  const persisted = getPersistedProviderConnectionConfigValue({
    config: {llamaCppMode: 'server', manualWorkerUrls: [], workerUrlMode: 'manual'},
    providerKind: 'llamacpp',
  })

  expect(persisted).toBeNull()
})

test('provider connection config persistence keeps llama.cpp cli mode', () => {
  const persisted = getPersistedProviderConnectionConfigValue({
    config: {llamaCppMode: 'cli', manualWorkerUrls: [], workerUrlMode: 'manual'},
    providerKind: 'llamacpp',
  })

  expect(persisted).toEqual({
    archived: false,
    disabledModelIds: [],
    llamaCppMode: 'cli',
    manualWorkerUrls: [],
    workerUrlMode: 'manual',
  })
})
