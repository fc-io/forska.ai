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

  expect(persisted).toEqual({manualWorkerUrls: [], workerUrlMode: 'runtime'})
})
