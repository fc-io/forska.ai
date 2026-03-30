import {getDetectedProviderRuntimeSummaries} from './providerRuntimeDetector.ts'
import {getProviderConnectionRuntimeMatch} from './providerRuntimeState.ts'
import {type ProviderConnectionConfig, type ProviderRuntimeMatch} from './providerTypes.ts'

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

const getTargetSignature = (match: ProviderRuntimeMatch): string => {
  return JSON.stringify({baseURL: match.effectiveBaseURL, workerUrls: match.effectiveWorkerUrls})
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
    source: 'none',
    status: 'ambiguous',
  }
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
  const matches = detectedSummaries.map((runtimeSummary) => {
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
