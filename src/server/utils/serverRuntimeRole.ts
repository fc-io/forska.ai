import {Effect} from 'effect'

import {
  acquireDuckdbOwnerLease,
  type DuckdbOwnerLease,
  getDuckdbOwnerLeaseUrl,
  isDuckdbOwnerLeaseOwnedByCurrentProcess,
  isDuckdbOwnerLeaseProcessAlive,
  isDuckdbOwnerLeaseStale,
  readDuckdbOwnerLease,
  releaseDuckdbOwnerLease,
  updateDuckdbOwnerLeaseHeartbeat,
} from './duckdbOwnerLease.ts'
import {clearUnresponsiveDuckdbOwnerWarnings, recordUnresponsiveDuckdbOwnerWarning} from './duckdbOwnerWarnings.ts'
import {getEnv} from './env.ts'
import {createRateLimitedLogger} from './rateLimitedLogger.ts'
import {
  assertReachableDuckdbOwnerCutoverCompatible,
  getRuntimeCutoverVersionMismatchMessage,
  isRuntimeCutoverVersionCompatible,
  probeDuckdbOwnerCutoverCompatibility,
} from './runtimeCutover.ts'
import {exitWithRuntimeLogFlush} from './runtimeLogger.ts'
import {shouldDisableServerMutationWork} from './serverMutationMode.ts'
import {
  canServerRoleOwnDuckdb,
  canServerRoleProxyApiToOwner,
  canServerRoleRunJudgingLoops,
  canServerRoleRunMaintenanceLoops,
  type EffectiveServerRole,
  getEffectiveServerRole,
  isAutoServerRole,
  shouldServerRoleMountDuckdbOwnerPrivateApi,
  shouldServerRoleMountPublicProductApi,
} from './serverRole.ts'

type ServerRuntimeState = {
  autoMonitorStarted: boolean
  currentLease: DuckdbOwnerLease | null
  currentRole: EffectiveServerRole
  ownerLeaseHeartbeatMonitor: ReturnType<typeof setInterval> | null
  ownerLeaseHeartbeatPromise: Promise<void> | null
  lastKnownDuckdbOwnerUrl: string | null
  duckdbOwnerDemotionHandlers: Array<(reason: string) => Promise<void> | void>
}

declare global {
  var __forskaServerRuntimeState: ServerRuntimeState | undefined
}

const autoServerRolePollIntervalMs = 5_000
const autoServerRoleLogger = createRateLimitedLogger({windowMs: 30_000})
const duckdbRoleErrorFragments = ['cannot own DuckDB', 'DuckDB owner lease is no longer owned by this process']
const getRuntimeEnv = () => {
  return getEnv()
}

const getRuntimeRoleErrorMessage = (error: unknown) => {
  return error instanceof Error
    ? error.message
    : typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
      ? error.message
      : String(error)
}

const isDuckdbOwnerRoleLossError = (error: unknown) => {
  const message = getRuntimeRoleErrorMessage(error)

  return duckdbRoleErrorFragments.some((fragment) => {
    return message.includes(fragment)
  })
}

const getServerRuntimeState = () => {
  globalThis.__forskaServerRuntimeState ??= {
    autoMonitorStarted: false,
    currentLease: null,
    currentRole: getEffectiveServerRole(getRuntimeEnv().SERVER_ROLE),
    ownerLeaseHeartbeatMonitor: null,
    ownerLeaseHeartbeatPromise: null,
    lastKnownDuckdbOwnerUrl: null,
    duckdbOwnerDemotionHandlers: [],
  }

  return globalThis.__forskaServerRuntimeState
}

const serverRuntimeState = getServerRuntimeState()

const getCurrentServerUrl = () => {
  return `http://127.0.0.1:${getRuntimeEnv().API_SERVER_PORT}`
}

const getCurrentServerLocalhostUrl = () => {
  return `http://localhost:${getRuntimeEnv().API_SERVER_PORT}`
}

const getNormalizedDuckdbOwnerUrl = (value: string | null | undefined) => {
  const raw = String(value ?? '').trim()
  return raw === '' ? null : raw.endsWith('/') ? raw.slice(0, -1) : raw
}

const isCurrentServerUrl = (duckdbOwnerUrl: string | null | undefined) => {
  const normalizedDuckdbOwnerUrl = getNormalizedDuckdbOwnerUrl(duckdbOwnerUrl)

  return (
    normalizedDuckdbOwnerUrl === getCurrentServerUrl() || normalizedDuckdbOwnerUrl === getCurrentServerLocalhostUrl()
  )
}

const exitForDuplicateLocalServer = (reason: string, duckdbOwnerUrl: string | null) => {
  if (!isCurrentServerUrl(duckdbOwnerUrl)) {
    return false
  }

  autoServerRoleLogger.force(
    'server-role:duplicate-local-server',
    `[server] duplicate local API server detected; exiting (${reason})`,
    'warn',
    {apiServerPort: getRuntimeEnv().API_SERVER_PORT, duckdbOwnerUrl, pid: process.pid},
  )
  void exitWithRuntimeLogFlush({code: 0})
  return true
}

const getManualDuckdbOwnerUrl = () => {
  return getNormalizedDuckdbOwnerUrl(getRuntimeEnv().SERVER_DUCKDB_OWNER_URL)
}

const isDuckdbOwnerProxyDisabledByConfig = () => {
  return (
    !isAutoServerRole(getRuntimeEnv().SERVER_ROLE)
    && shouldCurrentServerProxyApiToOwner()
    && getManualDuckdbOwnerUrl() === null
  )
}

const setCurrentServerRole = (nextRole: EffectiveServerRole) => {
  serverRuntimeState.currentRole = nextRole
}

const setLastKnownDuckdbOwnerUrl = (duckdbOwnerUrl: string | null) => {
  serverRuntimeState.lastKnownDuckdbOwnerUrl = duckdbOwnerUrl
}

const isDuckdbOwnerUrlResponsive = async (duckdbOwnerUrl: string) => {
  const result = await probeDuckdbOwnerCutoverCompatibility(duckdbOwnerUrl, 'DuckDB owner URL')

  if (result.status === 'incompatible') {
    throw new Error(result.message)
  }

  return result.status === 'compatible'
}

const runDuckdbOwnerDemotionHandlers = async (reason: string) => {
  await Promise.all(
    serverRuntimeState.duckdbOwnerDemotionHandlers.map(async (handler) => {
      return handler(reason)
    }),
  )
}

const shouldPromoteForStaleDuckdbOwnerLease = async (currentLease: DuckdbOwnerLease['metadata']) => {
  if (!isDuckdbOwnerLeaseStale(currentLease)) {
    return false
  }

  const duckdbOwnerUrl = getDuckdbOwnerLeaseUrl(currentLease)
  const isResponsive = await isDuckdbOwnerUrlResponsive(duckdbOwnerUrl)

  if (isResponsive) {
    autoServerRoleLogger.warn(
      'server-role:stale-duckdb-owner',
      '[server] stale DuckDB owner heartbeat but HTTP still responds',
      {duckdbOwnerUrl},
    )
  }

  return !isResponsive
}

const assertIncompatibleDuckdbOwnerLeaseIsReplaceable = async (currentLease: DuckdbOwnerLease['metadata']) => {
  if (isRuntimeCutoverVersionCompatible(currentLease.runtimeVersion)) {
    return
  }

  if (!isDuckdbOwnerLeaseStale(currentLease)) {
    throw new Error(
      `${getRuntimeCutoverVersionMismatchMessage({
        context: `DuckDB owner lease at ${getDuckdbOwnerLeaseUrl(currentLease)}`,
        runtimeVersion: currentLease.runtimeVersion,
      })} The incompatible lease is fresh.`,
    )
  }

  const result = await probeDuckdbOwnerCutoverCompatibility(
    getDuckdbOwnerLeaseUrl(currentLease),
    'legacy DuckDB owner lease',
  )

  if (result.status !== 'unreachable') {
    throw new Error(
      `${getRuntimeCutoverVersionMismatchMessage({
        context: `DuckDB owner lease at ${getDuckdbOwnerLeaseUrl(currentLease)}`,
        runtimeVersion: currentLease.runtimeVersion,
      })} The incompatible peer is still reachable.`,
    )
  }
}

const recordDuckdbOwnerUnavailableWarning = (params: {
  reason: 'duckdb-owner-heartbeat-stale' | 'duckdb-owner-process-dead'
  duckdbOwnerUrl: string
}) => {
  return recordUnresponsiveDuckdbOwnerWarning({
    message:
      params.reason === 'duckdb-owner-process-dead'
        ? `DuckDB owner process at ${params.duckdbOwnerUrl} stopped responding and a follower takeover started.`
        : `DuckDB owner at ${params.duckdbOwnerUrl} had a stale heartbeat and did not answer HTTP health checks.`,
  })
}

const readDuckdbOwnerUrlFromLease = async () => {
  const metadata = await Effect.runPromise(readDuckdbOwnerLease(getRuntimeEnv().DUCKDB_PATH))
  const duckdbOwnerUrl = metadata === null ? null : getDuckdbOwnerLeaseUrl(metadata)

  setLastKnownDuckdbOwnerUrl(duckdbOwnerUrl)
  return duckdbOwnerUrl
}

const refreshExplicitDuckdbOwnerLease = async () => {
  const currentLease = serverRuntimeState.currentLease

  if (currentLease === null || isAutoServerRole(getRuntimeEnv().SERVER_ROLE) || !canCurrentServerOwnDuckdb()) {
    return
  }

  try {
    serverRuntimeState.currentLease = await Effect.runPromise(updateDuckdbOwnerLeaseHeartbeat(currentLease))
    setLastKnownDuckdbOwnerUrl(getCurrentServerUrl())
  } catch (error) {
    if (isDuckdbOwnerRoleLossError(error)) {
      serverRuntimeState.currentLease = null
      setCurrentServerRole('api')
      await runDuckdbOwnerDemotionHandlers('lease-lost')
      await readDuckdbOwnerUrlFromLease()
    }

    autoServerRoleLogger.warn(
      'server-role:explicit-duckdb-owner-heartbeat',
      '[server] explicit DuckDB owner lease heartbeat failed',
      error,
    )
  }
}

const startExplicitDuckdbOwnerLeaseHeartbeatMonitor = () => {
  if (isAutoServerRole(getRuntimeEnv().SERVER_ROLE) || serverRuntimeState.ownerLeaseHeartbeatMonitor !== null) {
    return
  }

  const interval = setInterval(() => {
    if (serverRuntimeState.ownerLeaseHeartbeatPromise !== null) {
      return
    }

    serverRuntimeState.ownerLeaseHeartbeatPromise = refreshExplicitDuckdbOwnerLease().finally(() => {
      serverRuntimeState.ownerLeaseHeartbeatPromise = null
    })
  }, autoServerRolePollIntervalMs)

  interval.unref?.()
  serverRuntimeState.ownerLeaseHeartbeatMonitor = interval
}

const stopExplicitDuckdbOwnerLeaseHeartbeatMonitor = async () => {
  const currentMonitor = serverRuntimeState.ownerLeaseHeartbeatMonitor
  serverRuntimeState.ownerLeaseHeartbeatMonitor = null

  if (currentMonitor !== null) {
    clearInterval(currentMonitor)
  }

  const currentPromise = serverRuntimeState.ownerLeaseHeartbeatPromise

  if (currentPromise !== null) {
    await currentPromise
  }
}

const promoteAutoServerToDuckdbOwner = async (reason: string, takeoverLeaseId?: string) => {
  try {
    const currentLease = await Effect.runPromise(
      acquireDuckdbOwnerLease({
        apiServerPort: getRuntimeEnv().API_SERVER_PORT,
        databasePath: getRuntimeEnv().DUCKDB_PATH,
        serverRole: 'maintenance-worker',
        takeoverLeaseId,
      }),
    )

    serverRuntimeState.currentLease = currentLease
    setCurrentServerRole('maintenance-worker')
    setLastKnownDuckdbOwnerUrl(getCurrentServerUrl())
    clearUnresponsiveDuckdbOwnerWarnings()
    autoServerRoleLogger.force('server-role:duckdb-owner', `[server] auto DuckDB owner active (${reason})`, 'log', {
      apiServerPort: getRuntimeEnv().API_SERVER_PORT,
      reason,
    })
    return true
  } catch (error) {
    const duckdbOwnerUrl = await readDuckdbOwnerUrlFromLease()

    setCurrentServerRole('api')
    autoServerRoleLogger.log('server-role:api', '[server] auto follower active', {duckdbOwnerUrl, error})
    if (exitForDuplicateLocalServer(reason, duckdbOwnerUrl)) {
      return false
    }
    return false
  }
}

const resumeAutoDuckdbOwnerLeaseForCurrentProcess = async () => {
  const currentLease = await Effect.runPromise(
    acquireDuckdbOwnerLease({
      apiServerPort: getRuntimeEnv().API_SERVER_PORT,
      databasePath: getRuntimeEnv().DUCKDB_PATH,
      serverRole: 'maintenance-worker',
    }),
  )

  serverRuntimeState.currentLease = currentLease
  setCurrentServerRole('maintenance-worker')
  setLastKnownDuckdbOwnerUrl(getCurrentServerUrl())
  clearUnresponsiveDuckdbOwnerWarnings()
  autoServerRoleLogger.force(
    'server-role:duckdb-owner-resume',
    '[server] auto DuckDB owner resumed from existing same-process lease',
    'log',
    {apiServerPort: getRuntimeEnv().API_SERVER_PORT, pid: process.pid},
  )
}

const refreshAutoDuckdbOwnerLease = async () => {
  if (serverRuntimeState.currentLease === null) {
    await promoteAutoServerToDuckdbOwner('duckdb-owner-missing-lease')
    return
  }

  try {
    const nextLease = await Effect.runPromise(updateDuckdbOwnerLeaseHeartbeat(serverRuntimeState.currentLease))
    serverRuntimeState.currentLease = nextLease
    setLastKnownDuckdbOwnerUrl(getCurrentServerUrl())
    clearUnresponsiveDuckdbOwnerWarnings()
  } catch (error) {
    serverRuntimeState.currentLease = null
    setCurrentServerRole('api')
    await runDuckdbOwnerDemotionHandlers('lease-lost')
    await readDuckdbOwnerUrlFromLease()
    autoServerRoleLogger.warn('server-role:lost-duckdb-owner', '[server] auto DuckDB owner lease lost', error)
  }
}

const refreshAutoFollowerRole = async () => {
  const currentLease = await Effect.runPromise(readDuckdbOwnerLease(getRuntimeEnv().DUCKDB_PATH))

  if (currentLease !== null && isDuckdbOwnerLeaseOwnedByCurrentProcess(currentLease)) {
    await resumeAutoDuckdbOwnerLeaseForCurrentProcess()
    return
  }

  if (currentLease !== null) {
    await assertIncompatibleDuckdbOwnerLeaseIsReplaceable(currentLease)
  }

  const shouldPromoteForDeadDuckdbOwner = currentLease !== null && !isDuckdbOwnerLeaseProcessAlive(currentLease)
  const shouldPromoteForStaleDuckdbOwner =
    currentLease !== null && (await shouldPromoteForStaleDuckdbOwnerLease(currentLease))

  if (currentLease === null || shouldPromoteForDeadDuckdbOwner || shouldPromoteForStaleDuckdbOwner) {
    const reason =
      currentLease === null
        ? 'lease-missing'
        : shouldPromoteForDeadDuckdbOwner
          ? 'duckdb-owner-process-dead'
          : 'duckdb-owner-heartbeat-stale'

    if (currentLease !== null && reason !== 'lease-missing') {
      recordDuckdbOwnerUnavailableWarning({reason, duckdbOwnerUrl: getDuckdbOwnerLeaseUrl(currentLease)})
    }

    await promoteAutoServerToDuckdbOwner(reason, currentLease?.leaseId)
    return
  }

  setCurrentServerRole('api')
  setLastKnownDuckdbOwnerUrl(getDuckdbOwnerLeaseUrl(currentLease))

  if (exitForDuplicateLocalServer('duckdb-owner-already-active-on-local-port', getDuckdbOwnerLeaseUrl(currentLease))) {
    return
  }

  if (await isDuckdbOwnerUrlResponsive(getDuckdbOwnerLeaseUrl(currentLease))) {
    clearUnresponsiveDuckdbOwnerWarnings()
  }
}

const syncAutoServerRole = async () => {
  if (!isAutoServerRole(getRuntimeEnv().SERVER_ROLE)) {
    return
  }

  if (canCurrentServerOwnDuckdb()) {
    await refreshAutoDuckdbOwnerLease()
    return
  }

  await refreshAutoFollowerRole()
}

export const initializeServerRuntimeRole = async () => {
  if (isAutoServerRole(getRuntimeEnv().SERVER_ROLE)) {
    await syncAutoServerRole()
    return
  }

  const env = getRuntimeEnv()

  setCurrentServerRole(getEffectiveServerRole(env.SERVER_ROLE))
  setLastKnownDuckdbOwnerUrl(
    canServerRoleOwnDuckdb(env.SERVER_ROLE) ? getCurrentServerUrl() : getManualDuckdbOwnerUrl(),
  )

  const manualDuckdbOwnerUrl = getManualDuckdbOwnerUrl()

  if (shouldCurrentServerProxyApiToOwner() && manualDuckdbOwnerUrl !== null) {
    await assertReachableDuckdbOwnerCutoverCompatible(manualDuckdbOwnerUrl, 'configured DuckDB owner URL')
  }
}

export const startServerRuntimeRoleMonitor = () => {
  if (!isAutoServerRole(getRuntimeEnv().SERVER_ROLE) || serverRuntimeState.autoMonitorStarted) {
    return
  }

  serverRuntimeState.autoMonitorStarted = true

  const interval = setInterval(() => {
    return void syncAutoServerRole().catch((error) => {
      return autoServerRoleLogger.warn('server-role:monitor', '[server] auto role sync failed', error)
    })
  }, autoServerRolePollIntervalMs)

  interval.unref()
}

export const getCurrentServerRole = (): EffectiveServerRole => {
  return serverRuntimeState.currentRole
}

export const canCurrentServerOwnDuckdb = () => {
  return canServerRoleOwnDuckdb(getCurrentServerRole())
}

export const shouldCurrentServerRunMaintenanceLoops = () => {
  return !shouldDisableServerMutationWork() && canServerRoleRunMaintenanceLoops(getCurrentServerRole())
}

export const canCurrentServerRunMaintenanceLoops = shouldCurrentServerRunMaintenanceLoops

export const shouldCurrentServerRunMaintenanceWork = shouldCurrentServerRunMaintenanceLoops

export const shouldCurrentServerRunJudgingLoops = () => {
  return !shouldDisableServerMutationWork() && canServerRoleRunJudgingLoops(getCurrentServerRole())
}

export const canCurrentServerRunJudgingLoops = shouldCurrentServerRunJudgingLoops

export const shouldCurrentServerRunJudgingWork = shouldCurrentServerRunJudgingLoops

export const shouldCurrentServerRunDuckdbOwnerWork = () => {
  return canCurrentServerOwnDuckdb()
}

export const shouldCurrentServerProxyApiToOwner = () => {
  return canServerRoleProxyApiToOwner(getCurrentServerRole())
}

export const shouldCurrentServerProxyApiToDuckdbOwner = shouldCurrentServerProxyApiToOwner

export const shouldCurrentServerMountPublicProductApi = () => {
  return shouldServerRoleMountPublicProductApi(getCurrentServerRole())
}

export const shouldCurrentServerMountDuckdbOwnerPrivateApi = () => {
  return shouldServerRoleMountDuckdbOwnerPrivateApi(getCurrentServerRole())
}

export const isExpectedDuckdbOwnerRoleLossError = (error: unknown) => {
  return isDuckdbOwnerRoleLossError(error)
}

export const isCurrentServerDuckdbOwnerProxyDisabled = () => {
  return isDuckdbOwnerProxyDisabledByConfig()
}

export const getCurrentServerDuckdbOwnerUrl = async () => {
  if (canCurrentServerOwnDuckdb()) {
    return getCurrentServerUrl()
  }

  if (!shouldCurrentServerProxyApiToOwner()) {
    return null
  }

  if (!isAutoServerRole(getRuntimeEnv().SERVER_ROLE)) {
    const manualDuckdbOwnerUrl = getManualDuckdbOwnerUrl()

    setLastKnownDuckdbOwnerUrl(manualDuckdbOwnerUrl)
    return manualDuckdbOwnerUrl
  }

  await syncAutoServerRole()
  return canCurrentServerOwnDuckdb() ? null : readDuckdbOwnerUrlFromLease()
}

export const getCurrentServerWorkerRegistryOwnerUrl = async () => {
  if (canCurrentServerOwnDuckdb()) {
    return getCurrentServerUrl()
  }

  const manualDuckdbOwnerUrl = getManualDuckdbOwnerUrl()

  if (manualDuckdbOwnerUrl !== null) {
    setLastKnownDuckdbOwnerUrl(manualDuckdbOwnerUrl)
    return manualDuckdbOwnerUrl
  }

  if (!isAutoServerRole(getRuntimeEnv().SERVER_ROLE)) {
    return null
  }

  await syncAutoServerRole()
  return canCurrentServerOwnDuckdb() ? getCurrentServerUrl() : readDuckdbOwnerUrlFromLease()
}

export const getKnownDuckdbOwnerUrl = () => {
  return canCurrentServerOwnDuckdb() ? getCurrentServerUrl() : serverRuntimeState.lastKnownDuckdbOwnerUrl
}

export const ensureCurrentDuckdbOwnerLease = async () => {
  if (!canCurrentServerOwnDuckdb()) {
    throw new Error(`Current server role ${getCurrentServerRole()} cannot own DuckDB`)
  }

  if (serverRuntimeState.currentLease !== null) {
    startExplicitDuckdbOwnerLeaseHeartbeatMonitor()
    return serverRuntimeState.currentLease
  }

  const nextLease = await Effect.runPromise(
    acquireDuckdbOwnerLease({
      apiServerPort: getRuntimeEnv().API_SERVER_PORT,
      databasePath: getRuntimeEnv().DUCKDB_PATH,
      serverRole: getCurrentServerRole(),
    }),
  )

  serverRuntimeState.currentLease = nextLease
  setLastKnownDuckdbOwnerUrl(getCurrentServerUrl())
  startExplicitDuckdbOwnerLeaseHeartbeatMonitor()
  return nextLease
}

export const releaseCurrentDuckdbOwnerLease = async () => {
  await stopExplicitDuckdbOwnerLeaseHeartbeatMonitor()

  const currentLease = serverRuntimeState.currentLease
  serverRuntimeState.currentLease = null

  if (currentLease === null) {
    return
  }

  await Effect.runPromise(releaseDuckdbOwnerLease(currentLease))
}

export const registerDuckdbOwnerDemotionHandler = (handler: (reason: string) => Promise<void> | void) => {
  serverRuntimeState.duckdbOwnerDemotionHandlers = [...serverRuntimeState.duckdbOwnerDemotionHandlers, handler]
}

export const resetServerRuntimeRoleForTests = () => {
  const env = getRuntimeEnv()

  if (serverRuntimeState.ownerLeaseHeartbeatMonitor !== null) {
    clearInterval(serverRuntimeState.ownerLeaseHeartbeatMonitor)
  }

  serverRuntimeState.autoMonitorStarted = false
  serverRuntimeState.currentLease = null
  serverRuntimeState.currentRole = getEffectiveServerRole(env.SERVER_ROLE)
  serverRuntimeState.ownerLeaseHeartbeatMonitor = null
  serverRuntimeState.ownerLeaseHeartbeatPromise = null
  serverRuntimeState.lastKnownDuckdbOwnerUrl = null
  serverRuntimeState.duckdbOwnerDemotionHandlers = []
}

export const withCurrentServerRoleOverride = async <_T>(nextRole: EffectiveServerRole, work: () => Promise<_T>) => {
  const previousRole = serverRuntimeState.currentRole
  const previousDuckdbOwnerUrl = serverRuntimeState.lastKnownDuckdbOwnerUrl

  setCurrentServerRole(nextRole)
  setLastKnownDuckdbOwnerUrl(canServerRoleOwnDuckdb(nextRole) ? getCurrentServerUrl() : previousDuckdbOwnerUrl)

  try {
    return await work()
  } finally {
    setCurrentServerRole(previousRole)
    setLastKnownDuckdbOwnerUrl(previousDuckdbOwnerUrl)
  }
}
