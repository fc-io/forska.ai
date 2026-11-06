import type {ProviderQuotaReadingInsert} from '../../services/providerQuotaReadingService.ts'

type CodexReadingContext = {observedAt: Date; providerConnectionId: string}

const codexRateLimitWindows = ['primary', 'secondary'] as const

const getRecord = (value: unknown): Record<string, unknown> | null => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

const getResetsAt = (value: unknown): Date | null => {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value * 1000) : null
}

const getStringOrNull = (value: unknown): string | null => {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

const getCodexSnapshotReadings = (
  snapshot: Record<string, unknown>,
  context: CodexReadingContext,
): ProviderQuotaReadingInsert[] => {
  const limitId = getStringOrNull(snapshot.limitId) ?? 'codex'

  return codexRateLimitWindows.flatMap((windowName) => {
    const window = getRecord(snapshot[windowName])

    return window && typeof window.usedPercent === 'number'
      ? [
          {
            isActive: null,
            limitKind: `${limitId}:${windowName}`,
            observedAt: context.observedAt,
            providerConnectionId: context.providerConnectionId,
            providerKind: 'codex',
            rawJson: window,
            resetsAt: getResetsAt(window.resetsAt),
            scopeJson: {
              limitId,
              limitName: getStringOrNull(snapshot.limitName),
              planType: snapshot.planType ?? null,
              rateLimitReachedType: snapshot.rateLimitReachedType ?? null,
              windowDurationMins: typeof window.windowDurationMins === 'number' ? window.windowDurationMins : null,
            },
            utilizationPercent: window.usedPercent,
          },
        ]
      : []
  })
}

const getCodexRateLimitSnapshots = (response: Record<string, unknown>): Record<string, unknown>[] => {
  const byLimitId = getRecord(response.rateLimitsByLimitId)
  const snapshots = byLimitId ? Object.values(byLimitId) : [response.rateLimits]

  return snapshots.flatMap((snapshot) => {
    const record = getRecord(snapshot)

    return record ? [record] : []
  })
}

export const parseCodexRateLimitReadings = (
  response: unknown,
  context: CodexReadingContext,
): ProviderQuotaReadingInsert[] => {
  const record = getRecord(response)

  return record
    ? getCodexRateLimitSnapshots(record).flatMap((snapshot) => {
        return getCodexSnapshotReadings(snapshot, context)
      })
    : []
}
