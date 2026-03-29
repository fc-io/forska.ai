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

const getMatchedWorkerUrls = ({
  savedWorkerUrls,
  runtimeWorkerUrls,
}: {
  runtimeWorkerUrls: string[]
  savedWorkerUrls: string[]
}): string[] => {
  return savedWorkerUrls.filter((workerUrl) => {
    return runtimeWorkerUrls.includes(workerUrl)
  })
}

const getMatchedModelNames = ({
  runtimeModelNames,
  savedModelIds,
}: {
  runtimeModelNames: string[]
  savedModelIds: string[]
}): string[] => {
  return savedModelIds.filter((modelId) => {
    return runtimeModelNames.includes(modelId)
  })
}

const getUniqueReasons = (reasons: ProviderRuntimeMatch['reasons']): ProviderRuntimeMatch['reasons'] => {
  return Array.from(new Set(reasons))
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
  savedModelIds = [],
  runtimeSummary,
}: {
  baseURL: string | null | undefined
  config: ProviderConnectionConfig
  providerKind: string | null | undefined
  savedModelIds?: string[]
  runtimeSummary?: ProviderRuntimeSummary
}): ProviderRuntimeMatch => {
  const candidates = getProviderConnectionRuntimeCandidates({baseURL, config, providerKind, runtimeSummary})
  const resolutionMode = getProviderConnectionResolutionMode({config, providerKind})
  const normalizedBaseURL = getTrimmedValue(baseURL)
  const manualWorkerUrls = normalizeWorkerUrls(config.manualWorkerUrls)
  const runtimeCandidate = candidates.find((candidate) => {
    return candidate.source === 'detected-runtime'
  })
  const runtimeModelNames = runtimeCandidate?.modelNames ?? []
  const runtimeRemoteUrls = runtimeCandidate?.remoteUrls ?? []
  const runtimeWorkerUrls = runtimeCandidate?.localUrls ?? []
  const matchedWorkerUrls = getMatchedWorkerUrls({runtimeWorkerUrls, savedWorkerUrls: manualWorkerUrls})
  const hasBaseUrlOverlap = normalizedBaseURL ? runtimeRemoteUrls.includes(normalizedBaseURL) : false
  const hasWorkerUrlOverlap = matchedWorkerUrls.length > 0
  const hasUrlOverlap = hasBaseUrlOverlap || hasWorkerUrlOverlap
  const matchedModelNames = getMatchedModelNames({runtimeModelNames, savedModelIds: getUniqueValues(savedModelIds)})
  const hasModelOverlap = matchedModelNames.length > 0
  const hasSavedBaseUrlConflict = Boolean(normalizedBaseURL) && !hasBaseUrlOverlap && runtimeRemoteUrls.length > 0
  const hasSavedWorkerConflict = manualWorkerUrls.length > 0 && !hasWorkerUrlOverlap && runtimeWorkerUrls.length > 0

  if (resolutionMode === 'manual') {
    const manualCandidate =
      candidates.find((candidate) => {
        return candidate.status === 'matched'
      }) ?? null
    const reason = manualCandidate?.reason ?? (normalizedBaseURL ? 'manual-provider' : 'no-saved-url')
    const effectiveWorkerUrls = manualCandidate?.source === 'saved-manual-worker' ? manualCandidate.localUrls : []

    return {
      candidate: manualCandidate,
      detectedModelNames: runtimeModelNames,
      effectiveBaseURL: normalizedBaseURL,
      effectiveWorkerUrls,
      localUrls: manualCandidate?.localUrls ?? [],
      modelNames: runtimeModelNames,
      reason,
      reasons: getUniqueReasons(['manual-mode', reason]),
      remoteUrls: manualCandidate?.remoteUrls ?? (normalizedBaseURL ? [normalizedBaseURL] : []),
      resolutionMode,
      source: manualCandidate?.source ?? 'none',
      status: 'manual-only',
    }
  }

  if (!runtimeCandidate || runtimeWorkerUrls.length === 0) {
    const reason = runtimeCandidate?.reason ?? 'runtime-provider-missing'

    return {
      candidate: null,
      detectedModelNames: runtimeModelNames,
      effectiveBaseURL: normalizedBaseURL,
      effectiveWorkerUrls: [],
      localUrls: [],
      modelNames: runtimeModelNames,
      reason,
      reasons: getUniqueReasons([reason]),
      remoteUrls: [],
      resolutionMode,
      source: 'none',
      status: 'unreachable',
    }
  }

  if (!hasUrlOverlap) {
    return {
      candidate: null,
      detectedModelNames: runtimeModelNames,
      effectiveBaseURL: normalizedBaseURL,
      effectiveWorkerUrls: [],
      localUrls: [],
      modelNames: runtimeModelNames,
      reason:
        runtimeRemoteUrls.length > 0 || runtimeWorkerUrls.length > 0 ? 'runtime-url-missing' : 'runtime-worker-missing',
      reasons: getUniqueReasons([
        runtimeCandidate.reason,
        hasModelOverlap ? 'runtime-model-overlap' : 'runtime-url-missing',
      ]),
      remoteUrls: runtimeRemoteUrls,
      resolutionMode,
      source: 'none',
      status: 'unreachable',
    }
  }

  if (hasSavedBaseUrlConflict || hasSavedWorkerConflict) {
    return {
      candidate: runtimeCandidate,
      detectedModelNames: runtimeModelNames,
      effectiveBaseURL: normalizedBaseURL,
      effectiveWorkerUrls: [],
      localUrls: runtimeWorkerUrls,
      modelNames: runtimeModelNames,
      reason: 'runtime-url-conflict',
      reasons: getUniqueReasons([
        runtimeCandidate.reason,
        hasBaseUrlOverlap ? 'runtime-base-url-overlap' : 'runtime-url-conflict',
        hasWorkerUrlOverlap ? 'runtime-worker-url-overlap' : 'runtime-url-conflict',
        hasModelOverlap ? 'runtime-model-overlap' : 'runtime-url-conflict',
      ]),
      remoteUrls: runtimeRemoteUrls,
      resolutionMode,
      source: 'none',
      status: 'ambiguous',
    }
  }

  return {
    candidate: runtimeCandidate,
    detectedModelNames: runtimeModelNames,
    effectiveBaseURL: runtimeRemoteUrls[0] ?? normalizedBaseURL,
    effectiveWorkerUrls: runtimeWorkerUrls,
    localUrls: runtimeWorkerUrls,
    modelNames: runtimeModelNames,
    reason: 'runtime-auto-detect',
    reasons: getUniqueReasons([
      'runtime-auto-detect',
      hasBaseUrlOverlap ? 'runtime-base-url-overlap' : 'runtime-auto-detect',
      hasWorkerUrlOverlap ? 'runtime-worker-url-overlap' : 'runtime-auto-detect',
      hasModelOverlap ? 'runtime-model-overlap' : 'runtime-auto-detect',
    ]),
    remoteUrls: runtimeRemoteUrls,
    resolutionMode,
    source: runtimeCandidate.source,
    status: 'matched',
  }
}

const getWorkerStateFromRuntimeMode = ({
  match,
  runtimeWorkerUrls,
}: {
  match: ProviderRuntimeMatch
  runtimeWorkerUrls: string[]
}): ProviderConnectionWorkerState => {
  return match.status === 'matched' && match.source === 'detected-runtime'
    ? {
        effectiveWorkerUrls: match.effectiveWorkerUrls,
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
  return match.status === 'manual-only' && match.source === 'saved-manual-worker'
    ? {
        effectiveWorkerUrls: match.effectiveWorkerUrls,
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
  savedModelIds,
  runtimeSummary,
}: {
  baseURL?: string | null | undefined
  config: ProviderConnectionConfig
  providerKind: string | null | undefined
  savedModelIds?: string[]
  runtimeSummary?: ProviderRuntimeSummary
}): ProviderConnectionWorkerState => {
  const runtimeWorkerUrls = supportsRuntimeWorkerUrls(providerKind)
    ? getRuntimeWorkerUrlsForProvider({providerKind, runtimeSummary})
    : []
  const match = getProviderConnectionRuntimeMatch({baseURL, config, providerKind, runtimeSummary, savedModelIds})

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
  savedModelIds,
  runtimeSummary,
}: {
  baseURL: string | null | undefined
  config: ProviderConnectionConfig
  providerKind: string | null | undefined
  savedModelIds?: string[]
  runtimeSummary?: ProviderRuntimeSummary
}): string | null => {
  const runtimeMatch = getProviderConnectionRuntimeMatch({baseURL, config, providerKind, runtimeSummary, savedModelIds})

  return runtimeMatch.effectiveBaseURL
}
