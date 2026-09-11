import {isValid, parseISO} from 'date-fns'

import {apiClient} from '../services/apiClient.ts'

export type DuckdbOwnerConnectionRow = {
  apiServerPort: number
  connectionId: string
  firstSeenAt: Date | null
  hostname: string
  instanceId: string
  isCurrentProcess: boolean
  isStale: boolean
  lastHeartbeatAt: Date | null
  lastProxyAt: Date | null
  lastRequestPath: string | null
  lastSeenAt: Date | null
  listenPort: number
  pid: number
  processStartedAt: Date | null
  proxyCount: number
  runtimeProfile: string
  serverRole: string
  service: string
  startedAt: Date | null
  duckdbOwnerUrl: string | null
}

export type DuckdbOwnerTakeoverHistoryRow = {
  apiServerPort: number
  at: Date | null
  duckdbOwnerUrl: string
  event: 'acquired' | 'released'
  hostname: string
  leaseId: string
  pid: number
  serverRole: string
}

export type DuckdbOwnerWarningRow = {
  at: Date | null
  kind: 'unresponsive-owner' | 'write-failure' | 'owner-proxy-disabled'
  message: string
  severity: 'warning' | 'error'
}

export type DuckdbOwnerCronRuntimeClassState = {
  active: boolean
  lastSuccessAt: Date | null
  lastTickAt: Date | null
  reason: string | null
  source: string
}

export type DuckdbOwnerCronRuntimeTickState = {
  lastFailureAt: Date | null
  lastFailureMessage: string | null
  lastSkippedAt: Date | null
  lastSuccessAt: Date | null
  lastTickAt: Date | null
  running: boolean
}

export type DuckdbOwnerCleanupStaleActivity = {
  budgetMs: number | null
  currentStep: string | null
  currentStepStartedAtMs: number | null
  exhaustedBudget: boolean
  isCleanupStaleRunning: boolean
  lastCompletedAtMs: number | null
  lastErrorMessage: string | null
  lastFinishedAtMs: number | null
  lastPartial: boolean
  lastPartialReason: string | null
  overBudget: boolean
  runId: string | null
  runningForMs: number | null
  shouldStartAnotherCleanupRun: boolean
  startedAtMs: number | null
  stale: boolean
}

export type DuckdbOwnerCronRuntimeOverview = {
  cleanupStaleActivity: DuckdbOwnerCleanupStaleActivity
  crons: Record<string, DuckdbOwnerCronRuntimeTickState>
  duckdbMemoryLimit: string | null
  duckdbMemoryLimitMiB: number | null
  heavyMaintenanceCrons: DuckdbOwnerCronRuntimeClassState
  importOnlyCrons: DuckdbOwnerCronRuntimeClassState
  judgingCrons: DuckdbOwnerCronRuntimeClassState
  lowMemoryOwner: boolean
  lowMemoryThresholdMiB: number | null
  mutationWorkEnabled: boolean
  operationalJudgmentCrons: DuckdbOwnerCronRuntimeClassState
  serverRole: string
}

export type DuckdbOwnerConnectionsOverview = {
  cronRuntime: DuckdbOwnerCronRuntimeOverview | null
  followers: DuckdbOwnerConnectionRow[]
  history: DuckdbOwnerTakeoverHistoryRow[]
  warnings: DuckdbOwnerWarningRow[]
  owner: DuckdbOwnerConnectionRow | null
}

export const duckdbOwnerConnectionsQueryKey = ['duckdb-owner-connections'] as const

const normalizeDuckdbOwnerConnectionDate = (value: unknown) => {
  const parsed = typeof value === 'string' ? parseISO(value) : null
  return parsed && isValid(parsed) ? parsed : null
}

const normalizeDuckdbOwnerConnectionRow = (row: Record<string, unknown>): DuckdbOwnerConnectionRow => {
  return {
    apiServerPort: typeof row.apiServerPort === 'number' ? row.apiServerPort : 0,
    connectionId: typeof row.connectionId === 'string' ? row.connectionId : '',
    firstSeenAt: normalizeDuckdbOwnerConnectionDate(row.firstSeenAt),
    hostname: typeof row.hostname === 'string' ? row.hostname : '',
    instanceId: typeof row.instanceId === 'string' ? row.instanceId : '',
    isCurrentProcess: row.isCurrentProcess === true,
    isStale: row.isStale === true,
    lastHeartbeatAt: normalizeDuckdbOwnerConnectionDate(row.lastHeartbeatAt),
    lastProxyAt: normalizeDuckdbOwnerConnectionDate(row.lastProxyAt),
    lastRequestPath: typeof row.lastRequestPath === 'string' ? row.lastRequestPath : null,
    lastSeenAt: normalizeDuckdbOwnerConnectionDate(row.lastSeenAt),
    listenPort: typeof row.listenPort === 'number' ? row.listenPort : 0,
    pid: typeof row.pid === 'number' ? row.pid : 0,
    processStartedAt: normalizeDuckdbOwnerConnectionDate(row.processStartedAt),
    proxyCount: typeof row.proxyCount === 'number' ? row.proxyCount : 0,
    runtimeProfile: typeof row.runtimeProfile === 'string' ? row.runtimeProfile : '',
    serverRole: typeof row.serverRole === 'string' ? row.serverRole : '',
    service: typeof row.service === 'string' ? row.service : '',
    startedAt: normalizeDuckdbOwnerConnectionDate(row.startedAt),
    duckdbOwnerUrl: typeof row.duckdbOwnerUrl === 'string' ? row.duckdbOwnerUrl : null,
  }
}

const normalizeDuckdbOwnerTakeoverHistoryRow = (row: Record<string, unknown>): DuckdbOwnerTakeoverHistoryRow => {
  return {
    apiServerPort: typeof row.apiServerPort === 'number' ? row.apiServerPort : 0,
    at: normalizeDuckdbOwnerConnectionDate(row.at),
    duckdbOwnerUrl: typeof row.duckdbOwnerUrl === 'string' ? row.duckdbOwnerUrl : '',
    event: row.event === 'released' ? 'released' : 'acquired',
    hostname: typeof row.hostname === 'string' ? row.hostname : '',
    leaseId: typeof row.leaseId === 'string' ? row.leaseId : '',
    pid: typeof row.pid === 'number' ? row.pid : 0,
    serverRole: typeof row.serverRole === 'string' ? row.serverRole : '',
  }
}

const normalizeDuckdbOwnerWarningRow = (row: Record<string, unknown>): DuckdbOwnerWarningRow => {
  return {
    at: normalizeDuckdbOwnerConnectionDate(row.at),
    kind:
      row.kind === 'write-failure'
        ? 'write-failure'
        : row.kind === 'owner-proxy-disabled'
          ? 'owner-proxy-disabled'
          : 'unresponsive-owner',
    message: typeof row.message === 'string' ? row.message : '',
    severity: row.severity === 'error' ? 'error' : 'warning',
  }
}

const normalizeDuckdbOwnerNumber = (value: unknown): number | null => {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN

  return Number.isFinite(parsed) ? parsed : null
}

const normalizeDuckdbOwnerCronRuntimeClassState = (value: unknown): DuckdbOwnerCronRuntimeClassState => {
  const row = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

  return {
    active: row.active === true,
    lastSuccessAt: normalizeDuckdbOwnerConnectionDate(row.lastSuccessAt),
    lastTickAt: normalizeDuckdbOwnerConnectionDate(row.lastTickAt),
    reason: typeof row.reason === 'string' ? row.reason : null,
    source: typeof row.source === 'string' ? row.source : 'derived',
  }
}

const normalizeDuckdbOwnerCronRuntimeTickState = (value: unknown): DuckdbOwnerCronRuntimeTickState => {
  const row = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

  return {
    lastFailureAt: normalizeDuckdbOwnerConnectionDate(row.lastFailureAt),
    lastFailureMessage: typeof row.lastFailureMessage === 'string' ? row.lastFailureMessage : null,
    lastSkippedAt: normalizeDuckdbOwnerConnectionDate(row.lastSkippedAt),
    lastSuccessAt: normalizeDuckdbOwnerConnectionDate(row.lastSuccessAt),
    lastTickAt: normalizeDuckdbOwnerConnectionDate(row.lastTickAt),
    running: row.running === true,
  }
}

const normalizeDuckdbOwnerCronRuntimeTicks = (value: unknown): Record<string, DuckdbOwnerCronRuntimeTickState> => {
  if (!value || typeof value !== 'object') {
    return {}
  }

  return Object.entries(value as Record<string, unknown>).reduce<Record<string, DuckdbOwnerCronRuntimeTickState>>(
    (ticks, [name, state]) => {
      ticks[name] = normalizeDuckdbOwnerCronRuntimeTickState(state)
      return ticks
    },
    {},
  )
}

const normalizeDuckdbOwnerCleanupStaleActivity = (value: unknown): DuckdbOwnerCleanupStaleActivity => {
  const row = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

  return {
    budgetMs: normalizeDuckdbOwnerNumber(row.budgetMs),
    currentStep: typeof row.currentStep === 'string' ? row.currentStep : null,
    currentStepStartedAtMs: normalizeDuckdbOwnerNumber(row.currentStepStartedAtMs),
    exhaustedBudget: row.exhaustedBudget === true,
    isCleanupStaleRunning: row.isCleanupStaleRunning === true,
    lastCompletedAtMs: normalizeDuckdbOwnerNumber(row.lastCompletedAtMs),
    lastErrorMessage: typeof row.lastErrorMessage === 'string' ? row.lastErrorMessage : null,
    lastFinishedAtMs: normalizeDuckdbOwnerNumber(row.lastFinishedAtMs),
    lastPartial: row.lastPartial === true,
    lastPartialReason: typeof row.lastPartialReason === 'string' ? row.lastPartialReason : null,
    overBudget: row.overBudget === true,
    runId: typeof row.runId === 'string' ? row.runId : null,
    runningForMs: normalizeDuckdbOwnerNumber(row.runningForMs),
    shouldStartAnotherCleanupRun: row.shouldStartAnotherCleanupRun === true,
    startedAtMs: normalizeDuckdbOwnerNumber(row.startedAtMs),
    stale: row.stale === true,
  }
}

const normalizeDuckdbOwnerCronRuntimeOverview = (value: unknown): DuckdbOwnerCronRuntimeOverview | null => {
  if (!value || typeof value !== 'object') {
    return null
  }

  const row = value as Record<string, unknown>

  return {
    cleanupStaleActivity: normalizeDuckdbOwnerCleanupStaleActivity(row.cleanupStaleActivity),
    crons: normalizeDuckdbOwnerCronRuntimeTicks(row.crons),
    duckdbMemoryLimit: typeof row.duckdbMemoryLimit === 'string' ? row.duckdbMemoryLimit : null,
    duckdbMemoryLimitMiB: normalizeDuckdbOwnerNumber(row.duckdbMemoryLimitMiB),
    heavyMaintenanceCrons: normalizeDuckdbOwnerCronRuntimeClassState(row.heavyMaintenanceCrons),
    importOnlyCrons: normalizeDuckdbOwnerCronRuntimeClassState(row.importOnlyCrons),
    judgingCrons: normalizeDuckdbOwnerCronRuntimeClassState(row.judgingCrons),
    lowMemoryOwner: row.lowMemoryOwner === true,
    lowMemoryThresholdMiB: normalizeDuckdbOwnerNumber(row.lowMemoryThresholdMiB),
    mutationWorkEnabled: row.mutationWorkEnabled === true,
    operationalJudgmentCrons: normalizeDuckdbOwnerCronRuntimeClassState(row.operationalJudgmentCrons),
    serverRole: typeof row.serverRole === 'string' ? row.serverRole : '',
  }
}

export const fetchDuckdbOwnerConnections = async (): Promise<DuckdbOwnerConnectionsOverview> => {
  const response = await apiClient.api.duckdb_owner_connections.get()
  const responseData = response.data as
    | {
        data?: {
          cronRuntime?: Record<string, unknown>
          followers?: Record<string, unknown>[]
          history?: Record<string, unknown>[]
          owner?: Record<string, unknown>
          warnings?: Record<string, unknown>[]
        }
      }
    | undefined

  if (response.error) {
    throw new Error('Failed to fetch DuckDB owner connections')
  }

  const data = responseData?.data
  const followers = Array.isArray(data?.followers) ? data.followers.map(normalizeDuckdbOwnerConnectionRow) : []
  const history = Array.isArray(data?.history) ? data.history.map(normalizeDuckdbOwnerTakeoverHistoryRow) : []
  const warnings = Array.isArray(data?.warnings) ? data.warnings.map(normalizeDuckdbOwnerWarningRow) : []
  const owner = data?.owner ? normalizeDuckdbOwnerConnectionRow(data.owner) : null
  const cronRuntime = normalizeDuckdbOwnerCronRuntimeOverview(data?.cronRuntime)

  return {cronRuntime, followers, history, owner, warnings}
}
