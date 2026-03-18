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

export type WriterConnectionsOverview = {
  followers: WriterConnectionRow[]
  history: WriterTakeoverHistoryRow[]
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

export const fetchWriterConnections = async (): Promise<WriterConnectionsOverview> => {
  const response = await apiClient.api.writer_connections.get()
  const responseData = response.data as
    | {
        data?: {
          followers?: Record<string, unknown>[]
          history?: Record<string, unknown>[]
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
  const writer = data?.writer ? normalizeWriterConnectionRow(data.writer) : null

  return {followers, history, writer}
}
