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

export type DuckdbOwnerConnectionsOverview = {
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

export const fetchDuckdbOwnerConnections = async (): Promise<DuckdbOwnerConnectionsOverview> => {
  const response = await apiClient.api.duckdb_owner_connections.get()
  const responseData = response.data as
    | {
        data?: {
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

  return {followers, history, owner, warnings}
}
