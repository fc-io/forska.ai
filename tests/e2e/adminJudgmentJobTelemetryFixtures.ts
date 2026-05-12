import type {Page} from '@playwright/test'

type TelemetryScenario =
  | 'claiming'
  | 'completionPersistence'
  | 'endpointUnavailable'
  | 'providerAtTarget'
  | 'providerSaturated'
type TelemetryHistoryRange = '5m' | '15m' | '1h' | '24h' | '3d'
type TelemetryHistoryBucketData = {
  adherenceState: 'atLimit' | 'overLimit' | 'unknown' | 'withinLimit'
  avgUtilization: number | null
  bottleneck: string | null
  bottleneckSampleCount?: number
  bottleneckSource: string | null
  bottleneckSubreason: string | null
  indexFromEnd: number
  maxUtilization: number | null
  minUtilization: number | null
  sampleCount: number
}
type TelemetryHistory = ReturnType<typeof buildTelemetryHistory>

type MockJob = ReturnType<typeof buildTelemetryJob>

const telemetryProjectId = 'project-telemetry'
const telemetryModelId = 'model-telemetry'
const telemetryProviderId = 'provider-telemetry'
const endpointAvailabilityKey = `${telemetryProviderId}::https://runtime-paused.example.com`
const mockRuntime = {
  activeModelNames: ['telemetry-model'],
  providerKind: 'sglang',
  sourceMetadata: null,
  workerUrls: [],
}
const telemetryHistoryRangePresets: Record<TelemetryHistoryRange, {bucketSizeSeconds: number; bucketCount: number}> = {
  '5m': {bucketCount: 10, bucketSizeSeconds: 30},
  '15m': {bucketCount: 30, bucketSizeSeconds: 30},
  '1h': {bucketCount: 60, bucketSizeSeconds: 60},
  '24h': {bucketCount: 96, bucketSizeSeconds: 15 * 60},
  '3d': {bucketCount: 72, bucketSizeSeconds: 60 * 60},
}
const telemetryHistoryRangeEnd = new Date('2026-05-04T12:00:00.000Z')
const defaultTelemetryHistoryBuckets: TelemetryHistoryBucketData[] = [
  {
    adherenceState: 'withinLimit',
    avgUtilization: 25,
    bottleneck: 'claiming',
    bottleneckSource: 'convergenceDiagnostics.readyCount',
    bottleneckSubreason: 'promptClaimBacklog',
    indexFromEnd: 4,
    maxUtilization: 31,
    minUtilization: 12,
    sampleCount: 2,
  },
  {
    adherenceState: 'withinLimit',
    avgUtilization: 37.5,
    bottleneck: 'claiming',
    bottleneckSource: 'convergenceDiagnostics.readyCount',
    bottleneckSubreason: 'promptClaimBacklog',
    indexFromEnd: 3,
    maxUtilization: 50,
    minUtilization: 25,
    sampleCount: 2,
  },
  {
    adherenceState: 'atLimit',
    avgUtilization: 100,
    bottleneck: 'providerAtTarget',
    bottleneckSource: 'provider.providerLeasedLiveRequests',
    bottleneckSubreason: 'providerTargetReached',
    indexFromEnd: 2,
    maxUtilization: 100,
    minUtilization: 87.5,
    sampleCount: 2,
  },
  {
    adherenceState: 'overLimit',
    avgUtilization: 112.5,
    bottleneck: 'providerSaturated',
    bottleneckSource: 'provider.providerLeasedPhysicalCalls',
    bottleneckSubreason: 'providerPhysicalCap',
    indexFromEnd: 1,
    maxUtilization: 125,
    minUtilization: 100,
    sampleCount: 2,
  },
]

const baseEndpointDiagnostics = {
  cooldownRemainingMs: null,
  endpointAvailabilityKey,
  endpointIdentity: 'https://runtime-paused.example.com',
  effectiveBaseURL: 'https://runtime-paused.example.com/v1',
  lastFailureKind: null,
  lastFailureMessage: null,
  localProbeCooldownUntil: null,
  localProbeLiveCount: 0,
  localProbeState: 'healthy',
  observedAggregateProbeLiveCount: null,
  probeInProgress: false,
}

const baseTelemetrySource = {
  aggregateCompleteness: 'partial',
  endpointCoverage: [
    {
      aggregateCompleteness: 'partial',
      endpointAvailabilityKey,
      freshWorkerCount: 1,
      staleWorkerCount: 1,
      unavailableWorkerCount: 1,
    },
  ],
  freshWorkerCount: 1,
  localWorkerId: 'playwright-worker-a',
  observedAggregatesAreBestEffort: true,
  providerCoverage: [
    {
      aggregateCompleteness: 'partial',
      freshWorkerCount: 1,
      providerKey: telemetryProviderId,
      staleWorkerCount: 1,
      unavailableWorkerCount: 1,
    },
  ],
  staleWorkerCount: 1,
  telemetryUnavailable: false,
  unavailableWorkerCount: 1,
} as const

const isTelemetryHistoryRange = (value: string | null): value is TelemetryHistoryRange => {
  return value === '5m' || value === '15m' || value === '1h' || value === '24h' || value === '3d'
}

const getTelemetryHistoryBucketData = (
  bucketCount: number,
  index: number,
  sampledBuckets: TelemetryHistoryBucketData[],
): TelemetryHistoryBucketData | null => {
  return (
    sampledBuckets.find((bucket) => {
      return bucketCount - bucket.indexFromEnd === index
    }) ?? null
  )
}

const getTelemetryHistoryBucket = (params: {
  bucketSizeSeconds: number
  bucketStart: Date
  data: TelemetryHistoryBucketData | null
}) => {
  const bucketEnd = new Date(params.bucketStart.getTime() + params.bucketSizeSeconds * 1000)
  const bottleneckSampleCount =
    params.data?.bottleneckSampleCount ?? (params.data?.bottleneck ? params.data.sampleCount : 0)

  return {
    adherenceState: params.data?.adherenceState ?? 'unknown',
    avgUtilization: params.data?.avgUtilization ?? null,
    bottleneck: params.data?.bottleneck ?? null,
    bottleneckSampleCount,
    bottleneckSource: params.data?.bottleneckSource ?? null,
    bottleneckSubreason: params.data?.bottleneckSubreason ?? null,
    bucketEnd: bucketEnd.toISOString(),
    bucketStart: params.bucketStart.toISOString(),
    maxUtilization: params.data?.maxUtilization ?? null,
    minUtilization: params.data?.minUtilization ?? null,
    sampleCount: params.data?.sampleCount ?? 0,
  }
}

export const buildTelemetryHistory = ({
  providerKey = telemetryProviderId,
  range,
  sampledBuckets = defaultTelemetryHistoryBuckets,
}: {
  providerKey?: string
  range: TelemetryHistoryRange
  sampledBuckets?: TelemetryHistoryBucketData[]
}) => {
  const preset = telemetryHistoryRangePresets[range]
  const bucketSizeMs = preset.bucketSizeSeconds * 1000
  const rangeStart = new Date(telemetryHistoryRangeEnd.getTime() - preset.bucketCount * bucketSizeMs)
  const buckets = Array.from({length: preset.bucketCount}, (_, index) => {
    return getTelemetryHistoryBucket({
      bucketSizeSeconds: preset.bucketSizeSeconds,
      bucketStart: new Date(rangeStart.getTime() + index * bucketSizeMs),
      data: getTelemetryHistoryBucketData(preset.bucketCount, index, sampledBuckets),
    })
  })

  return {
    bucketSizeSeconds: preset.bucketSizeSeconds,
    buckets,
    providerKey,
    rangeEnd: telemetryHistoryRangeEnd.toISOString(),
    rangeStart: rangeStart.toISOString(),
  }
}

export const buildEmptyTelemetryHistory = (range: TelemetryHistoryRange, providerKey = telemetryProviderId) => {
  return buildTelemetryHistory({providerKey, range, sampledBuckets: []})
}

const getEndpointDiagnostics = (scenario: TelemetryScenario) => {
  return scenario === 'endpointUnavailable'
    ? {
        ...baseEndpointDiagnostics,
        cooldownRemainingMs: 30_000,
        lastFailureKind: 'endpoint_unavailable',
        lastFailureMessage: 'Provider endpoint outage: runtime returned 503',
        localProbeCooldownUntil: '2026-05-04T12:01:00.000Z',
        localProbeState: 'cooldown',
      }
    : baseEndpointDiagnostics
}

const getBottleneck = (scenario: TelemetryScenario) => {
  switch (scenario) {
    case 'completionPersistence':
      return {
        bottleneck: 'completionPersistence',
        bottleneckSource: 'lifecycle:requestAttempt:persistingCompletion',
        bottleneckSubreason: 'ownerAck',
      }
    case 'endpointUnavailable':
      return {
        bottleneck: 'endpointUnavailable',
        bottleneckSource: `endpoint:${endpointAvailabilityKey}`,
        bottleneckSubreason: 'endpointCooldown',
      }
    case 'providerAtTarget':
      return {
        bottleneck: 'providerAtTarget',
        bottleneckSource: 'provider.providerLeasedLiveRequests',
        bottleneckSubreason: 'providerTargetReached',
      }
    case 'providerSaturated':
      return {
        bottleneck: 'providerSaturated',
        bottleneckSource: 'provider.providerLeasedPhysicalCalls',
        bottleneckSubreason: 'providerPhysicalCap',
      }
    default:
      return {
        bottleneck: 'claiming',
        bottleneckSource: 'convergenceDiagnostics.readyCount',
        bottleneckSubreason: 'promptClaimBacklog',
      }
  }
}

const getProviderCapacity = (scenario: TelemetryScenario) => {
  return scenario === 'providerAtTarget'
    ? {leasedLive: 4, leasedPhysical: 4, leasedProbe: 0, target: 4}
    : scenario === 'providerSaturated'
      ? {leasedLive: 7, leasedPhysical: 8, leasedProbe: 1, target: 8}
      : {leasedLive: 1, leasedPhysical: 1, leasedProbe: 0, target: 4}
}

const buildProviderTelemetry = (scenario: TelemetryScenario) => {
  const bottleneck = getBottleneck(scenario)
  const endpointDiagnostics = getEndpointDiagnostics(scenario)
  const capacity = getProviderCapacity(scenario)
  const hasHealthyEndpointOrEndpointlessPath = scenario !== 'endpointUnavailable'
  const normalRequestCapacity = 8
  const providerLimit = 8
  const providerRequestFillPct = Math.round((capacity.leasedLive / normalRequestCapacity) * 100)

  return {
    allocationCompleteCurrent: true,
    allocationInputState: 'complete',
    bottleneck: bottleneck.bottleneck,
    bottleneckSource: bottleneck.bottleneckSource,
    bottleneckSubreason: bottleneck.bottleneckSubreason,
    convergenceDiagnostics: {
      activeHigherPriorityStopRules: [],
      allocationCompleteCurrent: true,
      allocationInputState: 'complete',
      backlogReplenishmentAllowed: scenario !== 'endpointUnavailable',
      hasHealthyEndpointOrEndpointlessPath,
      normalRequestCapacityPositive: true,
      preconditionChangedReason: null,
      preconditionsStableSinceMs: 45_000,
      providerAcceptingRequests: scenario !== 'endpointUnavailable',
      providerLimitPositive: true,
      readyCount: scenario === 'completionPersistence' ? 0 : 12,
      targetIncreaseAllowed: scenario !== 'endpointUnavailable',
    },
    effectiveProviderLimit: 4,
    endpointDiagnostics: [endpointDiagnostics],
    endpointDiagnosticsByKey: {[endpointAvailabilityKey]: endpointDiagnostics},
    endpointDiagnosticsSummary: {
      blockedEndpointCount: scenario === 'endpointUnavailable' ? 1 : 0,
      cooldownEndpointCount: scenario === 'endpointUnavailable' ? 1 : 0,
      endpointCount: 1,
      hasHealthyEndpointOrEndpointlessPath,
      healthyEndpointCount: scenario === 'endpointUnavailable' ? 0 : 1,
      localProbeLiveCount: 0,
      misconfiguredEndpointCount: 0,
      observedAggregateProbeLiveCount: null,
      probeInProgress: false,
      providerKey: telemetryProviderId,
      probingEndpointCount: 0,
      unhealthyEndpointCount: scenario === 'endpointUnavailable' ? 1 : 0,
    },
    expectedLocalLiveShare: 4,
    leaseAuthority: {
      normalRequestCapacity,
      probeOccupancySampledAtMs: 1_777_896_000_000,
      providerAllocationVersion: 'allocation-v1',
      providerAvailableRequestLeases: Math.max(0, normalRequestCapacity - capacity.leasedLive),
      providerKey: telemetryProviderId,
      providerLeasedLiveRequests: capacity.leasedLive,
      providerLeasedPhysicalCalls: capacity.leasedPhysical,
      providerLeasedProbeCalls: capacity.leasedProbe,
      providerLimit,
      providerLimitVersion: 'limit-v1',
      providerProbeOccupancyVersion: 'probe-v1',
      providerRequestFillPct,
      targetRequestLiveCalls: capacity.target,
    },
    localAdditionalLeaseHeadroom: Math.max(0, normalRequestCapacity - capacity.leasedLive),
    localAdditionalTargetHeadroom: Math.max(0, capacity.target - capacity.leasedLive),
    localPromptBacklog: scenario === 'claiming' ? 1 : 4,
    localPromptBacklogTarget: 6,
    localProviderLiveRequests: scenario === 'completionPersistence' ? 0 : Math.min(capacity.leasedLive, 4),
    localProviderRequestFillPct: scenario === 'completionPersistence' ? 0 : 50,
    localRequestWorkBacklog: scenario === 'claiming' ? 1 : 4,
    localRequestWorkBacklogTarget: 4,
    normalRequestCapacity,
    observedAggregateLabel: 'bestEffort',
    observedBestEffort: {
      effectiveProviderLimit: 5,
      label: 'bestEffort',
      promptBacklog: 5,
      providerLiveRequests: 3,
      providerRequestFillPct: 60,
      requestWorkBacklog: 4,
    },
    observedGlobalEffectiveProviderLimit: 5,
    observedGlobalPromptBacklog: 5,
    observedGlobalProviderLiveRequests: 3,
    observedGlobalProviderRequestFillPct: 60,
    observedGlobalRequestWorkBacklog: 4,
    probeOccupancySampledAtMs: 1_777_896_000_000,
    providerAllocationVersion: 'allocation-v1',
    providerAvailableRequestLeases: Math.max(0, normalRequestCapacity - capacity.leasedLive),
    providerKey: telemetryProviderId,
    providerLeasedLiveRequests: capacity.leasedLive,
    providerLeasedPhysicalCalls: capacity.leasedPhysical,
    providerLeasedProbeCalls: capacity.leasedProbe,
    providerLimit,
    providerLimitVersion: 'limit-v1',
    providerProbeOccupancyVersion: 'probe-v1',
    providerRequestFillPct,
    targetRequestLiveCalls: capacity.target,
    unallocatedTargetLiveCalls: 0,
  }
}

export const buildTelemetryJob = (scenario: TelemetryScenario) => {
  const providerTelemetry = buildProviderTelemetry(scenario)

  return {
    id: `telemetry-${scenario}`,
    createdAt: '2026-05-04T12:00:00.000Z',
    error: [],
    health: {badges: ['Healthy']},
    importFailureCount: 0,
    judgingRuntime: {enabled: true, reason: null},
    lastImportCompletedAt: null,
    lastImportError: null,
    lastImportErrorAt: null,
    lastImportExitCode: null,
    lastImportStartedAt: null,
    pauseRequestedAt: null,
    projectId: telemetryProjectId,
    projectName: 'Telemetry Project',
    promptStats: {claimed: 1, judged: 2, ready: 12, running: 1, skipped: 0},
    quarantineReason: null,
    quarantinedAt: null,
    requestStats: {
      attempts: 3,
      dispatch: {
        jobActivePrompts: 1,
        jobQueuedPrompts: 1,
        providerDispatchActivePromptFillPct: 25,
        providerDispatchActivePromptLimit: 4,
        providerDispatchActivePrompts: 1,
        providerDispatchPrefetchFillPct: 33,
        providerDispatchQueueLimit: 6,
        providerDispatchQueuedPrompts: 2,
      },
      endpointAvailability: providerTelemetry.endpointDiagnostics[0],
      failures: {anthropicRefusalArticles: 0, anthropicRefusals: 0, persistedFailedRequests: 0},
      inFlight: providerTelemetry.localProviderLiveRequests,
      lifecycleCounters: {
        claimedPrompts: 1,
        liveLlmCalls: providerTelemetry.localProviderLiveRequests,
        providerKey: telemetryProviderId,
        runningPrompts: 1,
        workerActivePrompts: 1,
        workerQueuedPrompts: 1,
      },
      liveLlmCalls: providerTelemetry.localProviderLiveRequests,
      providerTelemetry,
      requestSlotWaiters: {codex: 0, fallback: 0, providerAdmission: scenario === 'claiming' ? 1 : 0, worker: 0},
      requestWorkBacklog: providerTelemetry.localRequestWorkBacklog,
      telemetrySource: baseTelemetrySource,
      waitingForRequestSlot: scenario === 'claiming' ? 1 : 0,
    },
    status: 'running',
    storageHealth: {
      claimedOutboxCount: 0,
      hasOutboxRows: false,
      hasPendingCompletionAck: scenario === 'completionPersistence',
      hasQueueRows: true,
      lastAckSeq: null,
      oldestUnackedCompletionAgeMs: scenario === 'completionPersistence' ? 20_000 : null,
      oldestUnexportedAgeMs: null,
      orphanedJudgedRowCount: 0,
      outboxRowCount: scenario === 'completionPersistence' ? 1 : 0,
      pendingCompletionAckCount: scenario === 'completionPersistence' ? 1 : 0,
      promptCounts: {claimed: 1, judged: 2, ready: 12, running: 1, skipped: 0},
      retainedRowCount: 0,
      sqliteFileBytes: null,
      walBytes: 0,
    },
    storagePolicy: {hasLocalSqliteState: true, repairMode: 'none', startupHandling: 'idle'},
    storageState: 'active',
    totalTokenUsage: {totalCompletionTokens: 20, totalPromptTokens: 40, totalTokens: 60},
    updatedAt: '2026-05-04T12:00:30.000Z',
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  }
}

const mockProviderConnection = {
  authMode: 'none',
  baseURL: 'https://runtime-paused.example.com/v1',
  config: {manualWorkerUrls: [], workerUrlMode: 'manual'},
  createdAt: '2026-05-04T12:00:00.000Z',
  effectiveMaxInflightRequests: 8,
  enabled: true,
  hasSecret: false,
  id: telemetryProviderId,
  label: 'Telemetry Provider',
  lastCheckedAt: null,
  lastError: null,
  maxInflightRequests: 8,
  models: [
    {
      baseURL: 'https://runtime-paused.example.com/v1',
      createdAt: '2026-05-04T12:00:00.000Z',
      displayName: 'Telemetry Model',
      enabled: true,
      id: telemetryModelId,
      metadataJson: {},
      modelName: 'telemetry-model',
      name: 'telemetry-model',
      provider: 'sglang',
      providerConnectionId: telemetryProviderId,
      remoteModelId: 'telemetry-model',
      source: 'manual',
      updatedAt: '2026-05-04T12:00:00.000Z',
      variant: null,
      version: null,
    },
  ],
  providerKind: 'sglang',
  updatedAt: '2026-05-04T12:00:00.000Z',
  workerState: {
    effectiveWorkerUrls: [],
    match: {
      candidate: null,
      detectedModelNames: [],
      effectiveBaseURL: 'https://runtime-paused.example.com/v1',
      effectiveWorkerUrls: [],
      localUrls: [],
      modelNames: [],
      reason: 'manual',
      reasons: ['manual'],
      remoteUrls: [],
      resolutionMode: 'direct',
      source: 'manual',
      sourceMetadata: null,
      status: 'matched',
    },
    resolutionMode: 'direct',
    runtimeWorkerUrls: [],
    workerSource: 'manual',
  },
}

const mockProject = {id: telemetryProjectId, model: {id: telemetryModelId}, name: 'Telemetry Project', prompts: []}

const mockProjectListItem = {
  archived: false,
  createdAt: '2026-05-04T12:00:00.000Z',
  dateFrom: null,
  dateTo: null,
  description: null,
  humanJudgmentMode: null,
  id: telemetryProjectId,
  modelId: telemetryModelId,
  modelName: 'telemetry-model',
  modelProvider: 'sglang',
  modelVersion: null,
  name: 'Telemetry Project',
  updatedAt: '2026-05-04T12:00:00.000Z',
  useAbstract: true,
  useFulltext: false,
  useFulltextNoImages: false,
  useTitle: true,
}

type AdminTelemetryMocksOptions = {
  historyByRange?: Partial<Record<TelemetryHistoryRange, TelemetryHistory>>
  jobs?: MockJob[]
  preflightNotice?: string
  providerRuntime?: typeof mockRuntime
  startCleanError?: string
}

const repairResponse = (job: MockJob, message: string) => {
  return {
    action: 'preflight',
    changes: {
      checkpointed: false,
      deletedOrphanedJudgedRows: 0,
      finalizedDrain: false,
      importedOutboxRows: 0,
      initializedSqlite: false,
      prunedOutboxRows: 0,
      prunedQueueRows: 0,
      quarantined: false,
      reapedOutboxClaims: 0,
      requeuedOrphanedJudgedRows: 0,
      requeuedSentPrompts: 0,
      unquarantined: false,
    },
    job,
    jobId: job.id,
    liveSqlite: {
      claimedOutboxCount: 0,
      lastAckSeq: null,
      oldestUnexportedAgeMs: null,
      orphanedJudgedRowCount: 0,
      outboxRowCount: 0,
      promptCounts: job.promptStats,
      retainedRowCount: 0,
      sqliteFileBytes: null,
      walBytes: 0,
    },
    message,
    ok: true,
    preflight: {ok: true},
    requestedBy: 'playwright',
    systemSqliteFallback: {requestedSteps: [], results: []},
  }
}

export const installAdminTelemetryMocks = async (
  page: Page,
  job: MockJob,
  options: AdminTelemetryMocksOptions = {},
): Promise<void> => {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())

    if (url.pathname === '/api/judgmentsjobs') {
      await route.fulfill({json: {data: options.jobs ?? [job], error: null}})
      return
    }

    if (url.pathname === `/api/judgmentsjobs/${job.id}`) {
      await route.fulfill({json: job})
      return
    }

    if (url.pathname === `/api/judgmentsjobs/${job.id}/start-clean`) {
      await route.fulfill({
        json: options.startCleanError
          ? {data: null, error: options.startCleanError}
          : {data: {started: true}, error: null},
      })
      return
    }

    if (url.pathname === `/api/judgmentsjobs/${job.id}/preflight`) {
      await route.fulfill({
        json: {data: repairResponse(job, options.preflightNotice ?? 'Preflight completed.'), error: null},
      })
      return
    }

    if (url.pathname === '/api/judgmentsjobs-unassessed-count') {
      await route.fulfill({json: {count: 0}})
      return
    }

    if (url.pathname === '/api/judgmentsjobs-provider-telemetry-history') {
      const requestedRange = url.searchParams.get('range')
      const range = isTelemetryHistoryRange(requestedRange) ? requestedRange : '15m'
      const providerKey =
        url.searchParams.get('providerKey')?.trim() || job.requestStats.providerTelemetry.providerKey || telemetryProviderId

      await route.fulfill({
        json: options.historyByRange?.[range] ?? buildTelemetryHistory({providerKey, range}),
      })
      return
    }

    if (url.pathname === '/api/judgmentsjobs-total-token-usage') {
      await route.fulfill({
        json: {data: {totalCompletionTokens: 20, totalPromptTokens: 40, totalTokens: 60}, error: null},
      })
      return
    }

    if (url.pathname === `/api/projects/${telemetryProjectId}`) {
      await route.fulfill({json: {data: mockProject, error: null}})
      return
    }

    if (url.pathname === '/api/projects') {
      await route.fulfill({json: {data: [mockProjectListItem], error: null}})
      return
    }

    if (url.pathname === '/api/provider-connections') {
      await route.fulfill({
        json: {
          data: {catalog: [], connections: [mockProviderConnection], runtime: options.providerRuntime ?? mockRuntime},
          error: null,
        },
      })
      return
    }

    if (url.pathname === '/api/tokens/timelineAllJobsStats') {
      await route.fulfill({json: {highestUsage: null, p90Usage: null, success: true}})
      return
    }

    if (url.pathname === '/api/tokens/timelineAllJobs') {
      await route.fulfill({json: {data: [], success: true}})
      return
    }

    if (url.pathname === '/api/tokens/timelineStats') {
      await route.fulfill({json: {highestUsage: null, p90Usage: null, success: true}})
      return
    }

    if (url.pathname === '/api/tokens/timeline') {
      await route.fulfill({json: {data: [], success: true}})
      return
    }

    await route.fulfill({json: {data: null, error: null}})
  })
}
