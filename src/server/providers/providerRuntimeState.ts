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
  manualWorkerUrls,
  runtimeWorkerUrls,
}: {
  manualWorkerUrls: string[]
  runtimeWorkerUrls: string[]
}): ProviderConnectionWorkerState => {
  return manualWorkerUrls.length > 0
    ? {effectiveWorkerUrls: manualWorkerUrls, runtimeWorkerUrls, workerSource: 'manual'}
    : {effectiveWorkerUrls: [], runtimeWorkerUrls, workerSource: 'none'}
}

export const getProviderConnectionWorkerState = ({
  config,
  providerKind,
}: {
  config: ProviderConnectionConfig
  providerKind: string | null | undefined
}): ProviderConnectionWorkerState => {
  const manualWorkerUrls = normalizeWorkerUrls(config.manualWorkerUrls)
  const runtimeWorkerUrls = supportsRuntimeWorkerUrls(providerKind) ? getRuntimeWorkerUrlsForProvider(providerKind) : []

  return config.workerUrlMode === 'runtime'
    ? getWorkerStateFromRuntimeMode({runtimeWorkerUrls})
    : getWorkerStateFromManualMode({manualWorkerUrls, runtimeWorkerUrls})
}
