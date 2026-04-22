import {Effect} from 'effect'

import {type DuckdbOwnerLeaseHistoryEntry, readDuckdbOwnerLeaseHistory} from './duckdbOwnerLease.ts'
import {type DuckdbOwnerWarning, getDuckdbOwnerWarnings} from './duckdbOwnerWarnings.ts'
import {env} from './env.ts'
import {
  assertRuntimeCutoverVersionCompatible,
  getRuntimeCutoverVersion,
  getRuntimeCutoverVersionMismatchMessage,
  isRuntimeCutoverVersionCompatible,
  normalizeRuntimeCutoverVersion,
  splitRuntimeCutoverVersionHeader,
} from './runtimeCutover.ts'
import type {RuntimeLogProfile} from './runtimeLogger.ts'
import {getRuntimeProcessIdentity, type RuntimeProcessServiceName} from './runtimeProcessIdentity.ts'
import {getServerRoleCapabilities, type ServerRole, type ServerRoleCapability} from './serverRole.ts'
import {
  canCurrentServerOwnDuckdb,
  getCurrentServerRole,
  getKnownDuckdbOwnerUrl,
  isCurrentServerDuckdbOwnerProxyDisabled,
} from './serverRuntimeRole.ts'

const duckdbOwnerConnectionHeartbeatWindowMs = 45_000
const duckdbOwnerConnectionRetentionMs = 10 * 60_000
const duckdbOwnerConnectionHeaderNames = {
  apiServerPort: 'x-forska-api-server-port',
  hostname: 'x-forska-hostname',
  instanceId: 'x-forska-instance-id',
  listenPort: 'x-forska-listen-port',
  pid: 'x-forska-pid',
  processStartedAt: 'x-forska-process-started-at',
  runtimeProfile: 'x-forska-runtime-profile',
  runtimeVersion: splitRuntimeCutoverVersionHeader,
  serverRole: 'x-forska-server-role',
  service: 'x-forska-service',
  startedAt: 'x-forska-started-at',
  duckdbOwnerUrl: 'x-forska-duckdb-owner-url',
} as const

type DuckdbOwnerConnectionState = {recordsByConnectionId: Map<string, DuckdbOwnerConnectionStoredRecord>}

type DuckdbOwnerConnectionIdentity = {
  apiServerPort: number
  hostname: string
  instanceId: string
  listenPort: number
  pid: number
  processStartedAt: string
  runtimeProfile: RuntimeLogProfile
  runtimeVersion: string
  serverRole: ServerRole
  service: RuntimeProcessServiceName
  startedAt: string
  duckdbOwnerUrl: string | null
}

type DuckdbOwnerConnectionStoredRecord = DuckdbOwnerConnectionIdentity & {
  connectionId: string
  firstSeenAt: string
  lastHeartbeatAt: string | null
  lastProxyAt: string | null
  lastRequestPath: string | null
  proxyCount: number
}

export type DuckdbOwnerConnectionRecord = DuckdbOwnerConnectionStoredRecord & {
  capabilities: ServerRoleCapability[]
  isCurrentProcess: boolean
  isStale: boolean
  lastSeenAt: string
}

export type RuntimeCapabilityRegistrySummary = {
  capability: ServerRoleCapability
  eligibleConsumerCount: number
  eligibleConsumerPresent: boolean
  registeredConsumerCount: number
  staleConsumerCount: number
}

export type RuntimeCapabilityRegistryOverview = {
  capabilities: RuntimeCapabilityRegistrySummary[]
  freshRegisteredProcessCount: number
  registeredProcessCount: number
  staleRegisteredProcessCount: number
}

export type DuckdbOwnerConnectionsOverview = {
  followers: DuckdbOwnerConnectionRecord[]
  history: DuckdbOwnerLeaseHistoryEntry[]
  registry: RuntimeCapabilityRegistryOverview
  runtimeVersion: string
  warnings: DuckdbOwnerWarning[]
  owner: DuckdbOwnerConnectionRecord | null
}

export type DuckdbOwnerConnectionHeartbeatInput = {
  apiServerPort: number
  hostname: string
  instanceId?: string
  listenPort?: number
  pid: number
  processStartedAt?: string
  runtimeProfile?: RuntimeLogProfile
  runtimeVersion?: string | null
  serverRole: ServerRole
  service?: RuntimeProcessServiceName
  startedAt: string
  duckdbOwnerUrl: string | null
}

declare global {
  var __forskaDuckdbOwnerConnectionState: DuckdbOwnerConnectionState | undefined
}

const getDuckdbOwnerConnectionState = () => {
  globalThis.__forskaDuckdbOwnerConnectionState ??= {
    recordsByConnectionId: new Map<string, DuckdbOwnerConnectionStoredRecord>(),
  }

  return globalThis.__forskaDuckdbOwnerConnectionState
}

const duckdbOwnerConnectionState = getDuckdbOwnerConnectionState()

const getNormalizedDuckdbOwnerUrl = (value: string | null | undefined) => {
  const raw = String(value ?? '').trim()
  return raw === '' ? null : raw.endsWith('/') ? raw.slice(0, -1) : raw
}

const getCurrentDuckdbOwnerUrl = () => {
  return `http://127.0.0.1:${env.API_SERVER_PORT}`
}

const getCurrentDuckdbOwnerConnectionIdentity = (): DuckdbOwnerConnectionIdentity => {
  const runtimeIdentity = getRuntimeProcessIdentity({listenPort: env.API_SERVER_PORT})

  return {
    apiServerPort: env.API_SERVER_PORT,
    hostname: runtimeIdentity.hostname,
    instanceId: runtimeIdentity.instanceId,
    listenPort: runtimeIdentity.listenPort,
    pid: process.pid,
    processStartedAt: runtimeIdentity.processStartedAt,
    runtimeProfile: runtimeIdentity.runtimeProfile,
    runtimeVersion: getRuntimeCutoverVersion(),
    serverRole: getCurrentServerRole(),
    service: runtimeIdentity.service,
    startedAt: runtimeIdentity.processStartedAt,
    duckdbOwnerUrl: getKnownDuckdbOwnerUrl() ?? (canCurrentServerOwnDuckdb() ? getCurrentDuckdbOwnerUrl() : null),
  }
}

const getOwnerProxyDisabledWarning = (): DuckdbOwnerWarning => {
  return {
    at: new Date().toISOString(),
    kind: 'owner-proxy-disabled',
    message:
      'DuckDB owner proxying is disabled for this server. Start `bun run dev:server:api` only when you explicitly want a read-less API shell without DuckDB writes.',
    severity: 'warning',
  }
}

const getDuckdbOwnerConnectionId = (identity: DuckdbOwnerConnectionHeartbeatInput) => {
  return getNormalizedDuckdbOwnerConnectionIdentity(identity).instanceId
}

const getLastSeenAt = (record: DuckdbOwnerConnectionStoredRecord) => {
  return record.lastHeartbeatAt ?? record.lastProxyAt ?? record.firstSeenAt
}

const getIsDuckdbOwnerConnectionStale = (record: DuckdbOwnerConnectionStoredRecord, nowMs: number) => {
  return nowMs - new Date(getLastSeenAt(record)).getTime() > duckdbOwnerConnectionHeartbeatWindowMs
}

const toDuckdbOwnerConnectionRecord = (
  record: DuckdbOwnerConnectionStoredRecord,
  nowMs: number,
): DuckdbOwnerConnectionRecord => {
  const runtimeIdentity = getRuntimeProcessIdentity({listenPort: env.API_SERVER_PORT})

  return {
    ...record,
    capabilities: getServerRoleCapabilities(record.serverRole),
    isCurrentProcess: record.instanceId === runtimeIdentity.instanceId,
    isStale: getIsDuckdbOwnerConnectionStale(record, nowMs),
    lastSeenAt: getLastSeenAt(record),
  }
}

const getUniqueRegisteredProcesses = (records: DuckdbOwnerConnectionRecord[]) => {
  return records.reduce<DuckdbOwnerConnectionRecord[]>((registeredProcesses, record) => {
    return registeredProcesses.some((registeredProcess) => {
      return registeredProcess.instanceId === record.instanceId
    })
      ? registeredProcesses
      : [...registeredProcesses, record]
  }, [])
}

const getCapabilitySummary = (
  capability: ServerRoleCapability,
  registeredProcesses: DuckdbOwnerConnectionRecord[],
): RuntimeCapabilityRegistrySummary => {
  const registeredConsumers = registeredProcesses.filter((registeredProcess) => {
    return registeredProcess.capabilities.includes(capability)
  })
  const staleConsumerCount = registeredConsumers.filter((registeredProcess) => {
    return registeredProcess.isStale
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

export const getRuntimeCapabilityRegistryOverview = (
  records: DuckdbOwnerConnectionRecord[],
): RuntimeCapabilityRegistryOverview => {
  const registeredProcesses = getUniqueRegisteredProcesses(records)
  const staleRegisteredProcessCount = registeredProcesses.filter((registeredProcess) => {
    return registeredProcess.isStale
  }).length

  return {
    capabilities: (
      ['api', 'owner-proxy', 'duckdb-owner', 'maintenance', 'judging'] satisfies ServerRoleCapability[]
    ).map((capability) => {
      return getCapabilitySummary(capability, registeredProcesses)
    }),
    freshRegisteredProcessCount: registeredProcesses.length - staleRegisteredProcessCount,
    registeredProcessCount: registeredProcesses.length,
    staleRegisteredProcessCount,
  }
}

const pruneDuckdbOwnerConnections = (nowMs: number) => {
  return [...duckdbOwnerConnectionState.recordsByConnectionId.entries()].map(([connectionId, record]) => {
    return nowMs - new Date(getLastSeenAt(record)).getTime() > duckdbOwnerConnectionRetentionMs
      ? duckdbOwnerConnectionState.recordsByConnectionId.delete(connectionId)
      : false
  })
}

const getDuckdbOwnerConnectionHeadersFromIdentity = (identity: DuckdbOwnerConnectionIdentity) => {
  return {
    [duckdbOwnerConnectionHeaderNames.apiServerPort]: String(identity.apiServerPort),
    [duckdbOwnerConnectionHeaderNames.hostname]: identity.hostname,
    [duckdbOwnerConnectionHeaderNames.instanceId]: identity.instanceId,
    [duckdbOwnerConnectionHeaderNames.listenPort]: String(identity.listenPort),
    [duckdbOwnerConnectionHeaderNames.pid]: String(identity.pid),
    [duckdbOwnerConnectionHeaderNames.processStartedAt]: identity.processStartedAt,
    [duckdbOwnerConnectionHeaderNames.runtimeProfile]: identity.runtimeProfile,
    [duckdbOwnerConnectionHeaderNames.runtimeVersion]: identity.runtimeVersion,
    [duckdbOwnerConnectionHeaderNames.serverRole]: identity.serverRole,
    [duckdbOwnerConnectionHeaderNames.service]: identity.service,
    [duckdbOwnerConnectionHeaderNames.startedAt]: identity.startedAt,
    [duckdbOwnerConnectionHeaderNames.duckdbOwnerUrl]: identity.duckdbOwnerUrl ?? '',
  }
}

const getNumberFromHeader = (value: string | null) => {
  return value === null ? null : Number.isFinite(Number(value)) ? Number(value) : null
}

const getServerRoleFromHeader = (value: string | null): ServerRole | null => {
  return value === 'api'
    || value === 'maintenance-worker'
    || value === 'judge-worker'
    || value === 'auto'
    || value === 'dev-single'
    ? value
    : null
}

const getRuntimeProfileFromHeader = (value: string | null): RuntimeLogProfile | null => {
  return value === 'local' || value === 'primary' || value === 'secondary' ? value : null
}

const getRuntimeVersionFromHeader = (headers: Headers) => {
  return normalizeRuntimeCutoverVersion(headers.get(duckdbOwnerConnectionHeaderNames.runtimeVersion))
}

const getRuntimeProcessServiceFromHeader = (value: string | null): RuntimeProcessServiceName | null => {
  return value === 'api-server'
    || value === 'app-server'
    || value === 'dev-single-server'
    || value === 'judge-worker-server'
    || value === 'maintenance-worker-server'
    || value === 'single-server'
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
        : serverRole === 'judge-worker'
          ? 'judge-worker-server'
          : 'maintenance-worker-server'
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

const getNormalizedDuckdbOwnerConnectionIdentity = (
  input: DuckdbOwnerConnectionHeartbeatInput,
): DuckdbOwnerConnectionIdentity => {
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
    runtimeVersion: normalizeRuntimeCutoverVersion(input.runtimeVersion) ?? getRuntimeCutoverVersion(),
    serverRole: input.serverRole,
    service,
    startedAt: processStartedAt,
    duckdbOwnerUrl: input.duckdbOwnerUrl,
  }
}

const getDuckdbOwnerConnectionIdentityFromHeaders = (headers: Headers): DuckdbOwnerConnectionHeartbeatInput | null => {
  const apiServerPort = getNumberFromHeader(headers.get(duckdbOwnerConnectionHeaderNames.apiServerPort))
  const hostName = headers.get(duckdbOwnerConnectionHeaderNames.hostname)
  const instanceId = headers.get(duckdbOwnerConnectionHeaderNames.instanceId) ?? undefined
  const listenPort = getNumberFromHeader(headers.get(duckdbOwnerConnectionHeaderNames.listenPort)) ?? undefined
  const pid = getNumberFromHeader(headers.get(duckdbOwnerConnectionHeaderNames.pid))
  const processStartedAt = headers.get(duckdbOwnerConnectionHeaderNames.processStartedAt) ?? undefined
  const runtimeProfile =
    getRuntimeProfileFromHeader(headers.get(duckdbOwnerConnectionHeaderNames.runtimeProfile)) ?? undefined
  const runtimeVersion = getRuntimeVersionFromHeader(headers)
  const serverRole = getServerRoleFromHeader(headers.get(duckdbOwnerConnectionHeaderNames.serverRole))
  const service = getRuntimeProcessServiceFromHeader(headers.get(duckdbOwnerConnectionHeaderNames.service)) ?? undefined
  const startedAt = headers.get(duckdbOwnerConnectionHeaderNames.startedAt)

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
        runtimeVersion,
        serverRole,
        service,
        startedAt,
        duckdbOwnerUrl: getNormalizedDuckdbOwnerUrl(headers.get(duckdbOwnerConnectionHeaderNames.duckdbOwnerUrl)),
      }
}

const getUpdatedDuckdbOwnerConnectionRecord = (
  input: DuckdbOwnerConnectionHeartbeatInput,
  previous: DuckdbOwnerConnectionStoredRecord | undefined,
  updates: Partial<
    Pick<DuckdbOwnerConnectionStoredRecord, 'lastHeartbeatAt' | 'lastProxyAt' | 'lastRequestPath' | 'proxyCount'>
  >,
) => {
  const nowIso = new Date().toISOString()
  const normalizedInput = getNormalizedDuckdbOwnerConnectionIdentity(input)
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
    runtimeVersion: normalizedInput.runtimeVersion,
    serverRole: normalizedInput.serverRole,
    service: normalizedInput.service,
    startedAt: normalizedInput.startedAt,
    duckdbOwnerUrl: normalizedInput.duckdbOwnerUrl,
  } satisfies DuckdbOwnerConnectionStoredRecord
}

export const getDuckdbOwnerConnectionProxyHeaders = () => {
  return getDuckdbOwnerConnectionHeadersFromIdentity(getCurrentDuckdbOwnerConnectionIdentity())
}

export const getDuckdbOwnerConnectionRuntimeVersionError = (headers: Headers) => {
  const hasPeerHeaders =
    headers.has(duckdbOwnerConnectionHeaderNames.apiServerPort)
    || headers.has(duckdbOwnerConnectionHeaderNames.instanceId)
    || headers.has(duckdbOwnerConnectionHeaderNames.serverRole)
  const runtimeVersion = getRuntimeVersionFromHeader(headers)

  return hasPeerHeaders && !isRuntimeCutoverVersionCompatible(runtimeVersion)
    ? new Error(getRuntimeCutoverVersionMismatchMessage({context: 'DuckDB owner-routed API request', runtimeVersion}))
    : null
}

export const assertDuckdbOwnerConnectionProxyHeadersCompatible = (headers: Headers) => {
  const error = getDuckdbOwnerConnectionRuntimeVersionError(headers)

  if (error !== null) {
    throw error
  }
}

export const assertDuckdbOwnerConnectionHeartbeatCompatible = (input: DuckdbOwnerConnectionHeartbeatInput) => {
  assertRuntimeCutoverVersionCompatible({
    context: 'DuckDB owner connection heartbeat',
    runtimeVersion: input.runtimeVersion,
  })
}

export const upsertDuckdbOwnerConnectionHeartbeat = (input: DuckdbOwnerConnectionHeartbeatInput) => {
  const nowMs = Date.now()
  const previous = duckdbOwnerConnectionState.recordsByConnectionId.get(getDuckdbOwnerConnectionId(input))
  const nextRecord = getUpdatedDuckdbOwnerConnectionRecord(input, previous, {
    lastHeartbeatAt: new Date(nowMs).toISOString(),
  })

  pruneDuckdbOwnerConnections(nowMs)
  duckdbOwnerConnectionState.recordsByConnectionId.set(nextRecord.connectionId, nextRecord)
  return toDuckdbOwnerConnectionRecord(nextRecord, nowMs)
}

export const recordDuckdbOwnerConnectionProxy = (headers: Headers, requestPath: string) => {
  assertDuckdbOwnerConnectionProxyHeadersCompatible(headers)

  const input = getDuckdbOwnerConnectionIdentityFromHeaders(headers)
  const nowMs = Date.now()

  if (input === null) {
    pruneDuckdbOwnerConnections(nowMs)
    return null
  }

  const previous = duckdbOwnerConnectionState.recordsByConnectionId.get(getDuckdbOwnerConnectionId(input))
  const nextRecord = getUpdatedDuckdbOwnerConnectionRecord(input, previous, {
    lastHeartbeatAt: new Date(nowMs).toISOString(),
    lastProxyAt: new Date(nowMs).toISOString(),
    lastRequestPath: requestPath,
    proxyCount: (previous?.proxyCount ?? 0) + 1,
  })

  pruneDuckdbOwnerConnections(nowMs)
  duckdbOwnerConnectionState.recordsByConnectionId.set(nextRecord.connectionId, nextRecord)
  return toDuckdbOwnerConnectionRecord(nextRecord, nowMs)
}

export const getDuckdbOwnerConnectionsOverview = async (): Promise<DuckdbOwnerConnectionsOverview> => {
  const nowMs = Date.now()
  const ownerIdentity = getCurrentDuckdbOwnerConnectionIdentity()
  const history = await Effect.runPromise(readDuckdbOwnerLeaseHistory(env.DUCKDB_PATH))
  const warnings = isCurrentServerDuckdbOwnerProxyDisabled()
    ? [getOwnerProxyDisabledWarning(), ...getDuckdbOwnerWarnings()]
    : getDuckdbOwnerWarnings()
  const followers = [...duckdbOwnerConnectionState.recordsByConnectionId.values()]
    .map((record) => {
      return toDuckdbOwnerConnectionRecord(record, nowMs)
    })
    .sort((a, b) => {
      return b.lastSeenAt.localeCompare(a.lastSeenAt)
    })

  pruneDuckdbOwnerConnections(nowMs)
  const owner = isCurrentServerDuckdbOwnerProxyDisabled()
    ? null
    : toDuckdbOwnerConnectionRecord(
        getUpdatedDuckdbOwnerConnectionRecord(ownerIdentity, undefined, {
          lastHeartbeatAt: new Date(nowMs).toISOString(),
        }),
        nowMs,
      )

  return {
    followers,
    history,
    registry: getRuntimeCapabilityRegistryOverview(owner === null ? followers : [owner, ...followers]),
    runtimeVersion: getRuntimeCutoverVersion(),
    warnings,
    owner,
  }
}

export const getDuckdbOwnerConnectionHeartbeatPayload = () => {
  return getCurrentDuckdbOwnerConnectionIdentity()
}
