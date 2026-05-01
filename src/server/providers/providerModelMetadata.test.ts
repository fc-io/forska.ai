import {expect, test} from 'bun:test'

import {
  getNormalizedProviderModelMetadata,
  getPersistedProviderModelMetadata,
  getProviderModelMetadataContextLength,
  getProviderModelMetadataOptions,
  getProviderModelMetadataPromptTokenLimit,
  getProviderModelMetadataReasoningEfforts,
  getProviderModelMetadataSource,
  getProviderModelMetadataSupportedOptions,
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

test('normalized provider model metadata reads string reasoning effort entries', () => {
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
    rawMetadata: {supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh']},
    source: 'provider',
  })

  expect(getProviderModelMetadataReasoningEfforts(metadata)).toEqual(['low', 'medium', 'high', 'xhigh'])
  expect(getProviderModelMetadataSupportedOptions(metadata)).toEqual({thinking: true})
})

test('normalized provider model metadata does not keep raw provider payloads', () => {
  const metadata = getNormalizedProviderModelMetadata({
    listedModel: {
      displayName: 'gpt-4.1',
      metadataJson: null,
      modelName: 'gpt-4.1',
      remoteModelId: 'gpt-4.1',
      variant: null,
      version: null,
    },
    providerKind: 'openai',
    rawMetadata: {id: 'gpt-4.1', owned_by: 'openai'},
    source: 'provider',
  })

  expect('raw' in (metadata as Record<string, unknown>)).toBe(false)
})

test('persisted provider model metadata strips any extra top-level raw payload', () => {
  const persisted = getPersistedProviderModelMetadata({
    listedModel: {
      displayName: 'gpt-4.1',
      metadataJson: null,
      modelName: 'gpt-4.1',
      remoteModelId: 'gpt-4.1',
      variant: null,
      version: null,
    },
    metadataJson: {
      discovery: {
        capabilities: {reasoningEfforts: [], supportedOptions: {thinking: false}},
        contextWindow: {inputTokens: 128000, outputTokens: null, totalTokens: 128000},
        identity: {
          displayName: 'gpt-4.1',
          modelName: 'gpt-4.1',
          remoteModelId: 'gpt-4.1',
          variant: null,
          version: null,
        },
        providerKind: 'openai',
        runtime: null,
        source: 'provider',
      },
      raw: {large: true},
    },
    providerKind: 'openai',
    source: 'provider',
  })

  expect('raw' in (persisted as Record<string, unknown>)).toBe(false)
  expect(getProviderModelMetadataContextLength(persisted)).toBe(128000)
})

test('normalized provider model metadata prefers real context keys over unrelated numeric fields', () => {
  const metadata = getNormalizedProviderModelMetadata({
    listedModel: {
      displayName: 'Qwen/Qwen3-4B-GGUF:Q4_K_M',
      metadataJson: null,
      modelName: 'Qwen/Qwen3-4B-GGUF:Q4_K_M',
      remoteModelId: 'Qwen/Qwen3-4B-GGUF:Q4_K_M',
      variant: null,
      version: null,
    },
    providerKind: 'llmstudio',
    rawMetadata: {
      created: 1774528734,
      data: [{created: 1774528734, id: 'Qwen/Qwen3-4B-GGUF:Q4_K_M', meta: {n_ctx_train: 40960}, object: 'model'}],
      object: 'list',
    },
    source: 'provider',
  })

  expect(getProviderModelMetadataContextLength(metadata)).toBe(40960)
})

test('normalized provider model metadata infers Qwen3.5 thinking capabilities', () => {
  const metadata = getNormalizedProviderModelMetadata({
    listedModel: {
      displayName: 'Qwen/Qwen3.5-27B',
      metadataJson: null,
      modelName: 'Qwen/Qwen3.5-27B',
      remoteModelId: 'Qwen/Qwen3.5-27B',
      variant: null,
      version: null,
    },
    providerKind: 'sglang',
    rawMetadata: null,
    source: 'provider',
  })

  expect(getProviderModelMetadataSupportedOptions(metadata)).toEqual({thinking: true})
})

test('persisted provider model metadata keeps generic model options', () => {
  const metadata = getPersistedProviderModelMetadata({
    listedModel: {
      displayName: 'Qwen/Qwen3.5-27B',
      metadataJson: null,
      modelName: 'Qwen/Qwen3.5-27B',
      remoteModelId: 'Qwen/Qwen3.5-27B',
      variant: null,
      version: null,
    },
    metadataJson: {
      discovery: {
        capabilities: {reasoningEfforts: [], supportedOptions: {thinking: true}},
        contextWindow: {inputTokens: null, outputTokens: null, totalTokens: null},
        identity: {
          displayName: 'Qwen/Qwen3.5-27B',
          modelName: 'Qwen/Qwen3.5-27B',
          remoteModelId: 'Qwen/Qwen3.5-27B',
          variant: null,
          version: null,
        },
        providerKind: 'sglang',
        runtime: null,
        source: 'provider',
      },
      options: {thinking: 'enabled'},
    },
    providerKind: 'sglang',
    source: 'provider',
  })

  expect(getProviderModelMetadataOptions(metadata)).toEqual({thinking: 'enabled'})
})

test('prompt token limit prefers explicit input window over subtracting completion reserve', () => {
  const metadata = {
    discovery: {
      capabilities: {reasoningEfforts: [], supportedOptions: {thinking: false}},
      contextWindow: {inputTokens: 200000, outputTokens: 8000, totalTokens: 200000},
      identity: {
        displayName: 'claude-opus-4-7',
        modelName: 'claude-opus-4-7',
        remoteModelId: 'claude-opus-4-7',
        variant: null,
        version: 'max',
      },
      providerKind: 'anthropic',
      runtime: null,
      source: 'provider',
    },
    options: {},
  }

  expect(getProviderModelMetadataPromptTokenLimit(metadata, 4000)).toBe(200000)
})

test('prompt token limit falls back to total window minus completion reserve', () => {
  expect(getProviderModelMetadataPromptTokenLimit({context_length: 32768}, 4000)).toBe(28768)
})
