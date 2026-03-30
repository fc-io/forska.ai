import {getDetectedProviderRuntimeSummaries} from './providerRuntimeDetector.ts'
import {getProviderConnectionRuntimeMatch, type ProviderRuntimeSummary} from './providerRuntimeState.ts'
import {type ProviderConnectionConfig, type ProviderRuntimeMatch} from './providerTypes.ts'

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

const getUniqueReasons = (reasons: ProviderRuntimeMatch['reasons']): ProviderRuntimeMatch['reasons'] => {
  return Array.from(new Set(reasons))
}

const getMatchPriority = (match: ProviderRuntimeMatch): number => {
  return match.status === 'ambiguous'
    ? 0
    : match.reason === 'runtime-url-missing'
      ? 1
      : match.reason === 'runtime-worker-missing'
        ? 2
        : match.reason === 'runtime-provider-mismatch'
          ? 3
          : 4
}

const getComparableUrl = (value: string | null | undefined): string | null => {
  const normalizedValue = String(value ?? '').trim()

  if (!normalizedValue) {
    return null
  }

  try {
    const parsed = new URL(normalizedValue)
    const hostname = loopbackHosts.has(parsed.hostname.toLowerCase()) ? 'loopback' : parsed.hostname.toLowerCase()
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80')
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/'

    return `${parsed.protocol}//${hostname}:${port}${pathname}`
  } catch {
    return normalizedValue.replace(/\/+$/, '')
  }
}

const getTargetSignature = (match: ProviderRuntimeMatch): string => {
  return JSON.stringify({
    baseURL: getComparableUrl(match.effectiveBaseURL),
    workerUrls: match.effectiveWorkerUrls
      .map((workerUrl) => {
        return getComparableUrl(workerUrl)
      })
      .filter((workerUrl): workerUrl is string => {
        return Boolean(workerUrl)
      })
      .sort(),
  })
}

const getAmbiguousMatch = (matches: ProviderRuntimeMatch[]): ProviderRuntimeMatch => {
  const firstMatch =
    matches[0]
    ?? getProviderConnectionRuntimeMatch({
      baseURL: null,
      config: {manualWorkerUrls: [], workerUrlMode: 'manual'},
      providerKind: null,
    })

  return {
    ...firstMatch,
    candidate: firstMatch.candidate,
    effectiveWorkerUrls: [],
    reason: 'runtime-url-conflict',
    reasons: getUniqueReasons(
      matches.flatMap((match) => {
        return [...match.reasons, 'runtime-url-conflict']
      }),
    ),
    sourceMetadata: null,
    source: 'none',
    status: 'ambiguous',
  }
}

export const resolveProviderConnectionRuntimeMatchFromSummaries = ({
  baseURL,
  config,
  providerKind,
  runtimeSummaries,
  savedModelIds = [],
}: {
  baseURL: string | null | undefined
  config: ProviderConnectionConfig
  providerKind: string | null | undefined
  runtimeSummaries: ProviderRuntimeSummary[]
  savedModelIds?: string[]
}): ProviderRuntimeMatch => {
  const matches = runtimeSummaries.map((runtimeSummary) => {
    return getProviderConnectionRuntimeMatch({baseURL, config, providerKind, runtimeSummary, savedModelIds})
  })
  const matchedTargets = Array.from(
    new Map(
      matches
        .filter((match) => {
          return match.status === 'matched'
        })
        .map((match) => {
          return [getTargetSignature(match), match] as const
        }),
    ).values(),
  )

  return matchedTargets.length > 1
    ? getAmbiguousMatch(matchedTargets)
    : matchedTargets[0]
      ? matchedTargets[0]
      : (matches.sort((left, right) => {
          return getMatchPriority(left) - getMatchPriority(right)
        })[0] ?? getProviderConnectionRuntimeMatch({baseURL, config, providerKind, savedModelIds}))
}

export const resolveProviderConnectionRuntimeMatch = async ({
  baseURL,
  config,
  providerKind,
  savedModelIds = [],
}: {
  baseURL: string | null | undefined
  config: ProviderConnectionConfig
  providerKind: string | null | undefined
  savedModelIds?: string[]
}): Promise<ProviderRuntimeMatch> => {
  const detectedSummaries = await getDetectedProviderRuntimeSummaries()

  return resolveProviderConnectionRuntimeMatchFromSummaries({
    baseURL,
    config,
    providerKind,
    runtimeSummaries: detectedSummaries,
    savedModelIds,
  })
}
