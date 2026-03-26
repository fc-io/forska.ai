import {getProviderCatalog, type ProviderCatalogEntry} from '../services/providerCatalog.ts'
import {createAnthropicAdapter} from './adapters/anthropicAdapter.ts'
import {createCodexAdapter} from './adapters/codexAdapter.ts'
import {createDoclingAdapter} from './adapters/doclingAdapter.ts'
import {createGoogleAdapter} from './adapters/googleAdapter.ts'
import {createLlamacppAdapter} from './adapters/llamacppAdapter.ts'
import {createLlmstudioAdapter} from './adapters/llmstudioAdapter.ts'
import {createOllamaAdapter} from './adapters/ollamaAdapter.ts'
import {createOpenAIAdapter} from './adapters/openaiAdapter.ts'
import {createOpenrouterAdapter} from './adapters/openrouterAdapter.ts'
import {createSglangAdapter} from './adapters/sglangAdapter.ts'
import {createVllmAdapter} from './adapters/vllmAdapter.ts'
import {type ProviderDefinition} from './providerTypes.ts'

const getUnsupportedProviderAuthResult = (providerLabel: string) => {
  return {
    message: `${providerLabel} auth is handled by the existing UI/server flow for now`,
    payload: null,
    status: 'unsupported' as const,
  }
}

const createProviderDefinition = (catalog: ProviderCatalogEntry): ProviderDefinition => {
  return catalog.kind === 'openai'
    ? createOpenAIAdapter(catalog)
    : catalog.kind === 'codex'
      ? createCodexAdapter(catalog)
      : catalog.kind === 'docling'
        ? createDoclingAdapter(catalog)
        : catalog.kind === 'anthropic'
          ? createAnthropicAdapter(catalog)
          : catalog.kind === 'google'
            ? createGoogleAdapter(catalog)
            : catalog.kind === 'openrouter'
              ? createOpenrouterAdapter(catalog)
              : catalog.kind === 'ollama'
                ? createOllamaAdapter(catalog)
                : catalog.kind === 'llmstudio'
                  ? createLlmstudioAdapter(catalog)
                  : catalog.kind === 'llamacpp'
                    ? createLlamacppAdapter(catalog)
                    : catalog.kind === 'sglang'
                      ? createSglangAdapter(catalog)
                      : catalog.kind === 'vllm'
                        ? createVllmAdapter(catalog)
                        : {
                            beginAuth: async () => {
                              return getUnsupportedProviderAuthResult(catalog.label)
                            },
                            catalog,
                            finishAuth: async () => {
                              return getUnsupportedProviderAuthResult(catalog.label)
                            },
                            health: async () => {
                              throw new Error(`No provider adapter registered for ${catalog.kind}`)
                            },
                            invoke: async () => {
                              throw new Error(`No provider adapter registered for ${catalog.kind}`)
                            },
                            kind: catalog.kind,
                            listModels: async () => {
                              throw new Error(`No provider adapter registered for ${catalog.kind}`)
                            },
                            resolveRuntimeCredentials: async () => {
                              throw new Error(`No provider adapter registered for ${catalog.kind}`)
                            },
                            testConnection: async () => {
                              throw new Error(`No provider adapter registered for ${catalog.kind}`)
                            },
                            transportFamily: 'openai-chat',
                          }
}

const providerDefinitions = getProviderCatalog().map((entry) => {
  return createProviderDefinition(entry)
})

export const getProviderRegistryEntries = (): ProviderDefinition[] => {
  return providerDefinitions
}

export const getProviderRegistryEntry = (providerKind: string | null | undefined): ProviderDefinition | null => {
  const normalizedProviderKind = String(providerKind ?? '')
    .trim()
    .toLowerCase()

  return (
    providerDefinitions.find((entry) => {
      return entry.kind === normalizedProviderKind
    }) ?? null
  )
}

export const requireProviderRegistryEntry = (providerKind: string | null | undefined): ProviderDefinition => {
  const definition = getProviderRegistryEntry(providerKind)

  if (!definition) {
    throw new Error(`Unsupported provider kind: ${providerKind ?? 'unknown'}`)
  }

  return definition
}

export const getProviderRegistry = () => {
  return {entries: getProviderRegistryEntries, get: getProviderRegistryEntry, require: requireProviderRegistryEntry}
}
