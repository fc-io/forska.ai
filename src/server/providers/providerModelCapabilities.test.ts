import {expect, test} from 'bun:test'

import {
  carryProviderModelCapabilityOverrides,
  getModelContext,
  getModelContextWindowMissingError,
  getProviderModelCapabilityOverrides,
  getProviderModelContextLimits,
  ModelContextWindowMissingError,
  resolveProviderModelCapabilities,
  setProviderModelCapabilityOverrides,
} from './providerModelCapabilities.ts'
import {getManualProviderModelMetadata} from './providerModelMetadata.ts'

const getDiscoveryMetadata = ({
  inputTokens,
  supportsImageInput = null,
  totalTokens,
}: {
  inputTokens: number | null
  supportsImageInput?: boolean | null
  totalTokens: number | null
}) => {
  return {
    discovery: {
      capabilities: {
        reasoningEfforts: [],
        supportedOptions: {thinking: false},
        supportsImageInput,
        supportsPdfInput: null,
      },
      contextWindow: {inputTokens, outputTokens: null, totalTokens},
      identity: {displayName: 'm', modelName: 'm', remoteModelId: 'm', variant: null, version: null},
      providerKind: 'anthropic',
      runtime: null,
      source: 'provider',
    },
    options: {},
  }
}

const getVariantMetadata = ({
  providerKind,
  remoteModelId,
  variant,
}: {
  providerKind: 'anthropic' | 'claude-code' | 'codex'
  remoteModelId: string
  variant: string
}) => {
  return getManualProviderModelMetadata({
    displayName: `${remoteModelId} (${variant})`,
    modelName: remoteModelId,
    providerKind,
    remoteModelId,
    variant,
    version: variant,
  })
}

test('user override wins over discovery and the shipped table', () => {
  const metadataJson = setProviderModelCapabilityOverrides({
    metadataJson: getDiscoveryMetadata({inputTokens: 1_000_000, supportsImageInput: true, totalTokens: 1_000_000}),
    overrides: {
      contextWindow: {inputTokens: 150_000, totalTokens: 200_000},
      supportsImageInput: false,
      supportsPdfInput: null,
    },
    updatedAt: '2026-10-17T10:00:00.000Z',
  })

  expect(
    resolveProviderModelCapabilities({metadataJson, providerKind: 'anthropic', remoteModelId: 'claude-opus-4-7'}),
  ).toEqual({
    contextWindow: {
      inputTokens: 150_000,
      source: 'user',
      sourceUrl: null,
      totalTokens: 200_000,
      verifiedAt: '2026-10-17',
    },
    supportsImageInput: {source: 'user', sourceUrl: null, value: false, verifiedAt: '2026-10-17'},
    supportsPdfInput: {
      source: 'shipped',
      sourceUrl: 'https://platform.claude.com/docs/en/build-with-claude/pdf-support',
      value: true,
      verifiedAt: '2026-10-17',
    },
  })
})

test('provider discovery wins over the shipped table', () => {
  const capabilities = resolveProviderModelCapabilities({
    metadataJson: getDiscoveryMetadata({inputTokens: 200_000, supportsImageInput: false, totalTokens: 200_000}),
    providerKind: 'anthropic',
    remoteModelId: 'claude-opus-4-7',
  })

  expect(capabilities.contextWindow).toEqual({
    inputTokens: 200_000,
    source: 'discovery',
    sourceUrl: null,
    totalTokens: 200_000,
    verifiedAt: null,
  })
  expect(capabilities.supportsImageInput).toEqual({
    source: 'discovery',
    sourceUrl: null,
    value: false,
    verifiedAt: null,
  })
})

test('variant models inherit shipped capabilities from their base remote model id', () => {
  const variants = [
    {expectedInputTokens: 922_000, providerKind: 'codex', remoteModelId: 'gpt-5.6-sol', variant: 'xhigh'},
    {expectedInputTokens: 922_000, providerKind: 'codex', remoteModelId: 'gpt-6-astra', variant: 'xhigh'},
    {expectedInputTokens: 1_000_000, providerKind: 'claude-code', remoteModelId: 'claude-opus-5-5', variant: 'high'},
    {expectedInputTokens: 1_000_000, providerKind: 'claude-code', remoteModelId: 'claude-sonnet-5-5', variant: 'high'},
    {expectedInputTokens: 1_000_000, providerKind: 'anthropic', remoteModelId: 'claude-opus-4-7', variant: 'max'},
  ] as const

  const resolved = variants.map((variant) => {
    const capabilities = resolveProviderModelCapabilities({
      metadataJson: getVariantMetadata(variant),
      providerKind: variant.providerKind,
      remoteModelId: variant.remoteModelId,
    })

    return {
      inputTokens: capabilities.contextWindow?.inputTokens ?? null,
      source: capabilities.contextWindow?.source ?? null,
      supportsImageInput: capabilities.supportsImageInput?.value ?? null,
      verifiedAt: capabilities.contextWindow?.verifiedAt ?? null,
    }
  })

  expect(resolved).toEqual(
    variants.map((variant) => {
      return {
        inputTokens: variant.expectedInputTokens,
        source: 'shipped',
        supportsImageInput: true,
        verifiedAt: '2026-10-17',
      }
    }),
  )
})

test('shipped rows are keyed by provider kind, so another provider with the same id stays absent', () => {
  expect(
    resolveProviderModelCapabilities({metadataJson: null, providerKind: 'openai', remoteModelId: 'gpt-6-astra'}),
  ).toEqual({contextWindow: null, supportsImageInput: null, supportsPdfInput: null})
})

test('getModelContext returns the resolved input window and throws a typed error when it is missing', () => {
  expect(
    getModelContext({
      model: {
        metadataJson: getDiscoveryMetadata({inputTokens: 65_536, totalTokens: 65_536}),
        providerKind: 'sglang',
        remoteModelId: 'x',
      },
      modelName: 'DeepSeek',
      providerConnectionId: 'connection-1',
      reservedCompletionTokens: 4000,
    }),
  ).toBe(65_536)

  const getMissing = () => {
    return getModelContext({
      model: {metadataJson: null, providerKind: 'llmstudio', remoteModelId: 'qwen2.5-1.5b-instruct'},
      modelName: 'qwen2.5-1.5b-instruct',
      providerConnectionId: 'connection-2',
      reservedCompletionTokens: 4000,
    })
  }

  expect(getMissing).toThrow(ModelContextWindowMissingError)
  expect(getMissing).toThrow(
    'Model qwen2.5-1.5b-instruct (llmstudio) has no verified context window. Add it on the Models page.',
  )
})

test('missing-window error names the model, provider and the Models page link', () => {
  const error = getModelContextWindowMissingError({
    model: {metadataJson: null, providerKind: 'codex', remoteModelId: 'gpt-7-unknown'},
    modelName: 'GPT-7 (thinking: high)',
    providerConnectionId: 'b642c9e9',
  })

  expect(error?.modelName).toBe('GPT-7 (thinking: high)')
  expect(error?.providerKind).toBe('codex')
  expect(error?.linkText).toBe('Models page')
  expect(error?.linkPath).toBe('/providers/b642c9e9')
})

test('context limits report null instead of a default when no window resolves', () => {
  expect(
    getProviderModelContextLimits({
      model: {metadataJson: null, providerKind: 'llmstudio', remoteModelId: 'x'},
      reservedCompletionTokens: 4000,
    }),
  ).toEqual({contextLimit: null, promptTokenLimit: null})
  expect(
    getProviderModelContextLimits({
      model: {metadataJson: null, providerKind: 'codex', remoteModelId: 'gpt-5.4-mini'},
      reservedCompletionTokens: 4000,
    }),
  ).toEqual({contextLimit: 400_000, promptTokenLimit: 272_000})
  expect(
    getProviderModelContextLimits({
      model: {
        metadataJson: getDiscoveryMetadata({inputTokens: null, totalTokens: 32_768}),
        providerKind: 'llamacpp',
        remoteModelId: 'x',
      },
      reservedCompletionTokens: 4000,
    }),
  ).toEqual({contextLimit: 32_768, promptTokenLimit: 28_768})
})

test('clearing every override removes the capabilityOverrides key and keeps other metadata', () => {
  const withOverride = setProviderModelCapabilityOverrides({
    metadataJson: {options: {thinking: 'high'}},
    overrides: {
      contextWindow: {inputTokens: 1000, totalTokens: null},
      supportsImageInput: null,
      supportsPdfInput: true,
    },
    updatedAt: '2026-10-17T10:00:00.000Z',
  })

  expect(getProviderModelCapabilityOverrides(withOverride)).toEqual({
    contextWindow: {inputTokens: 1000, totalTokens: null},
    supportsImageInput: null,
    supportsPdfInput: true,
    updatedAt: '2026-10-17T10:00:00.000Z',
  })
  expect(
    setProviderModelCapabilityOverrides({
      metadataJson: withOverride,
      overrides: {contextWindow: null, supportsImageInput: null, supportsPdfInput: null},
      updatedAt: '2026-10-17T11:00:00.000Z',
    }),
  ).toEqual({options: {thinking: 'high'}})
})

test('re-synced metadata keeps the previous user overrides', () => {
  const previousMetadataJson = {capabilityOverrides: {contextWindow: {inputTokens: 4096}, updatedAt: 'x'}, options: {}}

  expect(
    carryProviderModelCapabilityOverrides({
      nextMetadataJson: getDiscoveryMetadata({inputTokens: null, totalTokens: null}),
      previousMetadataJson,
    }),
  ).toMatchObject({capabilityOverrides: {contextWindow: {inputTokens: 4096}}})
  expect(
    carryProviderModelCapabilityOverrides({nextMetadataJson: {options: {}}, previousMetadataJson: {options: {}}}),
  ).toEqual({options: {}})
})
