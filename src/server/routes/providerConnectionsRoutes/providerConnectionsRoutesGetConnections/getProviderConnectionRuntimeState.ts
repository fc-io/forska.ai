import {
  getJudgmentEndpointAvailability,
  getJudgmentEndpointAvailabilityDiagnostics,
} from '../../../cron/judgmentsJobs/judgmentEndpointAvailability.ts'
import {getDetectedProviderRuntimeSummaries} from '../../../providers/providerRuntimeDetector.ts'
import {resolveProviderConnectionRuntimeMatchFromSummaries} from '../../../providers/providerRuntimeMatchResolver.ts'
import type {
  ProviderConnectionRuntimeState,
  ProviderRuntimeMatch,
  ProviderRuntimeSourceMetadata,
} from '../../../providers/providerTypes.ts'
import {getSavedModelIds} from '../getSavedModelIds.ts'

const getRuntimeSourceLabel = (sourceMetadata: ProviderRuntimeSourceMetadata | null): string => {
  return sourceMetadata?.label ?? 'local'
}

const getRuntimeStatusLabel = ({
  sourceMetadata,
  status,
}: {
  sourceMetadata: ProviderRuntimeSourceMetadata | null
  status: ProviderRuntimeMatch['status']
}): string => {
  return status === 'matched'
    ? `matched ${getRuntimeSourceLabel(sourceMetadata)}`
    : status === 'manual-only'
      ? 'manual-only'
      : status === 'ambiguous'
        ? 'ambiguous'
        : 'unreachable'
}

const getRuntimeReasonLabel = ({
  reason,
  sourceMetadata,
}: {
  reason: ProviderRuntimeMatch['reason']
  sourceMetadata: ProviderRuntimeSourceMetadata | null
}): string => {
  const sourceLabel = getRuntimeSourceLabel(sourceMetadata)

  return reason === 'manual-mode'
    ? 'This connection is using saved manual settings.'
    : reason === 'manual-base-url'
      ? 'This connection is using its saved base URL.'
      : reason === 'manual-provider'
        ? 'This connection is using its saved provider settings.'
        : reason === 'manual-worker-url'
          ? 'This connection is using its saved manual worker URLs.'
          : reason === 'runtime-base-url-overlap'
            ? 'The saved base URL overlaps the detected runtime URL.'
            : reason === 'no-saved-url'
              ? 'This connection has no saved base URL or manual worker URLs.'
              : reason === 'runtime-auto-detect'
                ? `Auto-detect matched the active ${sourceLabel} runtime.`
                : reason === 'runtime-model-overlap'
                  ? 'A saved model on this connection is currently served by the detected runtime.'
                  : reason === 'runtime-provider-mismatch'
                    ? 'A runtime is active, but it is for another provider kind.'
                    : reason === 'runtime-provider-missing'
                      ? 'No active runtime was detected for this provider kind.'
                      : reason === 'runtime-url-conflict'
                        ? 'Saved URLs or detected runtime targets conflict, so Forska cannot pick a single runtime.'
                        : reason === 'runtime-url-missing'
                          ? 'A runtime was detected, but its URLs do not overlap this connection.'
                          : reason === 'runtime-worker-url-overlap'
                            ? 'The saved manual worker URLs overlap the detected runtime worker URLs.'
                            : 'A runtime was detected, but it does not expose reachable worker URLs.'
}

export const getProviderConnectionRuntimeState = ({
  connection,
  runtimeSummaries,
}: {
  connection: {
    baseURL: string | null
    config: {manualWorkerUrls: string[]; workerUrlMode: 'manual' | 'runtime'}
    id: string
    models: Array<{modelName: string | null; remoteModelId: string | null}>
    providerKind: string
  }
  runtimeSummaries: Awaited<ReturnType<typeof getDetectedProviderRuntimeSummaries>>
}): ProviderConnectionRuntimeState => {
  const match: ProviderRuntimeMatch = resolveProviderConnectionRuntimeMatchFromSummaries({
    baseURL: connection.baseURL,
    config: connection.config,
    providerKind: connection.providerKind,
    runtimeSummaries,
    savedModelIds: getSavedModelIds(connection.models),
  })
  const endpointAvailability = match.effectiveBaseURL
    ? getJudgmentEndpointAvailabilityDiagnostics(
        getJudgmentEndpointAvailability({
          effectiveBaseURL: match.effectiveBaseURL,
          modelProvider: connection.providerKind,
          providerConnectionId: connection.id,
        }),
      )
    : null

  return {
    detectedModelNames: match.detectedModelNames,
    endpointAvailability,
    effectiveBaseURL: match.effectiveBaseURL,
    effectiveWorkerUrls: match.effectiveWorkerUrls,
    reason: match.reason,
    reasonLabel: getRuntimeReasonLabel({reason: match.reason, sourceMetadata: match.sourceMetadata}),
    reasonLabels: match.reasons.map((reason) => {
      return getRuntimeReasonLabel({reason, sourceMetadata: match.sourceMetadata})
    }),
    sourceMetadata: match.sourceMetadata,
    status: match.status,
    statusLabel: getRuntimeStatusLabel({sourceMetadata: match.sourceMetadata, status: match.status}),
  }
}
