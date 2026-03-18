import {isValid, parseISO} from 'date-fns'

import {apiClient} from '../services/apiClient.ts'

export type WriterConnectionRow = {
  apiServerPort: number
  connectionId: string
  firstSeenAt: Date | null
  hostname: string
  isCurrentProcess: boolean
  isStale: boolean
  lastHeartbeatAt: Date | null
  lastProxyAt: Date | null
  lastRequestPath: string | null
  lastSeenAt: Date | null
  pid: number
  proxyCount: number
  serverRole: string
  startedAt: Date | null
  writerUrl: string | null
}

export type WriterTakeoverHistoryRow = {
  apiServerPort: number
  at: Date | null
  event: 'acquired' | 'released'
  hostname: string
  leaseId: string
  pid: number
  serverRole: string
  writerUrl: string
}

export type WriterWarningRow = {
  at: Date | null
  kind: 'unresponsive-writer' | 'write-failure' | 'writer-disabled'
  message: string
  severity: 'warning' | 'error'
}

export type WriterConnectionsOverview = {
  followers: WriterConnectionRow[]
  history: WriterTakeoverHistoryRow[]
  warnings: WriterWarningRow[]
  writer: WriterConnectionRow | null
}

export const writerConnectionsQueryKey = ['writer-connections'] as const

const normalizeWriterConnectionDate = (value: unknown) => {
  const parsed = typeof value === 'string' ? parseISO(value) : null
  return parsed && isValid(parsed) ? parsed : null
}

const normalizeWriterConnectionRow = (row: Record<string, unknown>): WriterConnectionRow => {
  return {
    apiServerPort: typeof row.apiServerPort === 'number' ? row.apiServerPort : 0,
    connectionId: typeof row.connectionId === 'string' ? row.connectionId : '',
    firstSeenAt: normalizeWriterConnectionDate(row.firstSeenAt),
    hostname: typeof row.hostname === 'string' ? row.hostname : '',
    isCurrentProcess: row.isCurrentProcess === true,
    isStale: row.isStale === true,
    lastHeartbeatAt: normalizeWriterConnectionDate(row.lastHeartbeatAt),
    lastProxyAt: normalizeWriterConnectionDate(row.lastProxyAt),
    lastRequestPath: typeof row.lastRequestPath === 'string' ? row.lastRequestPath : null,
    lastSeenAt: normalizeWriterConnectionDate(row.lastSeenAt),
    pid: typeof row.pid === 'number' ? row.pid : 0,
    proxyCount: typeof row.proxyCount === 'number' ? row.proxyCount : 0,
    serverRole: typeof row.serverRole === 'string' ? row.serverRole : '',
    startedAt: normalizeWriterConnectionDate(row.startedAt),
    writerUrl: typeof row.writerUrl === 'string' ? row.writerUrl : null,
  }
}

const normalizeWriterTakeoverHistoryRow = (row: Record<string, unknown>): WriterTakeoverHistoryRow => {
  return {
    apiServerPort: typeof row.apiServerPort === 'number' ? row.apiServerPort : 0,
    at: normalizeWriterConnectionDate(row.at),
    event: row.event === 'released' ? 'released' : 'acquired',
    hostname: typeof row.hostname === 'string' ? row.hostname : '',
    leaseId: typeof row.leaseId === 'string' ? row.leaseId : '',
    pid: typeof row.pid === 'number' ? row.pid : 0,
    serverRole: typeof row.serverRole === 'string' ? row.serverRole : '',
    writerUrl: typeof row.writerUrl === 'string' ? row.writerUrl : '',
  }
}

const normalizeWriterWarningRow = (row: Record<string, unknown>): WriterWarningRow => {
  return {
    at: normalizeWriterConnectionDate(row.at),
    kind:
      row.kind === 'write-failure'
        ? 'write-failure'
        : row.kind === 'writer-disabled'
          ? 'writer-disabled'
          : 'unresponsive-writer',
    message: typeof row.message === 'string' ? row.message : '',
    severity: row.severity === 'error' ? 'error' : 'warning',
  }
}

export const fetchWriterConnections = async (): Promise<WriterConnectionsOverview> => {
  const response = await apiClient.api.writer_connections.get()
  const responseData = response.data as
    | {
        data?: {
          followers?: Record<string, unknown>[]
          history?: Record<string, unknown>[]
          warnings?: Record<string, unknown>[]
          writer?: Record<string, unknown>
        }
      }
    | undefined

  if (response.error) {
    throw new Error('Failed to fetch writer connections')
  }

  const data = responseData?.data
  const followers = Array.isArray(data?.followers) ? data.followers.map(normalizeWriterConnectionRow) : []
  const history = Array.isArray(data?.history) ? data.history.map(normalizeWriterTakeoverHistoryRow) : []
  const warnings = Array.isArray(data?.warnings) ? data.warnings.map(normalizeWriterWarningRow) : []
  const writer = data?.writer ? normalizeWriterConnectionRow(data.writer) : null

  return {followers, history, warnings, writer}
}
