import {expect, mock, test} from 'bun:test'

import type {DuckdbOwnerConnectionRecord} from '../../utils/duckdbOwnerConnections.ts'
import {
  getAggregatedJudgmentDispatchTelemetry,
  type JudgmentDispatchTelemetryInput,
  type JudgmentDispatchTelemetrySnapshot,
} from './judgmentDispatchTelemetry.ts'
import {getJudgmentLifecycleTelemetry, type JudgmentLifecycleTelemetryRecord} from './judgmentLifecycleTelemetry.ts'

const input = {
  jobId: 'job-a',
  providerConnectionId: 'connection-a',
  providerMaxInflightRequests: 20,
  providerUsesFamilyDefault: false,
} satisfies JudgmentDispatchTelemetryInput

const now = '2026-04-27T00:00:00.000Z'

const createSnapshot = (
  overrides: {
    dispatch?: Partial<JudgmentDispatchTelemetrySnapshot['dispatch']>
    lifecycleRecords?: JudgmentLifecycleTelemetryRecord[]
    request?: Partial<JudgmentDispatchTelemetrySnapshot['request']>
  } = {},
): JudgmentDispatchTelemetrySnapshot => {
  const lifecycle = overrides.lifecycleRecords
    ? getJudgmentLifecycleTelemetry({now: new Date(now), records: overrides.lifecycleRecords})
    : undefined

  return {
    dispatch: {
      jobActivePromptCount: 0,
      jobQueuedPromptCount: 0,
      providerActiveLimit: 20,
      providerActivePromptCount: 0,
      providerQueueLimit: 20,
      providerQueuedPromptCount: 0,
      ...overrides.dispatch,
    },
    ...(lifecycle ? {lifecycle} : {}),
    request: {inFlight: 0, pendingPersistedAttempts: 0, ...overrides.request},
  }
}

const createJudgingRecord = (overrides: Partial<DuckdbOwnerConnectionRecord> = {}): DuckdbOwnerConnectionRecord => {
  return {
    apiServerPort: 3003,
    capabilities: ['judging'],
    connectionId: 'judge-worker-a',
    duckdbOwnerUrl: 'http://127.0.0.1:3002',
    firstSeenAt: now,
    hostname: 'localhost',
    instanceId: 'judge-worker-a',
    isCurrentProcess: false,
    isStale: false,
    lastHeartbeatAt: now,
    lastProxyAt: null,
    lastRequestPath: null,
    lastSeenAt: now,
    listenPort: 3003,
    memoryLimit: '20GB',
    pid: 1003,
    processStartedAt: now,
    proxyCount: 0,
    runtimeProfile: 'primary',
    runtimeVersion: 'split-runtime-v1',
    serverRole: 'judge-worker',
    service: 'judge-worker-server',
    startedAt: now,
    takeover: {
      candidate: false,
      intent: 'none',
      observedAt: now,
      ownerFreshness: 'owner_fresh',
      ownerHeartbeatAt: now,
      ownerLeaseId: 'lease-a',
      ownerUrl: 'http://127.0.0.1:3002',
    },
    throughputProfile: {
      batchSize: null,
      martRefreshDrainEligible: false,
      maxCyclesPerWake: null,
      pollIntervalMs: null,
      profile: 'non-maintenance',
    },
    ...overrides,
  }
}

test('aggregates fresh judge-worker telemetry when this process does not judge', async () => {
  const records = [createJudgingRecord(), createJudgingRecord({instanceId: 'judge-worker-b', listenPort: 3004})]
  const fetchWorkerTelemetry = mock(async (record: DuckdbOwnerConnectionRecord) => {
    return record.listenPort === 3003
      ? createSnapshot({
          dispatch: {
            jobActivePromptCount: 12,
            jobQueuedPromptCount: 4,
            providerActivePromptCount: 12,
            providerQueuedPromptCount: 4,
          },
          request: {inFlight: 15, pendingPersistedAttempts: 2},
        })
      : createSnapshot({
          dispatch: {
            jobActivePromptCount: 3,
            jobQueuedPromptCount: 1,
            providerActivePromptCount: 3,
            providerQueuedPromptCount: 1,
          },
          request: {inFlight: 4, pendingPersistedAttempts: 1},
        })
  })

  const telemetry = await getAggregatedJudgmentDispatchTelemetry(input, {
    fetchWorkerTelemetry,
    getJudgingWorkerRecords: async () => {
      return records
    },
    getLocalTelemetry: async () => {
      return createSnapshot({request: {inFlight: 0, pendingPersistedAttempts: 0}})
    },
    shouldUseLocalTelemetryOnly: () => {
      return false
    },
  })

  expect(telemetry).toEqual({
    dispatch: {
      jobActivePromptCount: 15,
      jobQueuedPromptCount: 5,
      providerActiveLimit: 40,
      providerActivePromptCount: 15,
      providerQueueLimit: 40,
      providerQueuedPromptCount: 5,
    },
    request: {inFlight: 19, pendingPersistedAttempts: 3},
  })
  expect(fetchWorkerTelemetry).toHaveBeenCalledTimes(2)
})

test('falls back to local telemetry when judge-worker telemetry is unavailable', async () => {
  const localTelemetry = createSnapshot({
    dispatch: {jobActivePromptCount: 0, providerActiveLimit: 20, providerQueueLimit: 20},
    request: {inFlight: 0, pendingPersistedAttempts: 0},
  })

  const telemetry = await getAggregatedJudgmentDispatchTelemetry(input, {
    fetchWorkerTelemetry: async () => {
      return null
    },
    getJudgingWorkerRecords: async () => {
      return [createJudgingRecord()]
    },
    getLocalTelemetry: async () => {
      return localTelemetry
    },
    shouldUseLocalTelemetryOnly: () => {
      return false
    },
  })

  expect(telemetry).toEqual(localTelemetry)
})

test('merges prompt and request-attempt lifecycle telemetry from fresh workers', async () => {
  const records = [createJudgingRecord(), createJudgingRecord({instanceId: 'judge-worker-b', listenPort: 3004})]
  const telemetry = await getAggregatedJudgmentDispatchTelemetry(input, {
    fetchWorkerTelemetry: async (record) => {
      return record.listenPort === 3003
        ? createSnapshot({
            lifecycleRecords: [
              {
                jobId: input.jobId,
                lifecycleKind: 'prompt',
                lifecycleState: 'dispatchQueued',
                providerKey: 'provider-a',
                queueRecordId: 'queue-a',
                stateStartedAt: now,
              },
              {
                jobId: input.jobId,
                lifecycleKind: 'requestAttempt',
                lifecycleState: 'liveRequest',
                providerKey: 'provider-a',
                requestAttemptId: 'attempt-a',
                stateStartedAt: now,
              },
            ],
          })
        : createSnapshot({
            lifecycleRecords: [
              {
                jobId: input.jobId,
                lifecycleKind: 'requestAttempt',
                lifecycleState: 'persistingCompletion',
                providerKey: 'provider-a',
                requestAttemptId: 'attempt-b',
                stateStartedAt: now,
              },
            ],
          })
    },
    getJudgingWorkerRecords: async () => {
      return records
    },
    getLocalTelemetry: async () => {
      return createSnapshot()
    },
    shouldUseLocalTelemetryOnly: () => {
      return false
    },
  })

  expect(
    telemetry.lifecycle?.summaries.map((summary) => {
      return [summary.lifecycleKind, summary.lifecycleState, summary.count]
    }),
  ).toEqual([
    ['prompt', 'dispatchQueued', 1],
    ['requestAttempt', 'liveRequest', 1],
    ['requestAttempt', 'persistingCompletion', 1],
  ])
  expect(
    telemetry.lifecycle?.attemptSummaries.map((summary) => {
      return [summary.requestAttemptId, summary.lifecycleState, summary.count]
    }),
  ).toEqual([
    ['attempt-a', 'liveRequest', 1],
    ['attempt-b', 'persistingCompletion', 1],
  ])
})

test('records unavailable worker telemetry as lifecycle diagnostics when local lifecycle truth exists', async () => {
  const telemetry = await getAggregatedJudgmentDispatchTelemetry(input, {
    fetchWorkerTelemetry: async () => {
      return null
    },
    getJudgingWorkerRecords: async () => {
      return [createJudgingRecord()]
    },
    getLocalTelemetry: async () => {
      return createSnapshot({
        lifecycleRecords: [
          {
            jobId: input.jobId,
            lifecycleKind: 'prompt',
            lifecycleState: 'claimed',
            providerKey: 'provider-a',
            queueRecordId: 'queue-a',
            stateStartedAt: now,
          },
        ],
      })
    },
    shouldUseLocalTelemetryOnly: () => {
      return false
    },
  })

  expect(
    telemetry.lifecycle?.summaries.map((summary) => {
      return [summary.lifecycleKind, summary.lifecycleState, summary.count]
    }),
  ).toEqual([
    ['prompt', 'claimed', 1],
    ['prompt', 'telemetryUnavailable', 1],
  ])
})

test('uses local telemetry without polling workers when this process judges', async () => {
  const fetchWorkerTelemetry = mock(async () => {
    return createSnapshot({request: {inFlight: 99, pendingPersistedAttempts: 99}})
  })
  const localTelemetry = createSnapshot({request: {inFlight: 7, pendingPersistedAttempts: 2}})

  const telemetry = await getAggregatedJudgmentDispatchTelemetry(input, {
    fetchWorkerTelemetry,
    getJudgingWorkerRecords: async () => {
      return [createJudgingRecord()]
    },
    getLocalTelemetry: async () => {
      return localTelemetry
    },
    shouldUseLocalTelemetryOnly: () => {
      return true
    },
  })

  expect(telemetry).toEqual(localTelemetry)
  expect(fetchWorkerTelemetry).not.toHaveBeenCalled()
})
