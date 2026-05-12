import {getProviderConnectionEffectiveBaseURL} from '../../providers/providerRuntimeState.ts'
import type {ProviderConnectionRecord} from '../../providers/providerTypes.ts'
import {
  getAggregatedJudgmentDispatchTelemetry,
  type JudgmentDispatchTelemetryInput,
  type JudgmentDispatchTelemetrySnapshot,
  withJudgmentProviderEndpointDiagnostics,
} from './judgmentDispatchTelemetry.ts'
import {
  getJudgmentEndpointAvailability,
  getJudgmentEndpointAvailabilityDiagnostics,
} from './judgmentEndpointAvailability.ts'
import {getProviderBucketSnapshot, type ProviderBucketSnapshot} from './providerAdmissionLease.ts'

export type JudgmentProviderTelemetryJobInput = {
  id: string
  maxInflightRequests?: number | null
  modelId: string
  modelProvider?: string | null
  providerConnectionId?: string | null
  providerName?: string | null
}

type JudgmentProviderTelemetryEndpointDiagnostics = ReturnType<typeof getJudgmentEndpointAvailabilityDiagnostics>

export type JudgmentProviderTelemetryEndpointAvailability = JudgmentProviderTelemetryEndpointDiagnostics & {
  effectiveBaseURL: string | null
  endpointAvailabilityKey: string
  endpointIdentity: string | null
  localProbeState: JudgmentProviderTelemetryEndpointDiagnostics['status']
  providerKey: string
}

export type JudgmentProviderTelemetrySnapshotAssembly = {
  dispatchTelemetry: JudgmentDispatchTelemetrySnapshot
  effectiveBaseURL: string | null
  endpointAvailability: JudgmentProviderTelemetryEndpointAvailability | null
  providerSnapshot: ProviderBucketSnapshot
}

export const getEndpointIdentityFromAvailabilityKey = (endpointAvailabilityKey: string): string | null => {
  const separatorIndex = endpointAvailabilityKey.indexOf('::')

  return separatorIndex >= 0 ? endpointAvailabilityKey.slice(separatorIndex + 2) : null
}

export const getJudgmentProviderTelemetryProviderSnapshot = ({
  job,
  providerConnection,
  useOwnerBackedSyntheticProviderId = false,
}: {
  job: JudgmentProviderTelemetryJobInput
  providerConnection: ProviderConnectionRecord | null
  useOwnerBackedSyntheticProviderId?: boolean
}): ProviderBucketSnapshot => {
  return getProviderBucketSnapshot({
    maxInflightRequests: providerConnection?.maxInflightRequests ?? job.maxInflightRequests ?? null,
    modelId: job.modelId,
    modelProvider: providerConnection?.providerKind ?? job.modelProvider ?? null,
    providerConnectionId: providerConnection?.id ?? job.providerConnectionId ?? null,
    providerConnectionUpdatedAt: providerConnection?.updatedAt ?? null,
    providerName: providerConnection?.label ?? job.providerName ?? null,
    useOwnerBackedSyntheticProviderId,
  })
}

export const getJudgmentProviderTelemetryInput = ({
  job,
  providerConnection,
  providerSnapshot,
  readyCount,
}: {
  job: JudgmentProviderTelemetryJobInput
  providerConnection: ProviderConnectionRecord | null
  providerSnapshot: ProviderBucketSnapshot
  readyCount: number
}): JudgmentDispatchTelemetryInput => {
  return {
    jobId: job.id,
    modelId: job.modelId,
    modelProvider: providerConnection?.providerKind ?? job.modelProvider ?? null,
    providerConnectionId: providerConnection?.id ?? job.providerConnectionId ?? null,
    providerFamily: providerSnapshot.providerFamily,
    providerId: providerSnapshot.providerId,
    providerKey: providerSnapshot.providerKey,
    providerLimit: providerSnapshot.providerLimit,
    providerLimitVersion: providerSnapshot.providerLimitVersion,
    providerMaxInflightRequests: providerConnection?.maxInflightRequests ?? job.maxInflightRequests ?? null,
    providerName: providerSnapshot.providerName,
    providerUsesFamilyDefault: providerSnapshot.providerUsesFamilyDefault,
    readyCount,
    resolvedDefaultCapacity: providerSnapshot.resolvedDefaultCapacity,
  }
}

const getJudgmentProviderTelemetryEndpointAvailability = ({
  job,
  providerConnection,
  providerSnapshot,
  useOwnerBackedSyntheticProviderId,
}: {
  job: JudgmentProviderTelemetryJobInput
  providerConnection: ProviderConnectionRecord | null
  providerSnapshot: ProviderBucketSnapshot
  useOwnerBackedSyntheticProviderId: boolean
}): {effectiveBaseURL: string | null; endpointAvailability: JudgmentProviderTelemetryEndpointAvailability | null} => {
  const effectiveBaseURL = providerConnection
    ? getProviderConnectionEffectiveBaseURL({
        baseURL: providerConnection.baseURL,
        config: providerConnection.config,
        providerKind: providerConnection.providerKind,
        savedModelIds: [job.modelId],
      })
    : null
  const availability = effectiveBaseURL
    ? getJudgmentEndpointAvailability({
        effectiveBaseURL,
        modelId: job.modelId,
        modelProvider: providerConnection?.providerKind ?? job.modelProvider ?? null,
        providerConnectionId: providerConnection?.id ?? job.providerConnectionId ?? null,
        providerKey: providerSnapshot.providerKey,
        useOwnerBackedSyntheticProviderId,
      })
    : null
  const diagnostics = availability ? getJudgmentEndpointAvailabilityDiagnostics(availability) : null

  return {
    effectiveBaseURL,
    endpointAvailability:
      diagnostics && availability
        ? {
            ...diagnostics,
            effectiveBaseURL,
            endpointAvailabilityKey: availability.endpointAvailabilityKey,
            endpointIdentity: getEndpointIdentityFromAvailabilityKey(availability.endpointAvailabilityKey),
            localProbeState: diagnostics.status,
            providerKey: providerSnapshot.providerKey,
          }
        : null,
  }
}

export const getJudgmentProviderTelemetrySnapshot = async ({
  job,
  providerConnection,
  readyCount,
  useOwnerBackedSyntheticProviderId = false,
}: {
  job: JudgmentProviderTelemetryJobInput
  providerConnection: ProviderConnectionRecord | null
  readyCount: number
  useOwnerBackedSyntheticProviderId?: boolean
}): Promise<JudgmentProviderTelemetrySnapshotAssembly> => {
  const providerSnapshot = getJudgmentProviderTelemetryProviderSnapshot({
    job,
    providerConnection,
    useOwnerBackedSyntheticProviderId,
  })
  const {effectiveBaseURL, endpointAvailability} = getJudgmentProviderTelemetryEndpointAvailability({
    job,
    providerConnection,
    providerSnapshot,
    useOwnerBackedSyntheticProviderId,
  })
  const snapshot = await getAggregatedJudgmentDispatchTelemetry(
    getJudgmentProviderTelemetryInput({job, providerConnection, providerSnapshot, readyCount}),
  )

  return {
    dispatchTelemetry: withJudgmentProviderEndpointDiagnostics({
      diagnostics: endpointAvailability,
      effectiveBaseURL,
      endpointAvailabilityKey: endpointAvailability?.endpointAvailabilityKey ?? null,
      snapshot,
    }),
    effectiveBaseURL,
    endpointAvailability,
    providerSnapshot,
  }
}
