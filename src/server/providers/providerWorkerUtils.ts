import {normalizeProviderKind} from '../services/providerCatalog.ts'
import {type ProviderWorkerUrlMode} from './providerTypes.ts'

export const normalizeWorkerUrls = (workerUrls: string[] | null | undefined): string[] => {
  return Array.from(
    new Set(
      (workerUrls ?? [])
        .map((url) => {
          return String(url).trim()
        })
        .filter((url) => {
          return url.length > 0
        }),
    ),
  )
}

export const supportsRuntimeWorkerUrls = (providerKind: string | null | undefined): boolean => {
  const normalizedProviderKind = normalizeProviderKind(providerKind)

  return normalizedProviderKind === 'sglang' || normalizedProviderKind === 'vllm'
}

export const getDefaultWorkerUrlMode = ({
  manualWorkerUrls,
  providerKind,
}: {
  manualWorkerUrls: string[]
  providerKind: string | null | undefined
}): ProviderWorkerUrlMode => {
  return manualWorkerUrls.length > 0 || !supportsRuntimeWorkerUrls(providerKind) ? 'manual' : 'runtime'
}

export const getWorkerUrlMode = ({
  manualWorkerUrls,
  providerKind,
  workerUrlMode,
}: {
  manualWorkerUrls: string[]
  providerKind: string | null | undefined
  workerUrlMode: string | null | undefined
}): ProviderWorkerUrlMode => {
  return workerUrlMode === 'runtime' || workerUrlMode === 'manual'
    ? workerUrlMode
    : getDefaultWorkerUrlMode({manualWorkerUrls, providerKind})
}
