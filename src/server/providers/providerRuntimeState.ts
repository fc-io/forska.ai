import {normalizeProviderKind} from '../services/providerCatalog.ts'
import {inferenceRuntimeConfig} from '../utils/getInferenceRuntimeConfig.ts'
import {type ProviderConnectionConfig, type ProviderWorkerSource} from './providerTypes.ts'
import {normalizeWorkerUrls, supportsRuntimeWorkerUrls} from './providerWorkerUtils.ts'

export type ProviderRuntimeSummary = {activeModelNames: string[]; providerKind: string | null; workerUrls: string[]}

export type ProviderConnectionWorkerState = {
  effectiveWorkerUrls: string[]
  runtimeWorkerUrls: string[]
  workerSource: ProviderWorkerSource
}

const getTrimmedValue = (value: string | null | undefined): string | null => {
  const normalized = String(value ?? '').trim()

  return normalized === '' ? null : normalized
}

const getRuntimeProviderKind = (): string | null => {
  const normalizedProviderKind = normalizeProviderKind(inferenceRuntimeConfig.providerKind)

  return normalizedProviderKind === 'unknown' ? null : normalizedProviderKind
}

export const getProviderRuntimeSummary = (): ProviderRuntimeSummary => {
  const workerUrls = normalizeWorkerUrls(inferenceRuntimeConfig.displayWorkerUrls)

  return {activeModelNames: inferenceRuntimeConfig.activeModelNames, providerKind: getRuntimeProviderKind(), workerUrls}
}

const getRuntimeWorkerUrlsForProvider = ({
  providerKind,
  runtimeSummary,
}: {
  providerKind: string | null | undefined
  runtimeSummary?: ProviderRuntimeSummary
}): string[] => {
  const activeRuntimeSummary = runtimeSummary ?? getProviderRuntimeSummary()

  return activeRuntimeSummary.providerKind === normalizeProviderKind(providerKind)
    ? activeRuntimeSummary.workerUrls
    : []
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
  runtimeSummary,
}: {
  config: ProviderConnectionConfig
  providerKind: string | null | undefined
  runtimeSummary?: ProviderRuntimeSummary
}): ProviderConnectionWorkerState => {
  const manualWorkerUrls = normalizeWorkerUrls(config.manualWorkerUrls)
  const runtimeWorkerUrls = supportsRuntimeWorkerUrls(providerKind)
    ? getRuntimeWorkerUrlsForProvider({providerKind, runtimeSummary})
    : []

  return config.workerUrlMode === 'runtime'
    ? getWorkerStateFromRuntimeMode({runtimeWorkerUrls})
    : getWorkerStateFromManualMode({manualWorkerUrls, runtimeWorkerUrls})
}

const getBaseURLFromWorkerUrl = (workerUrl: string | null | undefined): string | null => {
  const normalizedWorkerUrl = getTrimmedValue(workerUrl)
  const strippedWorkerUrl = normalizedWorkerUrl?.replace(/\/+$/, '') ?? null

  return strippedWorkerUrl ? (strippedWorkerUrl.endsWith('/v1') ? strippedWorkerUrl : `${strippedWorkerUrl}/v1`) : null
}

export const getProviderConnectionEffectiveBaseURL = ({
  baseURL,
  config,
  providerKind,
  runtimeSummary,
}: {
  baseURL: string | null | undefined
  config: ProviderConnectionConfig
  providerKind: string | null | undefined
  runtimeSummary?: ProviderRuntimeSummary
}): string | null => {
  const workerState = getProviderConnectionWorkerState({config, providerKind, runtimeSummary})
  const workerBaseURL = getBaseURLFromWorkerUrl(workerState.effectiveWorkerUrls[0])

  return workerBaseURL ?? getTrimmedValue(baseURL)
}
