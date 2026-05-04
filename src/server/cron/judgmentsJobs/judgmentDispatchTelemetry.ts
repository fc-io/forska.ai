import {
  type DuckdbOwnerConnectionRecord,
  getDuckdbOwnerConnectionsOverview,
} from '../../utils/duckdbOwnerConnections.ts'
import {shouldCurrentServerRunJudgingLoops} from '../../utils/serverRuntimeRole.ts'
import {
  getAcceptedJudgeWorkerClaimLifecycleRows,
  shouldUseJudgeWorkerOwnerHandoff,
} from './judgeWorkerCompletionJournal.ts'
import {
  getJudgmentDispatchPromptLifecycleRecords,
  getJudgmentDispatchProviderKey,
  getJudgmentDispatchProviderStats,
  type JudgmentDispatchProviderStats,
  type ProviderQueueInput,
} from './judgmentDispatchRuntime.ts'
import {getJudgmentJobSqliteService, type JudgmentJobQueuePromptLifecycleRow} from './judgmentJobSqliteService.ts'
import {
  getJudgmentLifecycleTelemetry,
  getJudgmentPromptLifecycleTelemetryRecord,
  getRequestAttemptLifecycleTelemetryRecords,
  type JudgmentLifecycleTelemetry,
  type JudgmentLifecycleTelemetryRecord,
  mergeJudgmentLifecycleTelemetry,
} from './judgmentLifecycleTelemetry.ts'
import {
  type JudgmentRequestAttemptJsonEntry,
  parseRequestAttempts,
  stringifyRequestAttempts,
} from './judgmentRequestAttemptManifest.ts'
import {getJudgmentRequestLifecycleRecords, getJudgmentRequestStats} from './judgmentsRequestRuntime.ts'

export const judgmentDispatchTelemetryPath = '/api/admin/judgment-dispatch-runtime'

export type JudgmentDispatchTelemetryInput = ProviderQueueInput & {jobId: string}

export type JudgmentDispatchTelemetrySnapshot = {
  dispatch: JudgmentDispatchProviderStats
  lifecycle?: JudgmentLifecycleTelemetry
  request: {inFlight: number; pendingPersistedAttempts: number}
}

type JudgmentDispatchTelemetryOptions = {
  fetchWorkerTelemetry?: (
    record: DuckdbOwnerConnectionRecord,
    input: JudgmentDispatchTelemetryInput,
  ) => Promise<JudgmentDispatchTelemetrySnapshot | null>
  getJudgingWorkerRecords?: () => Promise<DuckdbOwnerConnectionRecord[]>
  getLocalTelemetry?: (input: JudgmentDispatchTelemetryInput) => Promise<JudgmentDispatchTelemetrySnapshot>
  shouldUseLocalTelemetryOnly?: () => boolean
}

const workerTelemetryTimeoutMs = 1_000

const getZeroDispatchStats = (): JudgmentDispatchProviderStats => {
  return {
    jobActivePromptCount: 0,
    jobQueuedPromptCount: 0,
    providerActiveLimit: 0,
    providerActivePromptCount: 0,
    providerQueueLimit: 0,
    providerQueuedPromptCount: 0,
  }
}

const getZeroTelemetrySnapshot = (): JudgmentDispatchTelemetrySnapshot => {
  return {dispatch: getZeroDispatchStats(), request: {inFlight: 0, pendingPersistedAttempts: 0}}
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null
}

const getNumberValue = (value: unknown): number | null => {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const getDispatchStatsFromRecord = (value: unknown): JudgmentDispatchProviderStats | null => {
  if (!isRecord(value)) {
    return null
  }

  const jobActivePromptCount = getNumberValue(value.jobActivePromptCount)
  const jobQueuedPromptCount = getNumberValue(value.jobQueuedPromptCount)
  const providerActiveLimit = getNumberValue(value.providerActiveLimit)
  const providerActivePromptCount = getNumberValue(value.providerActivePromptCount)
  const providerQueueLimit = getNumberValue(value.providerQueueLimit)
  const providerQueuedPromptCount = getNumberValue(value.providerQueuedPromptCount)

  return jobActivePromptCount === null
    || jobQueuedPromptCount === null
    || providerActiveLimit === null
    || providerActivePromptCount === null
    || providerQueueLimit === null
    || providerQueuedPromptCount === null
    ? null
    : {
        jobActivePromptCount,
        jobQueuedPromptCount,
        providerActiveLimit,
        providerActivePromptCount,
        providerQueueLimit,
        providerQueuedPromptCount,
      }
}

const getRequestStatsFromRecord = (value: unknown): JudgmentDispatchTelemetrySnapshot['request'] | null => {
  if (!isRecord(value)) {
    return null
  }

  const inFlight = getNumberValue(value.inFlight)
  const pendingPersistedAttempts = getNumberValue(value.pendingPersistedAttempts)

  return inFlight === null || pendingPersistedAttempts === null ? null : {inFlight, pendingPersistedAttempts}
}

const getStringValue = (value: unknown): string | null => {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

const getLifecycleRecordFromRecord = (value: unknown): JudgmentLifecycleTelemetryRecord | null => {
  if (!isRecord(value)) {
    return null
  }

  const jobId = getStringValue(value.jobId)
  const lifecycleKind =
    value.lifecycleKind === 'prompt' || value.lifecycleKind === 'requestAttempt' ? value.lifecycleKind : null
  const lifecycleState = getStringValue(value.lifecycleState)
  const providerKey = getStringValue(value.providerKey)

  return jobId && lifecycleKind && lifecycleState && providerKey
    ? {
        closeoutReason: getStringValue(value.closeoutReason),
        count: getNumberValue(value.count) ?? undefined,
        finishedAt: getStringValue(value.finishedAt),
        jobId,
        lifecycleKind,
        lifecycleState: lifecycleState as JudgmentLifecycleTelemetryRecord['lifecycleState'],
        promptId: getStringValue(value.promptId),
        providerKey,
        queueRecordId: getStringValue(value.queueRecordId),
        requestAttemptId: getStringValue(value.requestAttemptId),
        startedAt: getStringValue(value.startedAt),
        stateStartedAt: getStringValue(value.stateStartedAt),
        updatedAt: getStringValue(value.updatedAt),
      }
    : null
}

const getLifecycleTelemetryFromRecord = (value: unknown): JudgmentLifecycleTelemetry | undefined => {
  if (!isRecord(value) || !Array.isArray(value.records)) {
    return undefined
  }

  const records = value.records.flatMap((record) => {
    const lifecycleRecord = getLifecycleRecordFromRecord(record)

    return lifecycleRecord ? [lifecycleRecord] : []
  })

  return records.length === 0 ? undefined : getJudgmentLifecycleTelemetry({records})
}

const getTelemetrySnapshotFromRecord = (value: unknown): JudgmentDispatchTelemetrySnapshot | null => {
  if (!isRecord(value)) {
    return null
  }

  const dispatch = getDispatchStatsFromRecord(value.dispatch)
  const request = getRequestStatsFromRecord(value.request)
  const lifecycle = getLifecycleTelemetryFromRecord(value.lifecycle)

  return dispatch === null || request === null ? null : {dispatch, ...(lifecycle ? {lifecycle} : {}), request}
}

const getTelemetrySnapshotFromResponseBody = (value: unknown): JudgmentDispatchTelemetrySnapshot | null => {
  return isRecord(value) ? getTelemetrySnapshotFromRecord(value.data) : null
}

const readResponseJson = (response: Response): Promise<unknown> => {
  return response.json() as Promise<unknown>
}

const getWorkerTelemetryUrl = (record: DuckdbOwnerConnectionRecord, input: JudgmentDispatchTelemetryInput): string => {
  const url = new URL(
    `${judgmentDispatchTelemetryPath}/${encodeURIComponent(input.jobId)}`,
    `http://127.0.0.1:${record.listenPort}`,
  )

  if (input.providerConnectionId) {
    url.searchParams.set('providerConnectionId', input.providerConnectionId)
  }

  if (input.modelId) {
    url.searchParams.set('modelId', input.modelId)
  }

  if (input.modelProvider) {
    url.searchParams.set('modelProvider', input.modelProvider)
  }

  if (input.providerMaxInflightRequests !== null) {
    url.searchParams.set('providerMaxInflightRequests', String(input.providerMaxInflightRequests))
  }

  url.searchParams.set('providerUsesFamilyDefault', String(input.providerUsesFamilyDefault))

  return url.toString()
}

const fetchWorkerJudgmentDispatchTelemetry = async (
  record: DuckdbOwnerConnectionRecord,
  input: JudgmentDispatchTelemetryInput,
): Promise<JudgmentDispatchTelemetrySnapshot | null> => {
  const response = await fetch(getWorkerTelemetryUrl(record, input), {
    signal: AbortSignal.timeout(workerTelemetryTimeoutMs),
  }).catch(() => {
    return null
  })
  const body: unknown = response?.ok
    ? await readResponseJson(response).catch(() => {
        return null
      })
    : null

  return getTelemetrySnapshotFromResponseBody(body)
}

const getUniqueJudgingWorkerRecords = (records: DuckdbOwnerConnectionRecord[]): DuckdbOwnerConnectionRecord[] => {
  return records.reduce<DuckdbOwnerConnectionRecord[]>((uniqueRecords, record) => {
    const isDuplicate = uniqueRecords.some((uniqueRecord) => {
      return uniqueRecord.instanceId === record.instanceId
    })

    return isDuplicate ? uniqueRecords : [...uniqueRecords, record]
  }, [])
}

const getJudgingWorkerRecords = async (): Promise<DuckdbOwnerConnectionRecord[]> => {
  const overview = await getDuckdbOwnerConnectionsOverview()
  const records = [overview.owner, ...overview.followers].filter((record): record is DuckdbOwnerConnectionRecord => {
    return record !== null
  })
  const judgingRecords = records.filter((record) => {
    return record.capabilities.includes('judging') && !record.isCurrentProcess && !record.isStale
  })

  return getUniqueJudgingWorkerRecords(judgingRecords)
}

const getPromptToProcessFromJson = (value: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(value) as unknown

    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

const getProviderKeyForTelemetryInput = (input: JudgmentDispatchTelemetryInput): string => {
  return getJudgmentDispatchProviderKey(input)
}

const mergeQueueRequestAttempts = (
  rows: Array<JudgmentRequestAttemptJsonEntry[] | string | null | undefined>,
): string | null => {
  const attemptsById = rows
    .flatMap((row) => {
      return parseRequestAttempts(row)
    })
    .reduce((map, entry) => {
      return new Map(map).set(entry.requestAttemptId, entry)
    }, new Map<string, JudgmentRequestAttemptJsonEntry>())
  const requestAttempts = Array.from(attemptsById.values())

  return stringifyRequestAttempts(requestAttempts)
}

const getQueuePromptLifecycleRecords = ({
  providerKey,
  rows,
}: {
  providerKey: string
  rows: JudgmentJobQueuePromptLifecycleRow[]
}): JudgmentLifecycleTelemetryRecord[] => {
  return rows.flatMap((row) => {
    const requestAttempts = mergeQueueRequestAttempts([
      row.requestAttemptManifestJson,
      row.outboxRequestAttemptsJson,
      row.ackRequestAttemptsJson,
    ])
    const promptRecord = getJudgmentPromptLifecycleTelemetryRecord({
      createdAt: row.createdAt,
      jobId: row.jobId,
      judgedAt: row.judgedAt,
      noRequestSuccessReason: row.noRequestSuccessReason,
      promptId: row.promptId,
      promptCloseoutReason: row.promptCloseoutReason,
      promptTerminalState: row.promptTerminalState,
      providerKey,
      queueRecordId: row.queueRecordId,
      requestAttempts,
      sentAt: row.sentAt,
      status: row.status,
      terminalKind: row.terminalKind ?? row.skipReason,
      updatedAt: row.updatedAt,
    })
    const requestRecords = getRequestAttemptLifecycleTelemetryRecords({
      fallbackJobId: row.jobId,
      fallbackProviderKey: providerKey,
      requestAttempts,
    })

    return promptRecord ? [promptRecord, ...requestRecords] : requestRecords
  })
}

const getAcceptedClaimLifecycleRecords = ({
  fallbackProviderKey,
  jobId,
}: {
  fallbackProviderKey: string
  jobId: string
}): JudgmentLifecycleTelemetryRecord[] => {
  return getAcceptedJudgeWorkerClaimLifecycleRows(jobId).flatMap((row) => {
    const payload = getPromptToProcessFromJson(row.payloadJson)
    const providerKey = getStringValue(payload?.providerKey) ?? fallbackProviderKey
    const promptRecord = getJudgmentPromptLifecycleTelemetryRecord({
      acceptedAt: row.acceptedAt,
      createdAt: row.acceptedAt,
      isDispatchQueued: false,
      jobId: row.jobId,
      promptId: getStringValue(payload?.promptId),
      providerKey,
      queueRecordId: row.queueRecordId,
      requestAttempts: row.requestAttemptManifestJson,
      status: 'claimed',
      updatedAt: row.updatedAt,
    })
    const requestRecords = getRequestAttemptLifecycleTelemetryRecords({
      fallbackJobId: row.jobId,
      fallbackProviderKey: providerKey,
      requestAttempts: row.requestAttemptManifestJson,
    })

    return promptRecord ? [promptRecord, ...requestRecords] : requestRecords
  })
}

const getLocalLifecycleTelemetry = async (
  input: JudgmentDispatchTelemetryInput,
): Promise<JudgmentLifecycleTelemetry | undefined> => {
  const providerKey = getProviderKeyForTelemetryInput(input)
  const [dispatchRecords, queueRows] = await Promise.all([
    getJudgmentDispatchPromptLifecycleRecords(input),
    getJudgmentJobSqliteService().getQueuePromptLifecycleRows(input.jobId),
  ])
  const queueRecords = getQueuePromptLifecycleRecords({providerKey, rows: queueRows})
  const acceptedClaimRecords = shouldUseJudgeWorkerOwnerHandoff()
    ? getAcceptedClaimLifecycleRecords({fallbackProviderKey: providerKey, jobId: input.jobId})
    : []
  const requestRuntimeRecords = getJudgmentRequestLifecycleRecords(input.jobId)
  const records = [...queueRecords, ...acceptedClaimRecords, ...dispatchRecords, ...requestRuntimeRecords]

  return records.length === 0 ? undefined : getJudgmentLifecycleTelemetry({records})
}

export const getLocalJudgmentDispatchTelemetry = async (
  input: JudgmentDispatchTelemetryInput,
): Promise<JudgmentDispatchTelemetrySnapshot> => {
  const [dispatch, lifecycle] = await Promise.all([
    getJudgmentDispatchProviderStats(input),
    getLocalLifecycleTelemetry(input),
  ])
  const request = getJudgmentRequestStats(input.jobId)

  return {dispatch, ...(lifecycle ? {lifecycle} : {}), request}
}

const mergeJudgmentDispatchTelemetrySnapshots = (
  snapshots: JudgmentDispatchTelemetrySnapshot[],
): JudgmentDispatchTelemetrySnapshot => {
  const mergedSnapshot = snapshots.reduce<JudgmentDispatchTelemetrySnapshot>((merged, snapshot) => {
    return {
      dispatch: {
        jobActivePromptCount: merged.dispatch.jobActivePromptCount + snapshot.dispatch.jobActivePromptCount,
        jobQueuedPromptCount: merged.dispatch.jobQueuedPromptCount + snapshot.dispatch.jobQueuedPromptCount,
        providerActiveLimit: merged.dispatch.providerActiveLimit + snapshot.dispatch.providerActiveLimit,
        providerActivePromptCount:
          merged.dispatch.providerActivePromptCount + snapshot.dispatch.providerActivePromptCount,
        providerQueueLimit: merged.dispatch.providerQueueLimit + snapshot.dispatch.providerQueueLimit,
        providerQueuedPromptCount:
          merged.dispatch.providerQueuedPromptCount + snapshot.dispatch.providerQueuedPromptCount,
      },
      request: {
        inFlight: merged.request.inFlight + snapshot.request.inFlight,
        pendingPersistedAttempts: merged.request.pendingPersistedAttempts + snapshot.request.pendingPersistedAttempts,
      },
    }
  }, getZeroTelemetrySnapshot())
  const lifecycle = mergeJudgmentLifecycleTelemetry(
    snapshots.map((snapshot) => {
      return snapshot.lifecycle
    }),
  )

  return lifecycle ? {...mergedSnapshot, lifecycle} : mergedSnapshot
}

const getRemoteJudgmentDispatchTelemetry = async (
  input: JudgmentDispatchTelemetryInput,
  options: JudgmentDispatchTelemetryOptions,
): Promise<{snapshots: JudgmentDispatchTelemetrySnapshot[]; unavailableWorkerCount: number}> => {
  const getRecords = options.getJudgingWorkerRecords ?? getJudgingWorkerRecords
  const fetchTelemetry = options.fetchWorkerTelemetry ?? fetchWorkerJudgmentDispatchTelemetry
  const records = await getRecords()
  const telemetry = await Promise.all(
    records.map((record) => {
      return fetchTelemetry(record, input)
    }),
  )

  return {
    snapshots: telemetry.filter((snapshot): snapshot is JudgmentDispatchTelemetrySnapshot => {
      return snapshot !== null
    }),
    unavailableWorkerCount: telemetry.filter((snapshot) => {
      return snapshot === null
    }).length,
  }
}

const withUnavailableWorkerLifecycleTelemetry = ({
  input,
  snapshot,
  unavailableWorkerCount,
}: {
  input: JudgmentDispatchTelemetryInput
  snapshot: JudgmentDispatchTelemetrySnapshot
  unavailableWorkerCount: number
}): JudgmentDispatchTelemetrySnapshot => {
  if (unavailableWorkerCount === 0 || !snapshot.lifecycle) {
    return snapshot
  }

  const lifecycle = getJudgmentLifecycleTelemetry({
    records: [
      ...snapshot.lifecycle.records,
      {
        count: unavailableWorkerCount,
        jobId: input.jobId,
        lifecycleKind: 'prompt',
        lifecycleState: 'telemetryUnavailable',
        providerKey: getProviderKeyForTelemetryInput(input),
        stateStartedAt: new Date().toISOString(),
      },
    ],
  })

  return {...snapshot, lifecycle}
}

const withLocalLifecycleTelemetry = ({
  localTelemetry,
  snapshot,
}: {
  localTelemetry: JudgmentDispatchTelemetrySnapshot
  snapshot: JudgmentDispatchTelemetrySnapshot
}): JudgmentDispatchTelemetrySnapshot => {
  const lifecycle = mergeJudgmentLifecycleTelemetry([snapshot.lifecycle, localTelemetry.lifecycle])

  return lifecycle ? {...snapshot, lifecycle} : snapshot
}

export const getAggregatedJudgmentDispatchTelemetry = async (
  input: JudgmentDispatchTelemetryInput,
  options: JudgmentDispatchTelemetryOptions = {},
): Promise<JudgmentDispatchTelemetrySnapshot> => {
  const getLocalTelemetry = options.getLocalTelemetry ?? getLocalJudgmentDispatchTelemetry
  const shouldUseLocalOnly = options.shouldUseLocalTelemetryOnly ?? shouldCurrentServerRunJudgingLoops
  const localTelemetry = await getLocalTelemetry(input)

  if (shouldUseLocalOnly()) {
    return localTelemetry
  }

  const remoteTelemetry = await getRemoteJudgmentDispatchTelemetry(input, options)

  return remoteTelemetry.snapshots.length === 0
    ? withUnavailableWorkerLifecycleTelemetry({
        input,
        snapshot: localTelemetry,
        unavailableWorkerCount: remoteTelemetry.unavailableWorkerCount,
      })
    : withUnavailableWorkerLifecycleTelemetry({
        input,
        snapshot: withLocalLifecycleTelemetry({
          localTelemetry,
          snapshot: mergeJudgmentDispatchTelemetrySnapshots(remoteTelemetry.snapshots),
        }),
        unavailableWorkerCount: remoteTelemetry.unavailableWorkerCount,
      })
}
