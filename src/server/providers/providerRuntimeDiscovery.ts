import {normalizeProviderKind} from '../services/providerCatalog.ts'
import {getProviderModelMetadataContextLength, getProviderRuntimeModelIdentity} from './providerModelMetadata.ts'

const REQUEST_TIMEOUT_MS = 1500

type ProviderRuntimeDiscoveryResult = {
  baseURL: string | null
  contextLength: number | null
  modelName: string | null
  modelNames: string[]
  raw: unknown
  servedModelName: string | null
}

const getTrimmedValue = (value: string | null | undefined): string | null => {
  const normalized = String(value ?? '').trim()

  return normalized === '' ? null : normalized
}

const getRuntimeDiscoveryUrl = (baseURL: string): string => {
  const normalizedBaseURL = baseURL.replace(/\/+$/, '')
  const runtimeBaseURL = normalizedBaseURL.endsWith('/v1') ? normalizedBaseURL.slice(0, -3) : normalizedBaseURL

  return `${runtimeBaseURL}/get_model_info`
}

const getOpenAIModelsDiscoveryUrl = (baseURL: string): string => {
  const normalizedBaseURL = baseURL.replace(/\/+$/, '')

  return normalizedBaseURL.endsWith('/v1') ? `${normalizedBaseURL}/models` : `${normalizedBaseURL}/v1/models`
}

const getOllamaTagsDiscoveryUrl = (baseURL: string): string => {
  const normalizedBaseURL = baseURL.replace(/\/+$/, '')
  const nativeBaseURL = normalizedBaseURL.endsWith('/v1') ? normalizedBaseURL.slice(0, -3) : normalizedBaseURL

  return `${nativeBaseURL}/api/tags`
}

const getUniqueValues = (values: Array<string | null | undefined>): string[] => {
  return Array.from(
    new Set(
      values.flatMap((value) => {
        const normalizedValue = getTrimmedValue(value)

        return normalizedValue ? [normalizedValue] : []
      }),
    ),
  )
}

const getOpenAICompatibleDiscoveryModelNames = (raw: unknown): string[] => {
  const data =
    typeof raw === 'object' && raw !== null && 'data' in raw && Array.isArray((raw as {data?: unknown[]}).data)
      ? (raw as {data: Array<{id?: unknown}>}).data
      : []

  return getUniqueValues(
    data.map((model) => {
      return typeof model?.id === 'string' ? model.id : null
    }),
  )
}

const getOllamaDiscoveryModelNames = (raw: unknown): string[] => {
  const models =
    typeof raw === 'object' && raw !== null && 'models' in raw && Array.isArray((raw as {models?: unknown[]}).models)
      ? (raw as {models: Array<{model?: unknown; name?: unknown}>}).models
      : []

  return getUniqueValues(
    models.flatMap((model) => {
      return [
        typeof model?.model === 'string' ? model.model : null,
        typeof model?.name === 'string' ? model.name : null,
      ]
    }),
  )
}

const getDiscoveryResult = ({
  baseURL,
  contextLength = null,
  modelNames,
  raw,
  servedModelName,
}: {
  baseURL: string
  contextLength?: number | null
  modelNames: Array<string | null | undefined>
  raw: unknown
  servedModelName?: string | null
}): ProviderRuntimeDiscoveryResult | null => {
  const normalizedModelNames = getUniqueValues(modelNames)

  return raw
    ? {
        baseURL,
        contextLength,
        modelName: normalizedModelNames[0] ?? null,
        modelNames: normalizedModelNames,
        raw,
        servedModelName: servedModelName ?? normalizedModelNames[1] ?? normalizedModelNames[0] ?? null,
      }
    : null
}

const discoverRuntimeModelInfo = async (baseURL: string): Promise<ProviderRuntimeDiscoveryResult | null> => {
  const raw = await fetchJsonWithTimeout(getRuntimeDiscoveryUrl(baseURL))
  const identity = getProviderRuntimeModelIdentity(raw)

  return getDiscoveryResult({
    baseURL,
    contextLength: getProviderModelMetadataContextLength(raw),
    modelNames: [identity.modelName, identity.servedModelName],
    raw,
    servedModelName: identity.servedModelName,
  })
}

const discoverOpenAICompatibleModels = async (baseURL: string): Promise<ProviderRuntimeDiscoveryResult | null> => {
  const raw = await fetchJsonWithTimeout(getOpenAIModelsDiscoveryUrl(baseURL))

  return getDiscoveryResult({baseURL, modelNames: getOpenAICompatibleDiscoveryModelNames(raw), raw})
}

const discoverOllamaModels = async (baseURL: string): Promise<ProviderRuntimeDiscoveryResult | null> => {
  const nativeRaw = await fetchJsonWithTimeout(getOllamaTagsDiscoveryUrl(baseURL))

  return nativeRaw
    ? getDiscoveryResult({baseURL, modelNames: getOllamaDiscoveryModelNames(nativeRaw), raw: nativeRaw})
    : discoverOpenAICompatibleModels(baseURL)
}

export const supportsSavedLocalProviderProbe = (providerKind: string | null | undefined): boolean => {
  const normalizedProviderKind = normalizeProviderKind(providerKind)

  return ['ollama', 'llmstudio', 'llamacpp', 'sglang', 'vllm'].includes(normalizedProviderKind)
}

const fetchJsonWithTimeout = async (url: string): Promise<unknown> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort()
  }, REQUEST_TIMEOUT_MS)

  return fetch(url, {signal: controller.signal})
    .then((response) => {
      return response.ok ? response.json() : null
    })
    .catch(() => {
      return null
    })
    .finally(() => {
      clearTimeout(timeout)
    })
}

export const discoverOpenAICompatibleRuntimeModel = async ({
  baseURL,
  providerKind,
}: {
  baseURL: string | null
  providerKind: string | null | undefined
}): Promise<ProviderRuntimeDiscoveryResult | null> => {
  const resolvedBaseURL = getTrimmedValue(baseURL)
  const normalizedProviderKind = normalizeProviderKind(providerKind)

  return !resolvedBaseURL
    ? null
    : normalizedProviderKind === 'sglang' || normalizedProviderKind === 'vllm'
      ? ((await discoverRuntimeModelInfo(resolvedBaseURL)) ?? discoverOpenAICompatibleModels(resolvedBaseURL))
      : normalizedProviderKind === 'ollama'
        ? discoverOllamaModels(resolvedBaseURL)
        : normalizedProviderKind === 'llmstudio' || normalizedProviderKind === 'llamacpp'
          ? discoverOpenAICompatibleModels(resolvedBaseURL)
          : null
}
