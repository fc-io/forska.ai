import {hostname} from 'node:os'

import {Effect} from 'effect'

import {type DuckdbOwnerLeaseHistoryEntry, readDuckdbOwnerLeaseHistory} from './duckdbOwnerLease.ts'
import {env} from './env.ts'
import type {ServerRole} from './serverRole.ts'
import {getCurrentServerRole, getKnownWriterUrl} from './serverRuntimeRole.ts'
import {getWriterWarnings, type WriterWarning} from './writerWarnings.ts'

const writerConnectionHeartbeatWindowMs = 45_000
const writerConnectionRetentionMs = 10 * 60_000
const writerConnectionHeaderNames = {
  apiServerPort: 'x-forska-api-server-port',
  hostname: 'x-forska-hostname',
  pid: 'x-forska-pid',
  serverRole: 'x-forska-server-role',
  startedAt: 'x-forska-started-at',
  writerUrl: 'x-forska-writer-url',
} as const

type WriterConnectionState = {
  processStartedAt: string
  recordsByConnectionId: Map<string, WriterConnectionStoredRecord>
}

type WriterConnectionIdentity = {
  apiServerPort: number
  hostname: string
  pid: number
  serverRole: ServerRole
  startedAt: string
  writerUrl: string | null
}

type WriterConnectionStoredRecord = WriterConnectionIdentity & {
  connectionId: string
  firstSeenAt: string
  lastHeartbeatAt: string | null
  lastProxyAt: string | null
  lastRequestPath: string | null
  proxyCount: number
}

export type WriterConnectionRecord = WriterConnectionStoredRecord & {
  isCurrentProcess: boolean
  isStale: boolean
  lastSeenAt: string
}

export type WriterConnectionsOverview = {
  followers: WriterConnectionRecord[]
  history: DuckdbOwnerLeaseHistoryEntry[]
  warnings: WriterWarning[]
  writer: WriterConnectionRecord
}

export type WriterConnectionHeartbeatInput = {
  apiServerPort: number
  hostname: string
  pid: number
  serverRole: ServerRole
  startedAt: string
  writerUrl: string | null
}

declare global {
  var __forskaWriterConnectionState: WriterConnectionState | undefined
}

const getWriterConnectionState = () => {
  globalThis.__forskaWriterConnectionState ??= {
    processStartedAt: new Date().toISOString(),
    recordsByConnectionId: new Map<string, WriterConnectionStoredRecord>(),
  }

  return globalThis.__forskaWriterConnectionState
}

const writerConnectionState = getWriterConnectionState()

const getNormalizedWriterUrl = (value: string | null | undefined) => {
  const raw = String(value ?? '').trim()
  return raw === '' ? null : raw.endsWith('/') ? raw.slice(0, -1) : raw
}

const getCurrentWriterUrl = () => {
  return `http://127.0.0.1:${env.API_SERVER_PORT}`
}

const getCurrentWriterConnectionIdentity = (): WriterConnectionIdentity => {
  return {
    apiServerPort: env.API_SERVER_PORT,
    hostname: hostname(),
    pid: process.pid,
    serverRole: getCurrentServerRole(),
    startedAt: writerConnectionState.processStartedAt,
    writerUrl: getKnownWriterUrl() ?? getCurrentWriterUrl(),
  }
}

const getWriterConnectionId = (identity: WriterConnectionHeartbeatInput) => {
  return `${identity.hostname}:${identity.apiServerPort}:${identity.pid}:${identity.startedAt}`
}

const getLastSeenAt = (record: WriterConnectionStoredRecord) => {
  return record.lastHeartbeatAt ?? record.lastProxyAt ?? record.firstSeenAt
}

const getIsWriterConnectionStale = (record: WriterConnectionStoredRecord, nowMs: number) => {
  return nowMs - new Date(getLastSeenAt(record)).getTime() > writerConnectionHeartbeatWindowMs
}

const toWriterConnectionRecord = (record: WriterConnectionStoredRecord, nowMs: number): WriterConnectionRecord => {
  return {
    ...record,
    isCurrentProcess: record.pid === process.pid && record.startedAt === writerConnectionState.processStartedAt,
    isStale: getIsWriterConnectionStale(record, nowMs),
    lastSeenAt: getLastSeenAt(record),
  }
}

const pruneWriterConnections = (nowMs: number) => {
  return [...writerConnectionState.recordsByConnectionId.entries()].map(([connectionId, record]) => {
    return nowMs - new Date(getLastSeenAt(record)).getTime() > writerConnectionRetentionMs
      ? writerConnectionState.recordsByConnectionId.delete(connectionId)
      : false
  })
}

const getWriterConnectionHeadersFromIdentity = (identity: WriterConnectionIdentity) => {
  return {
    [writerConnectionHeaderNames.apiServerPort]: String(identity.apiServerPort),
    [writerConnectionHeaderNames.hostname]: identity.hostname,
    [writerConnectionHeaderNames.pid]: String(identity.pid),
    [writerConnectionHeaderNames.serverRole]: identity.serverRole,
    [writerConnectionHeaderNames.startedAt]: identity.startedAt,
    [writerConnectionHeaderNames.writerUrl]: identity.writerUrl ?? '',
  }
}

const getNumberFromHeader = (value: string | null) => {
  return value === null ? null : Number.isFinite(Number(value)) ? Number(value) : null
}

const getServerRoleFromHeader = (value: string | null): ServerRole | null => {
  return value === 'writer' || value === 'api' || value === 'worker' || value === 'dev-single' ? value : null
}

const getWriterConnectionIdentityFromHeaders = (headers: Headers): WriterConnectionHeartbeatInput | null => {
  const apiServerPort = getNumberFromHeader(headers.get(writerConnectionHeaderNames.apiServerPort))
  const hostName = headers.get(writerConnectionHeaderNames.hostname)
  const pid = getNumberFromHeader(headers.get(writerConnectionHeaderNames.pid))
  const serverRole = getServerRoleFromHeader(headers.get(writerConnectionHeaderNames.serverRole))
  const startedAt = headers.get(writerConnectionHeaderNames.startedAt)

  return apiServerPort === null || hostName === null || pid === null || serverRole === null || startedAt === null
    ? null
    : {
        apiServerPort,
        hostname: hostName,
        pid,
        serverRole,
        startedAt,
        writerUrl: getNormalizedWriterUrl(headers.get(writerConnectionHeaderNames.writerUrl)),
      }
}

const getUpdatedWriterConnectionRecord = (
  input: WriterConnectionHeartbeatInput,
  previous: WriterConnectionStoredRecord | undefined,
  updates: Partial<
    Pick<WriterConnectionStoredRecord, 'lastHeartbeatAt' | 'lastProxyAt' | 'lastRequestPath' | 'proxyCount'>
  >,
) => {
  const nowIso = new Date().toISOString()
  const connectionId = getWriterConnectionId(input)

  return {
    connectionId,
    apiServerPort: input.apiServerPort,
    firstSeenAt: previous?.firstSeenAt ?? nowIso,
    hostname: input.hostname,
    lastHeartbeatAt: updates.lastHeartbeatAt ?? previous?.lastHeartbeatAt ?? null,
    lastProxyAt: updates.lastProxyAt ?? previous?.lastProxyAt ?? null,
    lastRequestPath: updates.lastRequestPath ?? previous?.lastRequestPath ?? null,
    pid: input.pid,
    proxyCount: updates.proxyCount ?? previous?.proxyCount ?? 0,
    serverRole: input.serverRole,
    startedAt: input.startedAt,
    writerUrl: input.writerUrl,
  } satisfies WriterConnectionStoredRecord
}

export const getWriterConnectionProxyHeaders = () => {
  return getWriterConnectionHeadersFromIdentity(getCurrentWriterConnectionIdentity())
}

export const upsertWriterConnectionHeartbeat = (input: WriterConnectionHeartbeatInput) => {
  const nowMs = Date.now()
  const previous = writerConnectionState.recordsByConnectionId.get(getWriterConnectionId(input))
  const nextRecord = getUpdatedWriterConnectionRecord(input, previous, {lastHeartbeatAt: new Date(nowMs).toISOString()})

  pruneWriterConnections(nowMs)
  writerConnectionState.recordsByConnectionId.set(nextRecord.connectionId, nextRecord)
  return toWriterConnectionRecord(nextRecord, nowMs)
}

export const recordWriterConnectionProxy = (headers: Headers, requestPath: string) => {
  const input = getWriterConnectionIdentityFromHeaders(headers)
  const nowMs = Date.now()

  if (input === null) {
    pruneWriterConnections(nowMs)
    return null
  }

  const previous = writerConnectionState.recordsByConnectionId.get(getWriterConnectionId(input))
  const nextRecord = getUpdatedWriterConnectionRecord(input, previous, {
    lastProxyAt: new Date(nowMs).toISOString(),
    lastRequestPath: requestPath,
    proxyCount: (previous?.proxyCount ?? 0) + 1,
  })

  pruneWriterConnections(nowMs)
  writerConnectionState.recordsByConnectionId.set(nextRecord.connectionId, nextRecord)
  return toWriterConnectionRecord(nextRecord, nowMs)
}

export const getWriterConnectionsOverview = async (): Promise<WriterConnectionsOverview> => {
  const nowMs = Date.now()
  const writerIdentity = getCurrentWriterConnectionIdentity()
  const history = await Effect.runPromise(readDuckdbOwnerLeaseHistory(env.DUCKDB_PATH))
  const writerRecord = getUpdatedWriterConnectionRecord(writerIdentity, undefined, {
    lastHeartbeatAt: new Date(nowMs).toISOString(),
  })
  const warnings = getWriterWarnings()
  const followers = [...writerConnectionState.recordsByConnectionId.values()]
    .map((record) => {
      return toWriterConnectionRecord(record, nowMs)
    })
    .sort((a, b) => {
      return b.lastSeenAt.localeCompare(a.lastSeenAt)
    })

  pruneWriterConnections(nowMs)

  return {followers, history, warnings, writer: toWriterConnectionRecord(writerRecord, nowMs)}
}

export const getWriterConnectionHeartbeatPayload = () => {
  return getCurrentWriterConnectionIdentity()
}
