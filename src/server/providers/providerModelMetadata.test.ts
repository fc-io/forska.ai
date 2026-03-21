import {expect, test} from 'bun:test'

import {
  getNormalizedProviderModelMetadata,
  getProviderModelMetadataContextLength,
  getProviderModelMetadataReasoningEfforts,
  getProviderModelMetadataSource,
} from './providerModelMetadata.ts'

test('normalized provider model metadata keeps discovered context length', () => {
  const metadata = getNormalizedProviderModelMetadata({
    listedModel: {
      displayName: 'openai/gpt-oss-120b',
      metadataJson: null,
      modelName: 'openai/gpt-oss-120b',
      remoteModelId: 'openai/gpt-oss-120b',
      variant: null,
      version: null,
    },
    providerKind: 'sglang',
    rawMetadata: {context_length: 131072},
    source: 'provider',
  })

  expect(getProviderModelMetadataContextLength(metadata)).toBe(131072)
  expect(getProviderModelMetadataSource(metadata)).toBe('provider')
})

test('normalized provider model metadata merges runtime metadata and reasoning efforts', () => {
  const metadata = getNormalizedProviderModelMetadata({
    listedModel: {
      displayName: 'Codex Mini',
      metadataJson: null,
      modelName: 'codex-mini',
      remoteModelId: 'codex-mini',
      variant: 'medium',
      version: 'medium',
    },
    providerKind: 'codex',
    rawMetadata: {supportedReasoningEfforts: [{reasoningEffort: 'medium'}, {reasoningEffort: 'high'}]},
    runtimeMetadata: {
      baseURL: 'http://localhost:30000/v1',
      modelName: 'codex-mini',
      raw: {contextLength: 65536},
      servedModelName: 'codex-mini',
    },
    source: 'provider',
  })

  expect(getProviderModelMetadataContextLength(metadata)).toBe(65536)
  expect(getProviderModelMetadataReasoningEfforts(metadata)).toEqual(['medium', 'high'])
  expect(getProviderModelMetadataSource(metadata)).toBe('provider+runtime')
})
