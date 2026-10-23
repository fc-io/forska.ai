import {
  getJudgmentEndpointAvailability,
  getJudgmentEndpointAvailabilityDiagnostics,
} from '../../cron/judgmentsJobs/judgmentEndpointAvailability.ts'
import {getEndpointIdentityFromAvailabilityKey} from '../../cron/judgmentsJobs/judgmentProviderTelemetrySnapshot.ts'
import {getProviderBucketSnapshot} from '../../cron/judgmentsJobs/providerAdmissionLease.ts'
import {getProviderConnectionForStoredModel} from '../../providers/providerConnectionRepository.ts'
import {getProviderConnectionEffectiveBaseURL} from '../../providers/providerRuntimeState.ts'
import type {JudgmentJobSqliteHealthProjectionReader} from '../../services/judgmentJobSqliteHealthProjectionService.ts'
import type {JudgmentJobEndpointHealth} from './judgmentJobHealthTypes.ts'

const getObservedAggregateProbeLiveCountForHealth = (
  diagnostics: NonNullable<JudgmentJobEndpointHealth['diagnostics']>[],
): number | null => {
  const observedCounts = diagnostics.flatMap((entry) => {
    return entry.observedAggregateProbeLiveCount === null ? [] : [entry.observedAggregateProbeLiveCount]
  })

  return observedCounts.length === 0
    ? null
    : observedCounts.reduce((sum, count) => {
        return sum + count
      }, 0)
}

const getEndpointDiagnosticsSummaryForHealth = ({
  diagnostics,
  hasHealthyEndpointOrEndpointlessPath,
  providerKey,
}: {
  diagnostics: NonNullable<JudgmentJobEndpointHealth['diagnostics']>[]
  hasHealthyEndpointOrEndpointlessPath: boolean
  providerKey: string
}): JudgmentJobEndpointHealth['providerDiagnostics']['endpointDiagnosticsSummary'] => {
  const getCountByState = (state: string) => {
    return diagnostics.filter((entry) => {
      return entry.status === state
    }).length
  }
  const localProbeLiveCount = diagnostics.reduce((sum, entry) => {
    return sum + entry.localProbeLiveCount
  }, 0)
  const cooldownEndpointCount = getCountByState('cooldown')
  const healthyEndpointCount = getCountByState('healthy')
  const misconfiguredEndpointCount = getCountByState('misconfigured')
  const probingEndpointCount = getCountByState('probing')
  const unhealthyEndpointCount =
    diagnostics.length
    - healthyEndpointCount
    - cooldownEndpointCount
    - misconfiguredEndpointCount
    - probingEndpointCount

  return {
    blockedEndpointCount:
      diagnostics.length === 0 ? 0 : diagnostics.length - healthyEndpointCount - probingEndpointCount,
    cooldownEndpointCount,
    endpointCount: diagnostics.length,
    hasHealthyEndpointOrEndpointlessPath,
    healthyEndpointCount,
    localProbeLiveCount,
    misconfiguredEndpointCount,
    observedAggregateProbeLiveCount: getObservedAggregateProbeLiveCountForHealth(diagnostics),
    probeInProgress: diagnostics.some((entry) => {
      return entry.probeInProgress
    }),
    providerKey,
    probingEndpointCount,
    unhealthyEndpointCount,
  }
}

const getEndpointProviderDiagnosticsForHealth = ({
  diagnostics,
  hasHealthyEndpointOrEndpointlessPath,
  providerKey,
}: {
  diagnostics: NonNullable<JudgmentJobEndpointHealth['diagnostics']>[]
  hasHealthyEndpointOrEndpointlessPath: boolean
  providerKey: string
}): JudgmentJobEndpointHealth['providerDiagnostics'] => {
  return {
    endpointDiagnosticsByKey: diagnostics.reduce<
      JudgmentJobEndpointHealth['providerDiagnostics']['endpointDiagnosticsByKey']
    >((byKey, entry) => {
      return {...byKey, [entry.endpointAvailabilityKey]: entry}
    }, {}),
    endpointDiagnosticsSummary: getEndpointDiagnosticsSummaryForHealth({
      diagnostics,
      hasHealthyEndpointOrEndpointlessPath,
      providerKey,
    }),
    providerKey,
  }
}

export const getJudgmentJobEndpointHealth = async ({
  db,
  modelId,
}: {
  db: JudgmentJobSqliteHealthProjectionReader
  modelId: string
}): Promise<JudgmentJobEndpointHealth> => {
  const providerConnection = await getProviderConnectionForStoredModel(modelId, db)
  const effectiveBaseURL = providerConnection
    ? getProviderConnectionEffectiveBaseURL({
        baseURL: providerConnection.baseURL,
        config: providerConnection.config,
        providerKind: providerConnection.providerKind,
        savedModelIds: [modelId],
      })
    : null
  const providerSnapshot = getProviderBucketSnapshot({
    maxInflightRequests: providerConnection?.maxInflightRequests ?? null,
    modelId,
    modelProvider: providerConnection?.providerKind ?? null,
    providerConnectionId: providerConnection?.id ?? null,
    providerConnectionUpdatedAt: providerConnection?.updatedAt ?? null,
    providerName: providerConnection?.label ?? null,
    useOwnerBackedSyntheticProviderId: false,
  })
  const availability = effectiveBaseURL
    ? getJudgmentEndpointAvailability({
        effectiveBaseURL,
        modelId,
        modelProvider: providerConnection?.providerKind ?? null,
        providerConnectionId: providerConnection?.id ?? null,
      })
    : null
  const diagnostics = availability ? getJudgmentEndpointAvailabilityDiagnostics(availability) : null
  const endpointDiagnostics =
    diagnostics && availability
      ? {
          ...diagnostics,
          effectiveBaseURL,
          endpointAvailabilityKey: availability.endpointAvailabilityKey,
          endpointIdentity: getEndpointIdentityFromAvailabilityKey(availability.endpointAvailabilityKey),
          localProbeState: diagnostics.status,
          providerKey: providerSnapshot.providerKey,
        }
      : null
  const endpointDiagnosticsList = endpointDiagnostics ? [endpointDiagnostics] : []
  const hasHealthyEndpointOrEndpointlessPath = !endpointDiagnostics || endpointDiagnostics.status === 'healthy'

  return {
    diagnostics: endpointDiagnostics,
    providerDiagnostics: getEndpointProviderDiagnosticsForHealth({
      diagnostics: endpointDiagnosticsList,
      hasHealthyEndpointOrEndpointlessPath,
      providerKey: providerSnapshot.providerKey,
    }),
    retryAfterAt: availability?.cooldownExpiresAt?.toISOString() ?? null,
  }
}
