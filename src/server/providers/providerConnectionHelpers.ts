import {getProviderDefaultBaseURL, isCodexProvider, type ProviderKind} from '../services/providerCatalog.ts'

const getTrimmedValue = (value: string | null | undefined): string | null => {
  const normalized = String(value ?? '').trim()

  return normalized === '' ? null : normalized
}

export const getResolvedProviderBaseURL = ({
  baseURL,
  providerKind,
}: {
  baseURL: string | null | undefined
  providerKind: ProviderKind | null | undefined
}): string | null => {
  return getTrimmedValue(baseURL) ?? getProviderDefaultBaseURL(providerKind)
}

export const getProviderConnectionAuthMode = ({
  baseURL,
  providerKind,
  secretRef,
}: {
  baseURL: string | null | undefined
  providerKind: ProviderKind | null | undefined
  secretRef: string | null | undefined
}): string | null => {
  return isCodexProvider(providerKind)
    ? 'codex-cli'
    : getTrimmedValue(secretRef)
      ? 'api-key'
      : getTrimmedValue(baseURL)
        ? 'none'
        : null
}
