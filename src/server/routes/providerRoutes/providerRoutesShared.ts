import {getWorkerUrlMode, normalizeWorkerUrls} from '../../providers/providerWorkerUtils.ts'
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

export const getProviderConnectionConfig = ({
  llamaCppMode,
  manualWorkerUrls,
  providerKind,
  workerUrlMode,
}: {
  llamaCppMode?: string | null
  manualWorkerUrls: string[] | null | undefined
  providerKind: string
  workerUrlMode?: string | null
}) => {
  const normalizedManualWorkerUrls = normalizeWorkerUrls(manualWorkerUrls)
  const normalizedLlamaCppMode =
    providerKind === 'llamacpp' && getTrimmedValue(llamaCppMode) === 'cli' ? ('cli' as const) : undefined

  return normalizedLlamaCppMode
    ? {
        llamaCppMode: normalizedLlamaCppMode,
        manualWorkerUrls: normalizedManualWorkerUrls,
        workerUrlMode: getWorkerUrlMode({manualWorkerUrls: normalizedManualWorkerUrls, providerKind, workerUrlMode}),
      }
    : {
        manualWorkerUrls: normalizedManualWorkerUrls,
        workerUrlMode: getWorkerUrlMode({manualWorkerUrls: normalizedManualWorkerUrls, providerKind, workerUrlMode}),
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
