import {expect, test} from 'bun:test'

import {
  getProviderCatalogOptions,
  getProviderDisplayLabel,
  getProviderSelectionKind,
  shouldHideProviderBaseURLField,
} from './providerCatalogUi.ts'

const catalog = [
  {
    defaultBaseURL: 'http://127.0.0.1:8080',
    description: 'Local llama.cpp llama-server OpenAI-compatible endpoint',
    kind: 'llamacpp',
    label: 'llama.cpp / llama-server',
    requiresApiKey: false,
    supportsDiscovery: true,
    supportsWorkerUrls: false,
  },
  {
    defaultBaseURL: 'https://api.openai.com/v1',
    description: 'OpenAI API and compatible gateways',
    kind: 'openai',
    label: 'OpenAI API',
    requiresApiKey: true,
    supportsDiscovery: true,
    supportsWorkerUrls: false,
  },
]

test('provider catalog UI splits llama.cpp into cli and server options', () => {
  expect(getProviderCatalogOptions(catalog)).toEqual([
    {
      defaultBaseURL: 'http://127.0.0.1:8080',
      description: 'Local llama.cpp CLI using the built-in local default endpoint',
      hideBaseURLField: true,
      kind: 'llamacpp',
      label: 'llama.cpp CLI',
      requiresApiKey: false,
      selectedKind: 'llamacpp-cli',
      supportsDiscovery: true,
      supportsWorkerUrls: false,
    },
    {
      defaultBaseURL: 'http://127.0.0.1:8080',
      description: 'Local llama-server OpenAI-compatible endpoint',
      kind: 'llamacpp',
      label: 'llama.cpp Server',
      requiresApiKey: false,
      selectedKind: 'llamacpp-server',
      supportsDiscovery: true,
      supportsWorkerUrls: false,
    },
    {
      defaultBaseURL: 'https://api.openai.com/v1',
      description: 'OpenAI API and compatible gateways',
      kind: 'openai',
      label: 'OpenAI API',
      requiresApiKey: true,
      selectedKind: 'openai',
      supportsDiscovery: true,
      supportsWorkerUrls: false,
    },
  ])
})

test('provider catalog UI defaults llama.cpp connections to server mode unless cli is stored', () => {
  expect(getProviderSelectionKind({providerKind: 'llamacpp'})).toBe('llamacpp-server')
  expect(
    getProviderSelectionKind({
      config: {llamaCppMode: 'cli', manualWorkerUrls: [], workerUrlMode: 'manual'},
      providerKind: 'llamacpp',
    }),
  ).toBe('llamacpp-cli')
  expect(
    shouldHideProviderBaseURLField({
      config: {llamaCppMode: 'cli', manualWorkerUrls: [], workerUrlMode: 'manual'},
      providerKind: 'llamacpp',
    }),
  ).toBe(true)
  expect(shouldHideProviderBaseURLField({providerKind: 'llamacpp'})).toBe(false)
})

test('provider catalog UI returns the variant-specific provider label', () => {
  expect(getProviderDisplayLabel({catalog, providerKind: 'llamacpp'})).toBe('llama.cpp Server')
  expect(
    getProviderDisplayLabel({
      catalog,
      config: {llamaCppMode: 'cli', manualWorkerUrls: [], workerUrlMode: 'manual'},
      providerKind: 'llamacpp',
    }),
  ).toBe('llama.cpp CLI')
  expect(getProviderDisplayLabel({catalog, providerKind: 'openai'})).toBe('OpenAI API')
})
