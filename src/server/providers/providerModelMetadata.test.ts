import {expect, test} from 'bun:test'

import {
  getNormalizedProviderModelMetadata,
  getPersistedProviderModelMetadata,
  getProviderModelMetadataContextLength,
  getProviderModelMetadataDiscoveredContextWindow,
  getProviderModelMetadataDiscoveredInputSupport,
  getProviderModelMetadataOptions,
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

test('discovered context window reads the stored discovery window', () => {
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

  expect(getProviderModelMetadataDiscoveredContextWindow(metadata)).toEqual({inputTokens: 200000, totalTokens: 200000})
})

test('discovered context window scans legacy metadata without a discovery record', () => {
  expect(getProviderModelMetadataDiscoveredContextWindow({context_length: 32768})).toEqual({
    inputTokens: 32768,
    totalTokens: 32768,
  })
})

test('discovered context window ignores capability overrides and reports null when nothing was discovered', () => {
  expect(
    getProviderModelMetadataDiscoveredContextWindow({
      capabilityOverrides: {contextWindow: {inputTokens: 5000, totalTokens: 6000}, context_length: 7000},
    }),
  ).toEqual({inputTokens: null, totalTokens: null})
})

test('normalized metadata records image and PDF support reported by the Anthropic models API', () => {
  const metadata = getNormalizedProviderModelMetadata({
    listedModel: {
      displayName: 'Claude Opus 4.7',
      metadataJson: null,
      modelName: 'claude-opus-4-7',
      remoteModelId: 'claude-opus-4-7',
      variant: null,
      version: null,
    },
    providerKind: 'anthropic',
    rawMetadata: {
      capabilities: {image_input: {supported: true}, pdf_input: {supported: false}},
      id: 'claude-opus-4-7',
      max_input_tokens: 1000000,
    },
    source: 'provider',
  })

  expect(getProviderModelMetadataDiscoveredInputSupport(metadata)).toEqual({
    supportsImageInput: true,
    supportsPdfInput: false,
  })
  expect(getProviderModelMetadataDiscoveredContextWindow(metadata).inputTokens).toBe(1000000)
})

test('normalized metadata reads image support from Ollama capabilities, llama.cpp modalities and LM Studio types', () => {
  const getImageSupport = (rawMetadata: unknown) => {
    return getProviderModelMetadataDiscoveredInputSupport(
      getNormalizedProviderModelMetadata({
        listedModel: {
          displayName: 'local',
          metadataJson: null,
          modelName: 'local',
          remoteModelId: 'local',
          variant: null,
          version: null,
        },
        providerKind: 'ollama',
        rawMetadata,
        source: 'provider',
      }),
    ).supportsImageInput
  }

  expect(getImageSupport({capabilities: ['completion', 'vision']})).toBe(true)
  expect(getImageSupport({capabilities: ['completion']})).toBe(false)
  expect(getImageSupport({modalities: {vision: false}})).toBe(false)
  expect(getImageSupport({type: 'vlm'})).toBe(true)
  expect(getImageSupport({type: 'llm'})).toBe(false)
  expect(getImageSupport({id: 'plain'})).toBeNull()
})
