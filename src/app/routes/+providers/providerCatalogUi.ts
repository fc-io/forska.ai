import type {ProviderCatalogEntry, ProviderConnectionConfig} from '../+admin/+models/providerConnectionsClient.ts'

export type ProviderCatalogOption = ProviderCatalogEntry & {hideBaseURLField?: boolean; selectedKind: string}

const getNormalizedProviderKind = (providerKind: string | null | undefined): string => {
  return String(providerKind ?? '')
    .trim()
    .toLowerCase()
}

const getLlamaCppSelectionKind = (
  config: ProviderConnectionConfig | null | undefined,
): ProviderCatalogOption['selectedKind'] => {
  return config?.llamaCppMode === 'cli' ? 'llamacpp-cli' : 'llamacpp-server'
}

export const getProviderSelectionKind = ({
  config,
  providerKind,
}: {
  config?: ProviderConnectionConfig | null
  providerKind: string | null | undefined
}): string => {
  const normalizedProviderKind = getNormalizedProviderKind(providerKind)

  return normalizedProviderKind === 'llamacpp' ? getLlamaCppSelectionKind(config) : normalizedProviderKind
}

export const getProviderCatalogOptions = (catalog: ProviderCatalogEntry[]): ProviderCatalogOption[] => {
  return catalog.flatMap((entry) => {
    return entry.kind === 'llamacpp'
      ? [
          {
            ...entry,
            description: 'Local llama.cpp CLI using the built-in local default endpoint',
            hideBaseURLField: true,
            label: 'llama.cpp CLI',
            selectedKind: 'llamacpp-cli',
          },
          {
            ...entry,
            description: 'Local llama-server OpenAI-compatible endpoint',
            label: 'llama.cpp Server',
            selectedKind: 'llamacpp-server',
          },
        ]
      : [{...entry, selectedKind: entry.kind}]
  })
}

export const getProviderDisplayLabel = ({
  catalog,
  config,
  providerKind,
}: {
  catalog: ProviderCatalogEntry[]
  config?: ProviderConnectionConfig | null
  providerKind: string | null | undefined
}): string => {
  const normalizedProviderKind = getNormalizedProviderKind(providerKind)

  return (
    getProviderCatalogOptions(catalog).find((entry) => {
      return entry.selectedKind === getProviderSelectionKind({config, providerKind: normalizedProviderKind})
    })?.label
    ?? providerKind
    ?? 'Unknown'
  )
}

export const shouldHideProviderBaseURLField = ({
  config,
  providerKind,
}: {
  config?: ProviderConnectionConfig | null
  providerKind: string | null | undefined
}): boolean => {
  return getProviderSelectionKind({config, providerKind}) === 'llamacpp-cli'
}
