export type ProviderKeyInput = {
  modelId?: string | null
  modelProvider?: string | null
  providerConnectionId?: string | null
  useOwnerBackedSyntheticProviderId?: boolean
}

const getTrimmedValue = (value: string | null | undefined): string | null => {
  const trimmed = String(value ?? '').trim()

  return trimmed.length > 0 ? trimmed : null
}

export const getNormalizedProviderKeyProvider = (value: string | null | undefined): string => {
  return getTrimmedValue(value)?.toLowerCase() ?? 'unknown'
}

export const getProviderKey = ({
  modelId,
  modelProvider,
  providerConnectionId,
  useOwnerBackedSyntheticProviderId = false,
}: ProviderKeyInput): string => {
  const savedProviderConnectionId = getTrimmedValue(providerConnectionId)
  const syntheticModelId = getTrimmedValue(modelId)
  const provider = getNormalizedProviderKeyProvider(modelProvider)

  return savedProviderConnectionId
    ? savedProviderConnectionId
    : useOwnerBackedSyntheticProviderId && syntheticModelId
      ? `owner-backed:${syntheticModelId}`
      : provider === 'codex'
        ? 'codex:default'
        : `provider:${provider}:default`
}
