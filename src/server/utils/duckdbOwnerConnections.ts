import {createHash, randomUUID} from 'node:crypto'
import {mkdir, readdir, readFile, rename, rm, unlink, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

import {Effect} from 'effect'

import {
  type DuckdbOwnerLeaseHistoryEntry,
  type DuckdbOwnerLeaseMetadata,
  getDuckdbOwnerLeaseUrl,
  isDuckdbOwnerLeaseProcessAlive,
  isDuckdbOwnerLeaseStale,
  readDuckdbOwnerLease,
  readDuckdbOwnerLeaseHistory,
} from './duckdbOwnerLease.ts'
import {type DuckdbOwnerWarning, getDuckdbOwnerWarnings} from './duckdbOwnerWarnings.ts'
import {env} from './env.ts'
import {shouldRunMartRefreshDrainForDuckdbMemoryLimit} from './martRefreshDrainEligibility.ts'
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
import {getServerRoleCapabilities, isAutoServerRole, type ServerRole, type ServerRoleCapability} from './serverRole.ts'
import {
  canCurrentServerOwnDuckdb,
  getCurrentServerRole,
  getKnownDuckdbOwnerUrl,
  isCurrentServerDuckdbOwnerProxyDisabled,
} from './serverRuntimeRole.ts'

const duckdbOwnerConnectionHeartbeatWindowMs = 45_000
const duckdbOwnerConnectionRetentionMs = 10 * 60_000
const workerRegistryStorageVersion = 1
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

export type WorkerRegistryThroughputProfile = {
  batchSize: number | null
  martRefreshDrainEligible: boolean
  maxCyclesPerWake: number | null
  pollIntervalMs: number | null
  profile: 'maintenance' | 'maintenance-paused-low-memory' | 'non-maintenance'
}

export type WorkerRegistryOwnerFreshnessState =
  | 'owner_dead'
  | 'owner_fresh'
  | 'owner_missing'
  | 'owner_stale'
  | 'owner_unknown'

export type WorkerRegistryTakeoverIntent = 'none' | 'standby' | 'takeover_in_progress'

export type WorkerRegistryTakeoverState = {
  candidate: boolean
  intent: WorkerRegistryTakeoverIntent
  observedAt: string
  ownerFreshness: WorkerRegistryOwnerFreshnessState
  ownerHeartbeatAt: string | null
  ownerLeaseId: string | null
  ownerUrl: string | null
}

export type WorkerRegistryTakeoverOverview = {
  candidateCount: number
  latestOwnerFreshness: WorkerRegistryOwnerFreshnessState
  latestObservedAt: string | null
  status: 'no_candidate' | 'owner_fresh' | 'standby' | 'takeover_in_progress' | 'unknown'
  takeoverInProgressCount: number
}

type DuckdbOwnerConnectionIdentity = {
  apiServerPort: number
  capabilities: ServerRoleCapability[]
  hostname: string
  instanceId: string
  listenPort: number
  memoryLimit: string | null
  pid: number
  processStartedAt: string
  runtimeProfile: RuntimeLogProfile
  runtimeVersion: string
  serverRole: ServerRole
  service: RuntimeProcessServiceName
  startedAt: string
  throughputProfile: WorkerRegistryThroughputProfile
  takeover: WorkerRegistryTakeoverState
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
  freshConsumerCount: number
  registeredConsumerCount: number
  staleConsumerCount: number
}

export type RuntimeCapabilityRegistryOverview = {
  capabilities: RuntimeCapabilityRegistrySummary[]
  freshRegisteredProcessCount: number
  registeredProcessCount: number
  staleRegisteredProcessCount: number
  takeover: WorkerRegistryTakeoverOverview
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
  capabilities?: ServerRoleCapability[]
  hostname: string
  instanceId?: string
  listenPort?: number
  memoryLimit?: string | null
  pid: number
  processStartedAt?: string
  runtimeProfile?: RuntimeLogProfile
  runtimeVersion?: string | null
  serverRole: ServerRole
  service?: RuntimeProcessServiceName
  startedAt: string
  throughputProfile?: WorkerRegistryThroughputProfile | null
  takeover?: WorkerRegistryTakeoverState | null
  duckdbOwnerUrl: string | null
}

type DuckdbOwnerConnectionStorageOptions = {databasePath?: string}

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

const getWorkerRegistryStorageDirectory = (databasePath: string) => {
  return databasePath === ':memory:' ? null : `${databasePath}.worker-registry`
}

const getWorkerRegistryRecordStorageKey = (connectionId: string) => {
  return createHash('sha256').update(connectionId).digest('hex')
}

const getWorkerRegistryRecordPath = (databasePath: string, connectionId: string) => {
  const storageDirectory = getWorkerRegistryStorageDirectory(databasePath)

  return storageDirectory === null
    ? null
    : join(storageDirectory, `${getWorkerRegistryRecordStorageKey(connectionId)}.json`)
}

const getStringValue = (value: unknown, fallback = '') => {
  return typeof value === 'string' ? value : fallback
}

const getNullableStringValue = (value: unknown) => {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

const getNumberValue = (value: unknown, fallback = 0) => {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

const getNullableNumberValue = (value: unknown) => {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const getPositiveIntegerEnvValue = (value: string | undefined) => {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10)

  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

const getCurrentMemoryLimit = () => {
  return String(process.env.DUCKDB_MEMORY_LIMIT ?? env.DUCKDB_MEMORY_LIMIT ?? '').trim() || null
}

const getDefaultThroughputProfile = (
  serverRole: ServerRole,
  memoryLimit: string | null = getCurrentMemoryLimit(),
): WorkerRegistryThroughputProfile => {
  const capabilities = getServerRoleCapabilities(serverRole)
  const hasMaintenanceCapability = capabilities.includes('maintenance')
  const martRefreshDrainEligible =
    hasMaintenanceCapability && shouldRunMartRefreshDrainForDuckdbMemoryLimit(memoryLimit ?? undefined)

  return {
    batchSize: hasMaintenanceCapability
      ? getPositiveIntegerEnvValue(process.env.PROJECT_MART_LARGE_REBUILD_BATCH_SIZE)
      : null,
    martRefreshDrainEligible,
    maxCyclesPerWake: hasMaintenanceCapability
      ? getPositiveIntegerEnvValue(process.env.PROJECT_MART_LARGE_REBUILD_MAX_CYCLES_PER_WAKE)
      : null,
    pollIntervalMs: hasMaintenanceCapability
      ? getPositiveIntegerEnvValue(process.env.PROJECT_MART_LARGE_REBUILD_POLL_INTERVAL_MS)
      : null,
    profile: hasMaintenanceCapability
      ? martRefreshDrainEligible
        ? 'maintenance'
        : 'maintenance-paused-low-memory'
      : 'non-maintenance',
  }
}

const getDefaultTakeoverState = (): WorkerRegistryTakeoverState => {
  return {
    candidate: false,
    intent: 'none',
    observedAt: new Date().toISOString(),
    ownerFreshness: 'owner_unknown',
    ownerHeartbeatAt: null,
    ownerLeaseId: null,
    ownerUrl: null,
  }
}

const getNormalizedDuckdbOwnerUrl = (value: string | null | undefined) => {
  const raw = String(value ?? '').trim()
  return raw === '' ? null : raw.endsWith('/') ? raw.slice(0, -1) : raw
}

const getCurrentDuckdbOwnerUrl = () => {
  return `http://127.0.0.1:${env.API_SERVER_PORT}`
}

const getCurrentDuckdbOwnerConnectionIdentity = (): DuckdbOwnerConnectionIdentity => {
  const runtimeIdentity = getRuntimeProcessIdentity({listenPort: env.API_SERVER_PORT})
  const serverRole = getCurrentServerRole()
  const memoryLimit = getCurrentMemoryLimit()

  return {
    apiServerPort: env.API_SERVER_PORT,
    capabilities: getServerRoleCapabilities(serverRole),
    hostname: runtimeIdentity.hostname,
    instanceId: runtimeIdentity.instanceId,
    listenPort: runtimeIdentity.listenPort,
    memoryLimit,
    pid: process.pid,
    processStartedAt: runtimeIdentity.processStartedAt,
    runtimeProfile: runtimeIdentity.runtimeProfile,
    runtimeVersion: getRuntimeCutoverVersion(),
    serverRole,
    service: runtimeIdentity.service,
    startedAt: runtimeIdentity.processStartedAt,
    throughputProfile: getDefaultThroughputProfile(serverRole, memoryLimit),
    takeover: getDefaultTakeoverState(),
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
  const isCurrentProcess = record.instanceId === runtimeIdentity.instanceId
  const isCurrentProcessRoleMismatch = isCurrentProcess && record.serverRole !== getCurrentServerRole()

  return {
    ...record,
    capabilities: record.capabilities,
    isCurrentProcess,
    isStale: isCurrentProcessRoleMismatch || getIsDuckdbOwnerConnectionStale(record, nowMs),
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
  const freshConsumers = registeredConsumers.filter((registeredProcess) => {
    return !registeredProcess.isStale
  })
  const eligibleConsumers = freshConsumers.filter((registeredProcess) => {
    return capability === 'maintenance' ? registeredProcess.throughputProfile.martRefreshDrainEligible : true
  })
  const eligibleConsumerCount = eligibleConsumers.length

  return {
    capability,
    eligibleConsumerCount,
    eligibleConsumerPresent: eligibleConsumerCount > 0,
    freshConsumerCount: freshConsumers.length,
    registeredConsumerCount: registeredConsumers.length,
    staleConsumerCount,
  }
}

const getLatestTakeoverState = (registeredProcesses: DuckdbOwnerConnectionRecord[]) => {
  return registeredProcesses.reduce<WorkerRegistryTakeoverState | null>((latest, registeredProcess) => {
    if (latest === null) {
      return registeredProcess.takeover
    }

    return registeredProcess.takeover.observedAt.localeCompare(latest.observedAt) > 0
      ? registeredProcess.takeover
      : latest
  }, null)
}

const getWorkerRegistryTakeoverOverview = (
  registeredProcesses: DuckdbOwnerConnectionRecord[],
): WorkerRegistryTakeoverOverview => {
  const freshCandidates = registeredProcesses.filter((registeredProcess) => {
    return registeredProcess.takeover.candidate && !registeredProcess.isStale
  })
  const takeoverInProgressCount = freshCandidates.filter((registeredProcess) => {
    return registeredProcess.takeover.intent === 'takeover_in_progress'
  }).length
  const latestTakeover = getLatestTakeoverState(registeredProcesses)
  const latestOwnerFreshness = latestTakeover?.ownerFreshness ?? 'owner_unknown'
  const ownerLost =
    latestOwnerFreshness === 'owner_dead'
    || latestOwnerFreshness === 'owner_missing'
    || latestOwnerFreshness === 'owner_stale'

  return {
    candidateCount: freshCandidates.length,
    latestOwnerFreshness,
    latestObservedAt: latestTakeover?.observedAt ?? null,
    status:
      takeoverInProgressCount > 0
        ? 'takeover_in_progress'
        : latestOwnerFreshness === 'owner_fresh'
          ? 'owner_fresh'
          : freshCandidates.length > 0
            ? 'standby'
            : ownerLost
              ? 'no_candidate'
              : 'unknown',
    takeoverInProgressCount,
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
    takeover: getWorkerRegistryTakeoverOverview(registeredProcesses),
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

const getServerRoleFromValue = (value: unknown): ServerRole | null => {
  return typeof value === 'string' ? getServerRoleFromHeader(value) : null
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

const getCapabilityFromValue = (value: unknown): ServerRoleCapability | null => {
  return value === 'api'
    || value === 'owner-proxy'
    || value === 'duckdb-owner'
    || value === 'maintenance'
    || value === 'judging'
    ? value
    : null
}

const getCapabilitiesFromValue = (value: unknown, serverRole: ServerRole) => {
  return Array.isArray(value)
    ? value.reduce<ServerRoleCapability[]>((capabilities, capabilityValue) => {
        const capability = getCapabilityFromValue(capabilityValue)

        return capability !== null && !capabilities.includes(capability) ? [...capabilities, capability] : capabilities
      }, [])
    : getServerRoleCapabilities(serverRole)
}

const getThroughputProfileName = (value: unknown): WorkerRegistryThroughputProfile['profile'] | null => {
  return value === 'maintenance' || value === 'maintenance-paused-low-memory' || value === 'non-maintenance'
    ? value
    : null
}

const normalizeThroughputProfile = (
  value: WorkerRegistryThroughputProfile | null | undefined,
  serverRole: ServerRole,
  memoryLimit: string | null,
): WorkerRegistryThroughputProfile => {
  const fallback = getDefaultThroughputProfile(serverRole, memoryLimit)
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null

  return record === null
    ? fallback
    : {
        batchSize: getNullableNumberValue(record.batchSize),
        martRefreshDrainEligible:
          typeof record.martRefreshDrainEligible === 'boolean'
            ? record.martRefreshDrainEligible
            : fallback.martRefreshDrainEligible,
        maxCyclesPerWake: getNullableNumberValue(record.maxCyclesPerWake),
        pollIntervalMs: getNullableNumberValue(record.pollIntervalMs),
        profile: getThroughputProfileName(record.profile) ?? fallback.profile,
      }
}

const getOwnerFreshnessState = (value: unknown): WorkerRegistryOwnerFreshnessState | null => {
  return value === 'owner_dead'
    || value === 'owner_fresh'
    || value === 'owner_missing'
    || value === 'owner_stale'
    || value === 'owner_unknown'
    ? value
    : null
}

const getTakeoverIntent = (value: unknown): WorkerRegistryTakeoverIntent | null => {
  return value === 'none' || value === 'standby' || value === 'takeover_in_progress' ? value : null
}

const normalizeTakeoverState = (value: WorkerRegistryTakeoverState | null | undefined): WorkerRegistryTakeoverState => {
  const fallback = getDefaultTakeoverState()
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null

  return record === null
    ? fallback
    : {
        candidate: record.candidate === true,
        intent: getTakeoverIntent(record.intent) ?? fallback.intent,
        observedAt: getStringValue(record.observedAt, fallback.observedAt),
        ownerFreshness: getOwnerFreshnessState(record.ownerFreshness) ?? fallback.ownerFreshness,
        ownerHeartbeatAt: getNullableStringValue(record.ownerHeartbeatAt),
        ownerLeaseId: getNullableStringValue(record.ownerLeaseId),
        ownerUrl: getNormalizedDuckdbOwnerUrl(getNullableStringValue(record.ownerUrl)),
      }
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
  const memoryLimit = input.memoryLimit ?? null
  const capabilities = getCapabilitiesFromValue(input.capabilities, input.serverRole)

  return {
    apiServerPort: input.apiServerPort,
    capabilities,
    hostname: input.hostname,
    instanceId,
    listenPort,
    memoryLimit,
    pid: input.pid,
    processStartedAt,
    runtimeProfile,
    runtimeVersion: normalizeRuntimeCutoverVersion(input.runtimeVersion) ?? getRuntimeCutoverVersion(),
    serverRole: input.serverRole,
    service,
    startedAt: processStartedAt,
    throughputProfile: normalizeThroughputProfile(input.throughputProfile, input.serverRole, memoryLimit),
    takeover: normalizeTakeoverState(input.takeover),
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
    capabilities: normalizedInput.capabilities,
    firstSeenAt: previous?.firstSeenAt ?? nowIso,
    hostname: normalizedInput.hostname,
    instanceId: normalizedInput.instanceId,
    lastHeartbeatAt: updates.lastHeartbeatAt ?? previous?.lastHeartbeatAt ?? null,
    lastProxyAt: updates.lastProxyAt ?? previous?.lastProxyAt ?? null,
    lastRequestPath: updates.lastRequestPath ?? previous?.lastRequestPath ?? null,
    listenPort: normalizedInput.listenPort,
    memoryLimit: normalizedInput.memoryLimit,
    pid: normalizedInput.pid,
    processStartedAt: normalizedInput.processStartedAt,
    proxyCount: updates.proxyCount ?? previous?.proxyCount ?? 0,
    runtimeProfile: normalizedInput.runtimeProfile,
    runtimeVersion: normalizedInput.runtimeVersion,
    serverRole: normalizedInput.serverRole,
    service: normalizedInput.service,
    startedAt: normalizedInput.startedAt,
    throughputProfile: normalizedInput.throughputProfile,
    takeover: normalizedInput.takeover,
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

const isMissingFileError = (error: unknown) => {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

const isJsonSyntaxError = (error: unknown) => {
  return error instanceof SyntaxError || (error instanceof Error && error.name === 'SyntaxError')
}

const normalizeStoredDuckdbOwnerConnectionRecord = (value: unknown): DuckdbOwnerConnectionStoredRecord | null => {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
  const serverRole = getServerRoleFromValue(record?.serverRole)

  if (record === null || serverRole === null) {
    return null
  }

  const startedAt = getStringValue(record.startedAt, getStringValue(record.processStartedAt, new Date().toISOString()))
  const input = {
    apiServerPort: getNumberValue(record.apiServerPort),
    capabilities: getCapabilitiesFromValue(record.capabilities, serverRole),
    hostname: getStringValue(record.hostname),
    instanceId: getStringValue(record.instanceId, getStringValue(record.connectionId)),
    listenPort: getNumberValue(record.listenPort, getNumberValue(record.apiServerPort)),
    memoryLimit: getNullableStringValue(record.memoryLimit),
    pid: getNumberValue(record.pid),
    processStartedAt: getStringValue(record.processStartedAt, startedAt),
    runtimeProfile: getRuntimeProfileFromHeader(getStringValue(record.runtimeProfile)) ?? undefined,
    runtimeVersion: normalizeRuntimeCutoverVersion(getNullableStringValue(record.runtimeVersion)),
    serverRole,
    service: getRuntimeProcessServiceFromHeader(getStringValue(record.service)) ?? undefined,
    startedAt,
    throughputProfile: normalizeThroughputProfile(
      record.throughputProfile as WorkerRegistryThroughputProfile | null | undefined,
      serverRole,
      getNullableStringValue(record.memoryLimit),
    ),
    takeover: normalizeTakeoverState(record.takeover as WorkerRegistryTakeoverState | null | undefined),
    duckdbOwnerUrl: getNormalizedDuckdbOwnerUrl(getNullableStringValue(record.duckdbOwnerUrl)),
  } satisfies DuckdbOwnerConnectionHeartbeatInput
  const normalizedRecord = getUpdatedDuckdbOwnerConnectionRecord(input, undefined, {
    lastHeartbeatAt: getNullableStringValue(record.lastHeartbeatAt),
    lastProxyAt: getNullableStringValue(record.lastProxyAt),
    lastRequestPath: getNullableStringValue(record.lastRequestPath),
    proxyCount: getNumberValue(record.proxyCount),
  })

  return {
    ...normalizedRecord,
    connectionId: getStringValue(record.connectionId, normalizedRecord.connectionId),
    firstSeenAt: getStringValue(record.firstSeenAt, normalizedRecord.firstSeenAt),
  }
}

const readWorkerRegistryRecord = async (
  databasePath: string,
  connectionId: string,
): Promise<DuckdbOwnerConnectionStoredRecord | null> => {
  const recordPath = getWorkerRegistryRecordPath(databasePath, connectionId)

  if (recordPath === null) {
    return null
  }

  try {
    const raw = await readFile(recordPath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    return normalizeStoredDuckdbOwnerConnectionRecord(parsed)
  } catch (error) {
    if (isMissingFileError(error) || isJsonSyntaxError(error)) {
      return null
    }

    throw error
  }
}

const writeWorkerRegistryRecord = async (record: DuckdbOwnerConnectionStoredRecord, databasePath = env.DUCKDB_PATH) => {
  const recordPath = getWorkerRegistryRecordPath(databasePath, record.connectionId)
  const storageDirectory = getWorkerRegistryStorageDirectory(databasePath)

  if (recordPath === null || storageDirectory === null) {
    return
  }

  const payload = JSON.stringify({storageVersion: workerRegistryStorageVersion, ...record}, null, 2)

  const persistRecord = async (retriesRemaining: number): Promise<void> => {
    await mkdir(storageDirectory, {recursive: true})
    const temporaryPath = `${recordPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`

    await writeFile(temporaryPath, payload)

    return rename(temporaryPath, recordPath).catch((error: unknown) => {
      if (!isMissingFileError(error) || retriesRemaining <= 0) {
        throw error
      }

      return unlink(temporaryPath)
        .catch(() => {
          return undefined
        })
        .then(() => {
          return persistRecord(retriesRemaining - 1)
        })
    })
  }

  return persistRecord(1)
}

const readWorkerRegistryRecords = async (
  databasePath = env.DUCKDB_PATH,
  nowMs = Date.now(),
): Promise<DuckdbOwnerConnectionStoredRecord[]> => {
  const storageDirectory = getWorkerRegistryStorageDirectory(databasePath)

  if (storageDirectory === null) {
    return databasePath === env.DUCKDB_PATH ? [...duckdbOwnerConnectionState.recordsByConnectionId.values()] : []
  }

  try {
    const fileNames = await readdir(storageDirectory)
    const jsonFileNames = fileNames.filter((fileName) => {
      return fileName.endsWith('.json')
    })
    const records = await Promise.all(
      jsonFileNames.map(async (fileName) => {
        try {
          const raw = await readFile(join(storageDirectory, fileName), 'utf8')
          return normalizeStoredDuckdbOwnerConnectionRecord(JSON.parse(raw) as unknown)
        } catch (error) {
          if (isMissingFileError(error) || isJsonSyntaxError(error)) {
            return null
          }

          throw error
        }
      }),
    )
    const retainedRecords = records.filter((record): record is DuckdbOwnerConnectionStoredRecord => {
      return record !== null && nowMs - new Date(getLastSeenAt(record)).getTime() <= duckdbOwnerConnectionRetentionMs
    })

    await Promise.all(
      records.map(async (record, index) => {
        const fileName = jsonFileNames[index]
        const shouldRemove =
          fileName !== undefined
          && record !== null
          && nowMs - new Date(getLastSeenAt(record)).getTime() > duckdbOwnerConnectionRetentionMs

        return shouldRemove
          ? unlink(join(storageDirectory, fileName)).catch(() => {
              return undefined
            })
          : undefined
      }),
    )

    return retainedRecords
  } catch (error) {
    if (isMissingFileError(error)) {
      return databasePath === env.DUCKDB_PATH ? [...duckdbOwnerConnectionState.recordsByConnectionId.values()] : []
    }

    throw error
  }
}

const getMergedDuckdbOwnerConnectionRecords = async (
  nowMs: number,
  databasePath = env.DUCKDB_PATH,
): Promise<DuckdbOwnerConnectionStoredRecord[]> => {
  const memoryRecords =
    databasePath === env.DUCKDB_PATH ? [...duckdbOwnerConnectionState.recordsByConnectionId.values()] : []
  const records = [...memoryRecords, ...(await readWorkerRegistryRecords(databasePath, nowMs))]

  return records.reduce<DuckdbOwnerConnectionStoredRecord[]>((mergedRecords, record) => {
    const existingIndex = mergedRecords.findIndex((mergedRecord) => {
      return mergedRecord.connectionId === record.connectionId
    })

    if (existingIndex === -1) {
      return [...mergedRecords, record]
    }

    const existingRecord = mergedRecords[existingIndex]
    const nextRecord =
      existingRecord && getLastSeenAt(record).localeCompare(getLastSeenAt(existingRecord)) > 0 ? record : existingRecord

    return mergedRecords.map((mergedRecord, index) => {
      return index === existingIndex ? nextRecord : mergedRecord
    })
  }, [])
}

const getPreviousDuckdbOwnerConnectionRecord = async (
  input: DuckdbOwnerConnectionHeartbeatInput,
  databasePath = env.DUCKDB_PATH,
): Promise<DuckdbOwnerConnectionStoredRecord | undefined> => {
  const connectionId = getDuckdbOwnerConnectionId(input)
  const memoryRecord =
    databasePath === env.DUCKDB_PATH ? duckdbOwnerConnectionState.recordsByConnectionId.get(connectionId) : undefined

  return memoryRecord ?? (await readWorkerRegistryRecord(databasePath, connectionId)) ?? undefined
}

export const upsertDuckdbOwnerConnectionHeartbeat = async (
  input: DuckdbOwnerConnectionHeartbeatInput,
  options: DuckdbOwnerConnectionStorageOptions = {},
): Promise<DuckdbOwnerConnectionRecord> => {
  const nowMs = Date.now()
  const databasePath = options.databasePath ?? env.DUCKDB_PATH
  const previous = await getPreviousDuckdbOwnerConnectionRecord(input, databasePath)
  const nextRecord = getUpdatedDuckdbOwnerConnectionRecord(input, previous, {
    lastHeartbeatAt: new Date(nowMs).toISOString(),
  })

  pruneDuckdbOwnerConnections(nowMs)
  duckdbOwnerConnectionState.recordsByConnectionId.set(nextRecord.connectionId, nextRecord)
  await writeWorkerRegistryRecord(nextRecord, databasePath)
  return toDuckdbOwnerConnectionRecord(nextRecord, nowMs)
}

export const recordDuckdbOwnerConnectionProxy = async (
  headers: Headers,
  requestPath: string,
  options: DuckdbOwnerConnectionStorageOptions = {},
): Promise<DuckdbOwnerConnectionRecord | null> => {
  assertDuckdbOwnerConnectionProxyHeadersCompatible(headers)

  const input = getDuckdbOwnerConnectionIdentityFromHeaders(headers)
  const nowMs = Date.now()

  if (input === null) {
    pruneDuckdbOwnerConnections(nowMs)
    return null
  }

  const databasePath = options.databasePath ?? env.DUCKDB_PATH
  const previous = await getPreviousDuckdbOwnerConnectionRecord(input, databasePath)
  const nextRecord = getUpdatedDuckdbOwnerConnectionRecord(input, previous, {
    lastHeartbeatAt: new Date(nowMs).toISOString(),
    lastProxyAt: new Date(nowMs).toISOString(),
    lastRequestPath: requestPath,
    proxyCount: (previous?.proxyCount ?? 0) + 1,
  })

  pruneDuckdbOwnerConnections(nowMs)
  duckdbOwnerConnectionState.recordsByConnectionId.set(nextRecord.connectionId, nextRecord)
  await writeWorkerRegistryRecord(nextRecord, databasePath)
  return toDuckdbOwnerConnectionRecord(nextRecord, nowMs)
}

const getOwnerFreshnessFromLease = (lease: DuckdbOwnerLeaseMetadata | null) => {
  return lease === null
    ? 'owner_missing'
    : !isDuckdbOwnerLeaseProcessAlive(lease)
      ? 'owner_dead'
      : isDuckdbOwnerLeaseStale(lease)
        ? 'owner_stale'
        : 'owner_fresh'
}

const getCurrentWorkerRegistryTakeoverState = async (): Promise<WorkerRegistryTakeoverState> => {
  try {
    const lease = await Effect.runPromise(readDuckdbOwnerLease(env.DUCKDB_PATH))
    const ownerFreshness = getOwnerFreshnessFromLease(lease)
    const isCandidate = isAutoServerRole(env.SERVER_ROLE) && !canCurrentServerOwnDuckdb()
    const intent = !isCandidate ? 'none' : ownerFreshness === 'owner_fresh' ? 'standby' : 'takeover_in_progress'

    return {
      candidate: isCandidate,
      intent,
      observedAt: new Date().toISOString(),
      ownerFreshness,
      ownerHeartbeatAt: lease?.heartbeatAt ?? null,
      ownerLeaseId: lease?.leaseId ?? null,
      ownerUrl: lease === null ? getKnownDuckdbOwnerUrl() : getDuckdbOwnerLeaseUrl(lease),
    }
  } catch {
    return {
      ...getDefaultTakeoverState(),
      candidate: isAutoServerRole(env.SERVER_ROLE) && !canCurrentServerOwnDuckdb(),
      ownerFreshness: 'owner_unknown',
    }
  }
}

const getCurrentDuckdbOwnerConnectionHeartbeatIdentity = async (): Promise<DuckdbOwnerConnectionIdentity> => {
  return {...getCurrentDuckdbOwnerConnectionIdentity(), takeover: await getCurrentWorkerRegistryTakeoverState()}
}

const getDuckdbOwnerRecordFromRecords = (
  records: DuckdbOwnerConnectionRecord[],
): DuckdbOwnerConnectionRecord | null => {
  const [ownerRecord] = records
    .filter((record) => {
      return record.capabilities.includes('duckdb-owner')
    })
    .sort((left, right) => {
      return right.lastSeenAt.localeCompare(left.lastSeenAt)
    })

  return ownerRecord ?? null
}

export const getDuckdbOwnerConnectionsOverview = async (
  options: DuckdbOwnerConnectionStorageOptions = {},
): Promise<DuckdbOwnerConnectionsOverview> => {
  const nowMs = Date.now()
  const databasePath = options.databasePath ?? env.DUCKDB_PATH
  const history = await Effect.runPromise(readDuckdbOwnerLeaseHistory(databasePath))
  const warnings = isCurrentServerDuckdbOwnerProxyDisabled()
    ? [getOwnerProxyDisabledWarning(), ...getDuckdbOwnerWarnings()]
    : getDuckdbOwnerWarnings()
  const storedRecords = await getMergedDuckdbOwnerConnectionRecords(nowMs, databasePath)
  const currentOwner = canCurrentServerOwnDuckdb()
    ? await upsertDuckdbOwnerConnectionHeartbeat(await getDuckdbOwnerConnectionHeartbeatPayload(), {databasePath})
    : null
  const storedConnectionRecords = storedRecords.map((record) => {
    return toDuckdbOwnerConnectionRecord(record, nowMs)
  })
  const allRecords: DuckdbOwnerConnectionRecord[] = (
    currentOwner === null ? storedConnectionRecords : [currentOwner, ...storedConnectionRecords]
  ).sort((a, b) => {
    return b.lastSeenAt.localeCompare(a.lastSeenAt)
  })

  pruneDuckdbOwnerConnections(nowMs)
  const owner = currentOwner ?? getDuckdbOwnerRecordFromRecords(allRecords)
  const followers = allRecords.filter((record) => {
    return owner === null || record.connectionId !== owner.connectionId
  })

  return {
    followers,
    history,
    registry: getRuntimeCapabilityRegistryOverview(allRecords),
    runtimeVersion: getRuntimeCutoverVersion(),
    warnings,
    owner,
  }
}

export const getDuckdbOwnerConnectionHeartbeatPayload = async (): Promise<DuckdbOwnerConnectionIdentity> => {
  return getCurrentDuckdbOwnerConnectionHeartbeatIdentity()
}

export const resetDuckdbOwnerConnectionsForTests = async (options: DuckdbOwnerConnectionStorageOptions = {}) => {
  const databasePath = options.databasePath ?? env.DUCKDB_PATH
  const storageDirectory = getWorkerRegistryStorageDirectory(databasePath)

  duckdbOwnerConnectionState.recordsByConnectionId.clear()

  if (storageDirectory !== null) {
    await rm(storageDirectory, {force: true, recursive: true})
  }
}
