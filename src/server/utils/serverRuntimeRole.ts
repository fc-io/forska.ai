import {Effect} from 'effect'

import {
  acquireDuckdbOwnerLease,
  type DuckdbOwnerLease,
  getDuckdbOwnerLeaseWriterUrl,
  isDuckdbOwnerLeaseProcessAlive,
  readDuckdbOwnerLease,
  releaseDuckdbOwnerLease,
  updateDuckdbOwnerLeaseHeartbeat,
} from './duckdbOwnerLease.ts'
import {env} from './env.ts'
import {createRateLimitedLogger} from './rateLimitedLogger.ts'
import {
  canServerRoleOwnDuckdb,
  type EffectiveServerRole,
  getEffectiveServerRole,
  isAutoServerRole,
} from './serverRole.ts'

type ServerRuntimeState = {
  autoMonitorStarted: boolean
  currentLease: DuckdbOwnerLease | null
  currentRole: EffectiveServerRole
  lastKnownWriterUrl: string | null
}

declare global {
  var __forskaServerRuntimeState: ServerRuntimeState | undefined
}

const autoServerRolePollIntervalMs = 5_000
const autoServerRoleLogger = createRateLimitedLogger({windowMs: 30_000})

const getServerRuntimeState = () => {
  globalThis.__forskaServerRuntimeState ??= {
    autoMonitorStarted: false,
    currentLease: null,
    currentRole: getEffectiveServerRole(env.SERVER_ROLE),
    lastKnownWriterUrl: null,
  }

  return globalThis.__forskaServerRuntimeState
}

const serverRuntimeState = getServerRuntimeState()

const getCurrentServerUrl = () => {
  return `http://127.0.0.1:${env.API_SERVER_PORT}`
}

const getNormalizedWriterUrl = (value: string | null | undefined) => {
  const raw = String(value ?? '').trim()
  return raw === '' ? null : raw.endsWith('/') ? raw.slice(0, -1) : raw
}

const getManualWriterUrl = () => {
  return getNormalizedWriterUrl(env.SERVER_WRITER_URL)
}

const setCurrentServerRole = (nextRole: EffectiveServerRole) => {
  serverRuntimeState.currentRole = nextRole
}

const setLastKnownWriterUrl = (writerUrl: string | null) => {
  serverRuntimeState.lastKnownWriterUrl = writerUrl
}

const readWriterUrlFromLease = async () => {
  const metadata = await Effect.runPromise(readDuckdbOwnerLease(env.DUCKDB_PATH))
  const writerUrl = metadata === null ? null : getDuckdbOwnerLeaseWriterUrl(metadata)

  setLastKnownWriterUrl(writerUrl)
  return writerUrl
}

const promoteAutoServerToWriter = async (reason: string) => {
  try {
    const currentLease = await Effect.runPromise(
      acquireDuckdbOwnerLease({
        apiServerPort: env.API_SERVER_PORT,
        databasePath: env.DUCKDB_PATH,
        serverRole: 'writer',
      }),
    )

    serverRuntimeState.currentLease = currentLease
    setCurrentServerRole('writer')
    setLastKnownWriterUrl(getCurrentServerUrl())
    autoServerRoleLogger.force('server-role:writer', `[server] auto writer active (${reason})`, 'log', {
      apiServerPort: env.API_SERVER_PORT,
      reason,
    })
    return true
  } catch (error) {
    const writerUrl = await readWriterUrlFromLease()

    setCurrentServerRole('api')
    autoServerRoleLogger.log('server-role:api', '[server] auto follower active', {error, writerUrl})
    return false
  }
}

const refreshAutoWriterLease = async () => {
  if (serverRuntimeState.currentLease === null) {
    await promoteAutoServerToWriter('writer-missing-lease')
    return
  }

  try {
    const nextLease = await Effect.runPromise(updateDuckdbOwnerLeaseHeartbeat(serverRuntimeState.currentLease))
    serverRuntimeState.currentLease = nextLease
    setLastKnownWriterUrl(getCurrentServerUrl())
  } catch (error) {
    serverRuntimeState.currentLease = null
    setCurrentServerRole('api')
    autoServerRoleLogger.warn('server-role:lost-writer', '[server] auto writer lease lost', error)
  }
}

const refreshAutoFollowerRole = async () => {
  const currentLease = await Effect.runPromise(readDuckdbOwnerLease(env.DUCKDB_PATH))

  if (currentLease === null || !isDuckdbOwnerLeaseProcessAlive(currentLease)) {
    await promoteAutoServerToWriter(currentLease === null ? 'lease-missing' : 'writer-process-dead')
    return
  }

  setCurrentServerRole('api')
  setLastKnownWriterUrl(getDuckdbOwnerLeaseWriterUrl(currentLease))
}

const syncAutoServerRole = async () => {
  if (!isAutoServerRole(env.SERVER_ROLE)) {
    return
  }

  if (serverRuntimeState.currentRole === 'writer') {
    await refreshAutoWriterLease()
    return
  }

  await refreshAutoFollowerRole()
}

export const initializeServerRuntimeRole = async () => {
  if (isAutoServerRole(env.SERVER_ROLE)) {
    await syncAutoServerRole()
    return
  }

  setCurrentServerRole(getEffectiveServerRole(env.SERVER_ROLE))
  setLastKnownWriterUrl(canServerRoleOwnDuckdb(env.SERVER_ROLE) ? getCurrentServerUrl() : getManualWriterUrl())
}

export const startServerRuntimeRoleMonitor = () => {
  if (!isAutoServerRole(env.SERVER_ROLE) || serverRuntimeState.autoMonitorStarted) {
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

export const shouldCurrentServerRunWriterWork = () => {
  return canCurrentServerOwnDuckdb()
}

export const shouldCurrentServerProxyApiToWriter = () => {
  return getCurrentServerRole() === 'api'
}

export const getCurrentServerWriterUrl = async () => {
  if (canCurrentServerOwnDuckdb()) {
    return getCurrentServerUrl()
  }

  if (!shouldCurrentServerProxyApiToWriter()) {
    return null
  }

  if (!isAutoServerRole(env.SERVER_ROLE)) {
    const manualWriterUrl = getManualWriterUrl()

    setLastKnownWriterUrl(manualWriterUrl)
    return manualWriterUrl
  }

  await syncAutoServerRole()
  return canCurrentServerOwnDuckdb() ? null : readWriterUrlFromLease()
}

export const getKnownWriterUrl = () => {
  return canCurrentServerOwnDuckdb() ? getCurrentServerUrl() : serverRuntimeState.lastKnownWriterUrl
}

export const ensureCurrentDuckdbOwnerLease = async () => {
  if (!canCurrentServerOwnDuckdb()) {
    throw new Error(`Current server role ${getCurrentServerRole()} cannot own DuckDB`)
  }

  if (serverRuntimeState.currentLease !== null) {
    return serverRuntimeState.currentLease
  }

  const nextLease = await Effect.runPromise(
    acquireDuckdbOwnerLease({
      apiServerPort: env.API_SERVER_PORT,
      databasePath: env.DUCKDB_PATH,
      serverRole: getCurrentServerRole(),
    }),
  )

  serverRuntimeState.currentLease = nextLease
  setLastKnownWriterUrl(getCurrentServerUrl())
  return nextLease
}

export const releaseCurrentDuckdbOwnerLease = async () => {
  const currentLease = serverRuntimeState.currentLease
  serverRuntimeState.currentLease = null

  if (currentLease === null) {
    return
  }

  await Effect.runPromise(releaseDuckdbOwnerLease(currentLease))
}
