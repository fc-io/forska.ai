import {normalizeProviderKind} from '../services/providerCatalog.ts'
import {inferenceRuntimeConfig} from '../utils/getInferenceRuntimeConfig.ts'
import {type ProviderConnectionConfig, type ProviderWorkerSource} from './providerTypes.ts'
import {normalizeWorkerUrls, supportsRuntimeWorkerUrls} from './providerWorkerUtils.ts'

export type ProviderRuntimeSummary = {providerKind: string | null; workerUrls: string[]}

export type ProviderConnectionWorkerState = {
  effectiveWorkerUrls: string[]
  runtimeWorkerUrls: string[]
  workerSource: ProviderWorkerSource
}

const getRuntimeProviderKind = (): string | null => {
  const normalizedProviderKind = normalizeProviderKind(inferenceRuntimeConfig.providerKind)

  return normalizedProviderKind === 'unknown' ? null : normalizedProviderKind
}

export const getProviderRuntimeSummary = (): ProviderRuntimeSummary => {
  const workerUrls = normalizeWorkerUrls(inferenceRuntimeConfig.displayWorkerUrls)

  return {providerKind: getRuntimeProviderKind(), workerUrls}
}

const getRuntimeWorkerUrlsForProvider = (providerKind: string | null | undefined): string[] => {
  const runtimeSummary = getProviderRuntimeSummary()

  return runtimeSummary.providerKind === normalizeProviderKind(providerKind) ? runtimeSummary.workerUrls : []
}

const getWorkerStateFromRuntimeMode = ({
  runtimeWorkerUrls,
}: {
  runtimeWorkerUrls: string[]
}): ProviderConnectionWorkerState => {
  return runtimeWorkerUrls.length > 0
    ? {effectiveWorkerUrls: runtimeWorkerUrls, runtimeWorkerUrls, workerSource: 'runtime'}
    : {effectiveWorkerUrls: [], runtimeWorkerUrls, workerSource: 'none'}
}

const getWorkerStateFromManualMode = ({
  legacyWorkerUrls,
  manualWorkerUrls,
  runtimeWorkerUrls,
}: {
  legacyWorkerUrls: string[]
  manualWorkerUrls: string[]
  runtimeWorkerUrls: string[]
}): ProviderConnectionWorkerState => {
  return manualWorkerUrls.length > 0
    ? {effectiveWorkerUrls: manualWorkerUrls, runtimeWorkerUrls, workerSource: 'manual'}
    : legacyWorkerUrls.length > 0
      ? {effectiveWorkerUrls: legacyWorkerUrls, runtimeWorkerUrls, workerSource: 'legacy'}
      : {effectiveWorkerUrls: [], runtimeWorkerUrls, workerSource: 'none'}
}

export const getProviderConnectionWorkerState = ({
  config,
  legacyWorkerUrls,
  providerKind,
}: {
  config: ProviderConnectionConfig
  legacyWorkerUrls?: string[] | null | undefined
  providerKind: string | null | undefined
}): ProviderConnectionWorkerState => {
  const manualWorkerUrls = normalizeWorkerUrls(config.manualWorkerUrls)
  const normalizedLegacyWorkerUrls = normalizeWorkerUrls(legacyWorkerUrls)
  const runtimeWorkerUrls = supportsRuntimeWorkerUrls(providerKind) ? getRuntimeWorkerUrlsForProvider(providerKind) : []

  return config.workerUrlMode === 'runtime'
    ? getWorkerStateFromRuntimeMode({runtimeWorkerUrls})
    : getWorkerStateFromManualMode({legacyWorkerUrls: normalizedLegacyWorkerUrls, manualWorkerUrls, runtimeWorkerUrls})
}
