import {expect, test} from 'bun:test'

import {getProviderCatalogEntry, isOpenAICompatibleProvider, normalizeProviderKind} from './providerCatalog.ts'

test('provider catalog normalizes llamacpp and returns its local defaults', () => {
  const entry = getProviderCatalogEntry('LLAMACPP')

  expect(normalizeProviderKind('LLAMACPP')).toBe('llamacpp')
  expect(isOpenAICompatibleProvider('llamacpp')).toBe(true)
  expect(entry).toEqual({
    defaultBaseURL: 'http://127.0.0.1:8080',
    description: 'Local llama.cpp llama-server OpenAI-compatible endpoint',
    kind: 'llamacpp',
    label: 'llama.cpp / llama-server',
    requiresApiKey: false,
    supportsDiscovery: true,
    supportsWorkerUrls: false,
  })
})
