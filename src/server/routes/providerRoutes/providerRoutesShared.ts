import {getProviderCatalogEntry} from '../../services/providerCatalog.ts'

export const getTrimmedValue = (value: string | null | undefined): string | null => {
  const normalized = String(value ?? '').trim()

  return normalized === '' ? null : normalized
}

export const getProviderConnectionLabel = ({
  label,
  providerKind,
}: {
  label: string | null | undefined
  providerKind: string
}) => {
  return getTrimmedValue(label) ?? getProviderCatalogEntry(providerKind)?.label ?? 'Provider connection'
}

export const getProviderConnectionConfig = (workerUrls: string[] | null | undefined) => {
  return {
    workerUrls: (workerUrls ?? [])
      .map((url) => {
        return String(url).trim()
      })
      .filter((url) => {
        return url.length > 0
      }),
  }
}

export const getPublicProviderConnection = <T extends {secretRef: string | null}>(connection: T) => {
  const {secretRef: _secretRef, ...rest} = connection

  return rest
}

export const normalizeDisplayName = (value: string): string => {
  const trimmed = value.trim()

  return trimmed.length > 0 ? trimmed : 'Codex model'
}
