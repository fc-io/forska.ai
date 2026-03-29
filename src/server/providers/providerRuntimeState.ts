import {normalizeProviderKind} from '../services/providerCatalog.ts'
import {inferenceRuntimeConfig} from '../utils/getInferenceRuntimeConfig.ts'
import {
  type ProviderConnectionConfig,
  type ProviderConnectionResolutionMode,
  type ProviderRuntimeCandidate,
  type ProviderRuntimeMatch,
  type ProviderWorkerSource,
} from './providerTypes.ts'
import {normalizeWorkerUrls, supportsRuntimeWorkerUrls} from './providerWorkerUtils.ts'

export type ProviderRuntimeSummary = {activeModelNames: string[]; providerKind: string | null; workerUrls: string[]}

export type ProviderConnectionWorkerState = {
  effectiveWorkerUrls: string[]
  match: ProviderRuntimeMatch
  resolutionMode: ProviderConnectionResolutionMode
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

const getUniqueValues = (values: Array<string | null | undefined>): string[] => {
  return Array.from(
    new Set(
      values.flatMap((value) => {
        const normalizedValue = getTrimmedValue(value)

        return normalizedValue ? [normalizedValue] : []
      }),
    ),
  )
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

const getRemoteUrlsFromWorkerUrls = (workerUrls: string[]): string[] => {
  return getUniqueValues(
    workerUrls.map((workerUrl) => {
      return getBaseURLFromWorkerUrl(workerUrl)
    }),
  )
}

export const getProviderConnectionResolutionMode = ({
  config,
  providerKind,
}: {
  config: ProviderConnectionConfig
  providerKind: string | null | undefined
}): ProviderConnectionResolutionMode => {
  return config.workerUrlMode === 'runtime' && supportsRuntimeWorkerUrls(providerKind) ? 'auto-detect' : 'manual'
}

export const getProviderConnectionRuntimeCandidates = ({
  baseURL,
  config,
  providerKind,
  runtimeSummary,
}: {
  baseURL: string | null | undefined
  config: ProviderConnectionConfig
  providerKind: string | null | undefined
  runtimeSummary?: ProviderRuntimeSummary
}): ProviderRuntimeCandidate[] => {
  const resolutionMode = getProviderConnectionResolutionMode({config, providerKind})
  const normalizedBaseURL = getTrimmedValue(baseURL)
  const manualWorkerUrls = normalizeWorkerUrls(config.manualWorkerUrls)
  const runtimeWorkerUrls = supportsRuntimeWorkerUrls(providerKind)
    ? getRuntimeWorkerUrlsForProvider({providerKind, runtimeSummary})
    : []
  const activeRuntimeSummary = runtimeSummary ?? getProviderRuntimeSummary()
  const normalizedProviderKind = normalizeProviderKind(providerKind)
  const runtimeProviderKind = activeRuntimeSummary.providerKind
  const runtimeModelNames =
    runtimeProviderKind === normalizedProviderKind ? getUniqueValues(activeRuntimeSummary.activeModelNames) : []

  return [
    {
      localUrls: manualWorkerUrls,
      modelNames: [],
      reason: 'manual-worker-url',
      remoteUrls: getRemoteUrlsFromWorkerUrls(manualWorkerUrls),
      source: 'saved-manual-worker',
      status:
        resolutionMode === 'manual' && manualWorkerUrls.length > 0
          ? 'matched'
          : manualWorkerUrls.length > 0
            ? 'available'
            : 'unavailable',
    },
    {
      localUrls: [],
      modelNames: [],
      reason: 'manual-base-url',
      remoteUrls: normalizedBaseURL ? [normalizedBaseURL] : [],
      source: 'saved-base-url',
      status:
        resolutionMode === 'manual' && manualWorkerUrls.length === 0 && normalizedBaseURL
          ? 'matched'
          : normalizedBaseURL
            ? 'available'
            : 'unavailable',
    },
    {
      localUrls: runtimeWorkerUrls,
      modelNames: runtimeModelNames,
      reason:
        runtimeProviderKind === normalizedProviderKind
          ? runtimeWorkerUrls.length > 0
            ? 'runtime-auto-detect'
            : 'runtime-worker-missing'
          : runtimeProviderKind
            ? 'runtime-provider-mismatch'
            : 'runtime-provider-missing',
      remoteUrls: getRemoteUrlsFromWorkerUrls(runtimeWorkerUrls),
      source: 'detected-runtime',
      status:
        resolutionMode === 'auto-detect'
        && runtimeProviderKind === normalizedProviderKind
        && runtimeWorkerUrls.length > 0
          ? 'matched'
          : runtimeWorkerUrls.length > 0
            ? 'available'
            : 'unavailable',
    },
  ]
}

export const getProviderConnectionRuntimeMatch = ({
  baseURL,
  config,
  providerKind,
  runtimeSummary,
}: {
  baseURL: string | null | undefined
  config: ProviderConnectionConfig
  providerKind: string | null | undefined
  runtimeSummary?: ProviderRuntimeSummary
}): ProviderRuntimeMatch => {
  const candidates = getProviderConnectionRuntimeCandidates({baseURL, config, providerKind, runtimeSummary})
  const resolutionMode = getProviderConnectionResolutionMode({config, providerKind})
  const matchedCandidate =
    candidates.find((candidate) => {
      return candidate.status === 'matched'
    }) ?? null
  const normalizedBaseURL = getTrimmedValue(baseURL)
  const runtimeCandidate = candidates.find((candidate) => {
    return candidate.source === 'detected-runtime'
  })

  return matchedCandidate
    ? {
        candidate: matchedCandidate,
        localUrls: matchedCandidate.localUrls,
        modelNames: matchedCandidate.modelNames,
        reason: matchedCandidate.reason,
        remoteUrls: matchedCandidate.remoteUrls,
        resolutionMode,
        source: matchedCandidate.source,
        status: 'matched',
      }
    : {
        candidate: null,
        localUrls: [],
        modelNames: runtimeCandidate?.modelNames ?? [],
        reason:
          resolutionMode === 'auto-detect'
            ? (runtimeCandidate?.reason ?? 'runtime-provider-missing')
            : normalizedBaseURL
              ? 'manual-provider'
              : 'no-saved-url',
        remoteUrls: [],
        resolutionMode,
        source: 'none',
        status: 'unavailable',
      }
}

const getWorkerStateFromRuntimeMode = ({
  match,
  runtimeWorkerUrls,
}: {
  match: ProviderRuntimeMatch
  runtimeWorkerUrls: string[]
}): ProviderConnectionWorkerState => {
  return match.source === 'detected-runtime'
    ? {
        effectiveWorkerUrls: match.localUrls,
        match,
        resolutionMode: match.resolutionMode,
        runtimeWorkerUrls,
        workerSource: 'runtime',
      }
    : {effectiveWorkerUrls: [], match, resolutionMode: match.resolutionMode, runtimeWorkerUrls, workerSource: 'none'}
}

const getWorkerStateFromManualMode = ({
  match,
  runtimeWorkerUrls,
}: {
  match: ProviderRuntimeMatch
  runtimeWorkerUrls: string[]
}): ProviderConnectionWorkerState => {
  return match.source === 'saved-manual-worker'
    ? {
        effectiveWorkerUrls: match.localUrls,
        match,
        resolutionMode: match.resolutionMode,
        runtimeWorkerUrls,
        workerSource: 'manual',
      }
    : {effectiveWorkerUrls: [], match, resolutionMode: match.resolutionMode, runtimeWorkerUrls, workerSource: 'none'}
}

export const getProviderConnectionWorkerState = ({
  baseURL,
  config,
  providerKind,
  runtimeSummary,
}: {
  baseURL?: string | null | undefined
  config: ProviderConnectionConfig
  providerKind: string | null | undefined
  runtimeSummary?: ProviderRuntimeSummary
}): ProviderConnectionWorkerState => {
  const runtimeWorkerUrls = supportsRuntimeWorkerUrls(providerKind)
    ? getRuntimeWorkerUrlsForProvider({providerKind, runtimeSummary})
    : []
  const match = getProviderConnectionRuntimeMatch({baseURL, config, providerKind, runtimeSummary})

  return match.resolutionMode === 'auto-detect'
    ? getWorkerStateFromRuntimeMode({match, runtimeWorkerUrls})
    : getWorkerStateFromManualMode({match, runtimeWorkerUrls})
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
  const runtimeMatch = getProviderConnectionRuntimeMatch({baseURL, config, providerKind, runtimeSummary})
  const workerBaseURL = getTrimmedValue(runtimeMatch.remoteUrls[0])

  return workerBaseURL ?? getTrimmedValue(baseURL)
}
