import {normalizeProviderKind} from '../services/providerCatalog.ts'
import {getProviderModelMetadataContextLength, getProviderRuntimeModelIdentity} from './providerModelMetadata.ts'

const REQUEST_TIMEOUT_MS = 1500

const getTrimmedValue = (value: string | null | undefined): string | null => {
  const normalized = String(value ?? '').trim()

  return normalized === '' ? null : normalized
}

const getRuntimeDiscoveryUrl = (baseURL: string): string => {
  const normalizedBaseURL = baseURL.replace(/\/+$/, '')
  const runtimeBaseURL = normalizedBaseURL.endsWith('/v1') ? normalizedBaseURL.slice(0, -3) : normalizedBaseURL

  return `${runtimeBaseURL}/get_model_info`
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
}): Promise<{
  baseURL: string | null
  contextLength: number | null
  modelName: string | null
  raw: unknown
  servedModelName: string | null
} | null> => {
  const resolvedBaseURL = getTrimmedValue(baseURL)
  const normalizedProviderKind = normalizeProviderKind(providerKind)

  return !resolvedBaseURL || (normalizedProviderKind !== 'sglang' && normalizedProviderKind !== 'vllm')
    ? null
    : fetchJsonWithTimeout(getRuntimeDiscoveryUrl(resolvedBaseURL)).then((raw) => {
        const identity = getProviderRuntimeModelIdentity(raw)

        return raw
          ? {
              baseURL: resolvedBaseURL,
              contextLength: getProviderModelMetadataContextLength(raw),
              modelName: identity.modelName,
              raw,
              servedModelName: identity.servedModelName,
            }
          : null
      })
}
