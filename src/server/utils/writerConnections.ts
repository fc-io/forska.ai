import {Effect} from 'effect'

import {type DuckdbOwnerLeaseHistoryEntry, readDuckdbOwnerLeaseHistory} from './duckdbOwnerLease.ts'
import {env} from './env.ts'
import type {RuntimeLogProfile} from './runtimeLogger.ts'
import {getRuntimeProcessIdentity, type RuntimeProcessServiceName} from './runtimeProcessIdentity.ts'
import {getServerRoleCapabilities, type ServerRole, type ServerRoleCapability} from './serverRole.ts'
import {
  canCurrentServerOwnDuckdb,
  getCurrentServerRole,
  getKnownWriterUrl,
  isCurrentServerWriterDisabled,
} from './serverRuntimeRole.ts'
import {getWriterWarnings, type WriterWarning} from './writerWarnings.ts'

const writerConnectionHeartbeatWindowMs = 45_000
const writerConnectionRetentionMs = 10 * 60_000
const writerConnectionHeaderNames = {
  apiServerPort: 'x-forska-api-server-port',
  hostname: 'x-forska-hostname',
  instanceId: 'x-forska-instance-id',
  listenPort: 'x-forska-listen-port',
  pid: 'x-forska-pid',
  processStartedAt: 'x-forska-process-started-at',
  runtimeProfile: 'x-forska-runtime-profile',
  serverRole: 'x-forska-server-role',
  service: 'x-forska-service',
  startedAt: 'x-forska-started-at',
  writerUrl: 'x-forska-writer-url',
} as const

type WriterConnectionState = {recordsByConnectionId: Map<string, WriterConnectionStoredRecord>}

type WriterConnectionIdentity = {
  apiServerPort: number
  hostname: string
  instanceId: string
  listenPort: number
  pid: number
  processStartedAt: string
  runtimeProfile: RuntimeLogProfile
  serverRole: ServerRole
  service: RuntimeProcessServiceName
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
  capabilities: ServerRoleCapability[]
  isCurrentProcess: boolean
  isStale: boolean
  lastSeenAt: string
}

export type WorkerRegistryCapabilitySummary = {
  capability: ServerRoleCapability
  eligibleConsumerCount: number
  eligibleConsumerPresent: boolean
  registeredConsumerCount: number
  staleConsumerCount: number
}

export type WorkerRegistryOverview = {
  capabilities: WorkerRegistryCapabilitySummary[]
  freshRegisteredWorkerCount: number
  registeredWorkerCount: number
  staleRegisteredWorkerCount: number
}

export type WriterConnectionsOverview = {
  followers: WriterConnectionRecord[]
  history: DuckdbOwnerLeaseHistoryEntry[]
  registry: WorkerRegistryOverview
  warnings: WriterWarning[]
  writer: WriterConnectionRecord | null
}

export type WriterConnectionHeartbeatInput = {
  apiServerPort: number
  hostname: string
  instanceId?: string
  listenPort?: number
  pid: number
  processStartedAt?: string
  runtimeProfile?: RuntimeLogProfile
  serverRole: ServerRole
  service?: RuntimeProcessServiceName
  startedAt: string
  writerUrl: string | null
}

declare global {
  var __forskaWriterConnectionState: WriterConnectionState | undefined
}

const getWriterConnectionState = () => {
  globalThis.__forskaWriterConnectionState ??= {recordsByConnectionId: new Map<string, WriterConnectionStoredRecord>()}

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
  const runtimeIdentity = getRuntimeProcessIdentity({listenPort: env.API_SERVER_PORT})

  return {
    apiServerPort: env.API_SERVER_PORT,
    hostname: runtimeIdentity.hostname,
    instanceId: runtimeIdentity.instanceId,
    listenPort: runtimeIdentity.listenPort,
    pid: process.pid,
    processStartedAt: runtimeIdentity.processStartedAt,
    runtimeProfile: runtimeIdentity.runtimeProfile,
    serverRole: getCurrentServerRole(),
    service: runtimeIdentity.service,
    startedAt: runtimeIdentity.processStartedAt,
    writerUrl: getKnownWriterUrl() ?? (canCurrentServerOwnDuckdb() ? getCurrentWriterUrl() : null),
  }
}

const getWriterDisabledWarning = (): WriterWarning => {
  return {
    at: new Date().toISOString(),
    kind: 'writer-disabled',
    message:
      'Writer is disabled for this server. Start `bun run dev:server:no-writer` only when you explicitly want a read-less API shell without DuckDB writes.',
    severity: 'warning',
  }
}

const getWriterConnectionId = (identity: WriterConnectionHeartbeatInput) => {
  return getNormalizedWriterConnectionIdentity(identity).instanceId
}

const getLastSeenAt = (record: WriterConnectionStoredRecord) => {
  return record.lastHeartbeatAt ?? record.lastProxyAt ?? record.firstSeenAt
}

const getIsWriterConnectionStale = (record: WriterConnectionStoredRecord, nowMs: number) => {
  return nowMs - new Date(getLastSeenAt(record)).getTime() > writerConnectionHeartbeatWindowMs
}

const toWriterConnectionRecord = (record: WriterConnectionStoredRecord, nowMs: number): WriterConnectionRecord => {
  const runtimeIdentity = getRuntimeProcessIdentity({listenPort: env.API_SERVER_PORT})

  return {
    ...record,
    capabilities: getServerRoleCapabilities(record.serverRole),
    isCurrentProcess: record.instanceId === runtimeIdentity.instanceId,
    isStale: getIsWriterConnectionStale(record, nowMs),
    lastSeenAt: getLastSeenAt(record),
  }
}

const getUniqueRegisteredWorkers = (records: WriterConnectionRecord[]) => {
  return records.reduce<WriterConnectionRecord[]>((registeredWorkers, record) => {
    return registeredWorkers.some((registeredWorker) => {
      return registeredWorker.instanceId === record.instanceId
    })
      ? registeredWorkers
      : [...registeredWorkers, record]
  }, [])
}

const getCapabilitySummary = (
  capability: ServerRoleCapability,
  registeredWorkers: WriterConnectionRecord[],
): WorkerRegistryCapabilitySummary => {
  const registeredConsumers = registeredWorkers.filter((registeredWorker) => {
    return registeredWorker.capabilities.includes(capability)
  })
  const staleConsumerCount = registeredConsumers.filter((registeredWorker) => {
    return registeredWorker.isStale
  }).length
  const eligibleConsumerCount = registeredConsumers.length - staleConsumerCount

  return {
    capability,
    eligibleConsumerCount,
    eligibleConsumerPresent: eligibleConsumerCount > 0,
    registeredConsumerCount: registeredConsumers.length,
    staleConsumerCount,
  }
}

export const getWorkerRegistryOverview = (records: WriterConnectionRecord[]): WorkerRegistryOverview => {
  const registeredWorkers = getUniqueRegisteredWorkers(records)
  const staleRegisteredWorkerCount = registeredWorkers.filter((registeredWorker) => {
    return registeredWorker.isStale
  }).length

  return {
    capabilities: (['api', 'duckdb-owner', 'maintenance', 'judging'] satisfies ServerRoleCapability[]).map(
      (capability) => {
        return getCapabilitySummary(capability, registeredWorkers)
      },
    ),
    freshRegisteredWorkerCount: registeredWorkers.length - staleRegisteredWorkerCount,
    registeredWorkerCount: registeredWorkers.length,
    staleRegisteredWorkerCount,
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
    [writerConnectionHeaderNames.instanceId]: identity.instanceId,
    [writerConnectionHeaderNames.listenPort]: String(identity.listenPort),
    [writerConnectionHeaderNames.pid]: String(identity.pid),
    [writerConnectionHeaderNames.processStartedAt]: identity.processStartedAt,
    [writerConnectionHeaderNames.runtimeProfile]: identity.runtimeProfile,
    [writerConnectionHeaderNames.serverRole]: identity.serverRole,
    [writerConnectionHeaderNames.service]: identity.service,
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

const getRuntimeProfileFromHeader = (value: string | null): RuntimeLogProfile | null => {
  return value === 'local' || value === 'primary' || value === 'secondary' ? value : null
}

const getRuntimeProcessServiceFromHeader = (value: string | null): RuntimeProcessServiceName | null => {
  return value === 'api-server'
    || value === 'app-server'
    || value === 'dev-single-server'
    || value === 'single-server'
    || value === 'worker-server'
    ? value
    : null
}

const getRuntimeProcessServiceForServerRole = (serverRole: ServerRole): RuntimeProcessServiceName => {
  return serverRole === 'api'
    ? 'api-server'
    : serverRole === 'dev-single'
      ? 'dev-single-server'
      : serverRole === 'auto'
        ? 'single-server'
        : 'worker-server'
}

const getInstanceIdFromIdentity = (identity: {
  hostname: string
  listenPort: number
  pid: number
  processStartedAt: string
  service: RuntimeProcessServiceName
}) => {
  return `${identity.service}:${identity.hostname}:${identity.listenPort}:${identity.pid}:${identity.processStartedAt}`
}

const getNormalizedWriterConnectionIdentity = (input: WriterConnectionHeartbeatInput): WriterConnectionIdentity => {
  const listenPort = input.listenPort ?? input.apiServerPort
  const processStartedAt = input.processStartedAt ?? input.startedAt
  const runtimeProfile = input.runtimeProfile ?? 'local'
  const service = input.service ?? getRuntimeProcessServiceForServerRole(input.serverRole)
  const instanceId =
    input.instanceId
    ?? getInstanceIdFromIdentity({hostname: input.hostname, listenPort, pid: input.pid, processStartedAt, service})

  return {
    apiServerPort: input.apiServerPort,
    hostname: input.hostname,
    instanceId,
    listenPort,
    pid: input.pid,
    processStartedAt,
    runtimeProfile,
    serverRole: input.serverRole,
    service,
    startedAt: processStartedAt,
    writerUrl: input.writerUrl,
  }
}

const getWriterConnectionIdentityFromHeaders = (headers: Headers): WriterConnectionHeartbeatInput | null => {
  const apiServerPort = getNumberFromHeader(headers.get(writerConnectionHeaderNames.apiServerPort))
  const hostName = headers.get(writerConnectionHeaderNames.hostname)
  const instanceId = headers.get(writerConnectionHeaderNames.instanceId) ?? undefined
  const listenPort = getNumberFromHeader(headers.get(writerConnectionHeaderNames.listenPort)) ?? undefined
  const pid = getNumberFromHeader(headers.get(writerConnectionHeaderNames.pid))
  const processStartedAt = headers.get(writerConnectionHeaderNames.processStartedAt) ?? undefined
  const runtimeProfile =
    getRuntimeProfileFromHeader(headers.get(writerConnectionHeaderNames.runtimeProfile)) ?? undefined
  const serverRole = getServerRoleFromHeader(headers.get(writerConnectionHeaderNames.serverRole))
  const service = getRuntimeProcessServiceFromHeader(headers.get(writerConnectionHeaderNames.service)) ?? undefined
  const startedAt = headers.get(writerConnectionHeaderNames.startedAt)

  return apiServerPort === null || hostName === null || pid === null || serverRole === null || startedAt === null
    ? null
    : {
        apiServerPort,
        hostname: hostName,
        instanceId,
        listenPort,
        pid,
        processStartedAt,
        runtimeProfile,
        serverRole,
        service,
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
  const normalizedInput = getNormalizedWriterConnectionIdentity(input)
  const connectionId = normalizedInput.instanceId

  return {
    connectionId,
    apiServerPort: normalizedInput.apiServerPort,
    firstSeenAt: previous?.firstSeenAt ?? nowIso,
    hostname: normalizedInput.hostname,
    instanceId: normalizedInput.instanceId,
    lastHeartbeatAt: updates.lastHeartbeatAt ?? previous?.lastHeartbeatAt ?? null,
    lastProxyAt: updates.lastProxyAt ?? previous?.lastProxyAt ?? null,
    lastRequestPath: updates.lastRequestPath ?? previous?.lastRequestPath ?? null,
    listenPort: normalizedInput.listenPort,
    pid: normalizedInput.pid,
    processStartedAt: normalizedInput.processStartedAt,
    proxyCount: updates.proxyCount ?? previous?.proxyCount ?? 0,
    runtimeProfile: normalizedInput.runtimeProfile,
    serverRole: normalizedInput.serverRole,
    service: normalizedInput.service,
    startedAt: normalizedInput.startedAt,
    writerUrl: normalizedInput.writerUrl,
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
    lastHeartbeatAt: new Date(nowMs).toISOString(),
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
  const warnings = isCurrentServerWriterDisabled()
    ? [getWriterDisabledWarning(), ...getWriterWarnings()]
    : getWriterWarnings()
  const followers = [...writerConnectionState.recordsByConnectionId.values()]
    .map((record) => {
      return toWriterConnectionRecord(record, nowMs)
    })
    .sort((a, b) => {
      return b.lastSeenAt.localeCompare(a.lastSeenAt)
    })

  pruneWriterConnections(nowMs)
  const writer = isCurrentServerWriterDisabled()
    ? null
    : toWriterConnectionRecord(
        getUpdatedWriterConnectionRecord(writerIdentity, undefined, {lastHeartbeatAt: new Date(nowMs).toISOString()}),
        nowMs,
      )

  return {
    followers,
    history,
    registry: getWorkerRegistryOverview(writer === null ? followers : [writer, ...followers]),
    warnings,
    writer,
  }
}

export const getWriterConnectionHeartbeatPayload = () => {
  return getCurrentWriterConnectionIdentity()
}
