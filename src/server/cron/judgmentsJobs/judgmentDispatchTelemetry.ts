import {
  type DuckdbOwnerConnectionRecord,
  getDuckdbOwnerConnectionsOverview,
} from '../../utils/duckdbOwnerConnections.ts'
import {shouldCurrentServerRunJudgingLoops} from '../../utils/serverRuntimeRole.ts'
import {
  getJudgmentDispatchProviderStats,
  type JudgmentDispatchProviderStats,
  type ProviderQueueInput,
} from './judgmentDispatchRuntime.ts'
import {getJudgmentRequestStats} from './judgmentsRequestRuntime.ts'

export const judgmentDispatchTelemetryPath = '/api/admin/judgment-dispatch-runtime'

export type JudgmentDispatchTelemetryInput = ProviderQueueInput & {jobId: string}

export type JudgmentDispatchTelemetrySnapshot = {
  dispatch: JudgmentDispatchProviderStats
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

const getTelemetrySnapshotFromRecord = (value: unknown): JudgmentDispatchTelemetrySnapshot | null => {
  if (!isRecord(value)) {
    return null
  }

  const dispatch = getDispatchStatsFromRecord(value.dispatch)
  const request = getRequestStatsFromRecord(value.request)

  return dispatch === null || request === null ? null : {dispatch, request}
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

export const getLocalJudgmentDispatchTelemetry = async (
  input: JudgmentDispatchTelemetryInput,
): Promise<JudgmentDispatchTelemetrySnapshot> => {
  const dispatch = await getJudgmentDispatchProviderStats(input)
  const request = getJudgmentRequestStats(input.jobId)

  return {dispatch, request}
}

const mergeJudgmentDispatchTelemetrySnapshots = (
  snapshots: JudgmentDispatchTelemetrySnapshot[],
): JudgmentDispatchTelemetrySnapshot => {
  return snapshots.reduce<JudgmentDispatchTelemetrySnapshot>((merged, snapshot) => {
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
}

const getRemoteJudgmentDispatchTelemetry = async (
  input: JudgmentDispatchTelemetryInput,
  options: JudgmentDispatchTelemetryOptions,
): Promise<JudgmentDispatchTelemetrySnapshot[]> => {
  const getRecords = options.getJudgingWorkerRecords ?? getJudgingWorkerRecords
  const fetchTelemetry = options.fetchWorkerTelemetry ?? fetchWorkerJudgmentDispatchTelemetry
  const records = await getRecords()
  const telemetry = await Promise.all(
    records.map((record) => {
      return fetchTelemetry(record, input)
    }),
  )

  return telemetry.filter((snapshot): snapshot is JudgmentDispatchTelemetrySnapshot => {
    return snapshot !== null
  })
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

  return remoteTelemetry.length === 0 ? localTelemetry : mergeJudgmentDispatchTelemetrySnapshots(remoteTelemetry)
}
