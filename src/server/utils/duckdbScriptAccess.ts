import {Effect} from 'effect'

import {type AppDatabaseSnapshot, getAppDatabaseService} from '../services/appDatabaseService.ts'
import {
  getDuckdbOwnerLeaseUrl,
  isDuckdbOwnerLeaseProcessAlive,
  isDuckdbOwnerLeaseStale,
  readDuckdbOwnerLease,
} from './duckdbOwnerLease.ts'
import {env} from './env.ts'
import {ensureCurrentDuckdbOwnerLease, withCurrentServerRoleOverride} from './serverRuntimeRole.ts'

type DuckdbScriptAccessSnapshotResponse = {data?: AppDatabaseSnapshot; error?: string}

class DuckdbSnapshotRouteUnavailableError extends Error {}

const duckdbOwnerPrivateApiPrefix = '/__duckdb-owner-rpc'
const duckdbStudioSnapshotPath = '/api/duckdbStudioSnapshots'

const getDuckdbOwnerHealthUrl = (duckdbOwnerUrl: string) => {
  return `${duckdbOwnerUrl}/api/duckdb_owner_connections`
}

const getNormalizedDuckdbOwnerUrl = (value: string | null | undefined) => {
  const raw = String(value ?? '').trim()
  return raw === '' ? null : raw.endsWith('/') ? raw.slice(0, -1) : raw
}

const getDuckdbStudioUrl = (duckdbOwnerUrl: string) => {
  return `${duckdbOwnerUrl}${duckdbOwnerPrivateApiPrefix}${duckdbStudioSnapshotPath}`
}

const getDuckdbStudioUrls = async () => {
  const currentLease = await Effect.runPromise(readDuckdbOwnerLease(env.DUCKDB_PATH))
  const leaseDuckdbOwnerUrl = currentLease === null ? null : getDuckdbOwnerLeaseUrl(currentLease)
  const configuredDuckdbOwnerUrl = getNormalizedDuckdbOwnerUrl(env.SERVER_DUCKDB_OWNER_URL)
  const localDuckdbOwnerUrl = getNormalizedDuckdbOwnerUrl(`http://127.0.0.1:${env.API_SERVER_PORT}`)
  const duckdbOwnerUrls = [leaseDuckdbOwnerUrl, configuredDuckdbOwnerUrl, localDuckdbOwnerUrl]
    .filter((duckdbOwnerUrl): duckdbOwnerUrl is string => {
      return duckdbOwnerUrl !== null
    })
    .filter((duckdbOwnerUrl, index, values) => {
      return values.indexOf(duckdbOwnerUrl) === index
    })

  return duckdbOwnerUrls.map((duckdbOwnerUrl) => {
    return getDuckdbStudioUrl(duckdbOwnerUrl)
  })
}

const getErrorText = (error: unknown) => {
  const causeText = error instanceof Error && error.cause instanceof Error ? ` ${error.cause.message}` : ''
  return error instanceof Error ? `${error.message}${causeText}` : String(error)
}

const isStudioServerUnavailable = (error: unknown) => {
  const errorText = getErrorText(error)
  return (
    error instanceof DuckdbSnapshotRouteUnavailableError
    || errorText.includes('ECONNREFUSED')
    || errorText.includes('FailedToOpenSocket')
    || errorText.includes('fetch failed')
    || errorText.includes('connection refused')
    || errorText.includes('Unable to connect')
    || errorText.includes('Was there a typo in the url or port')
  )
}

const isDuckdbOwnerResponsive = async (duckdbOwnerUrl: string) => {
  try {
    const response = await fetch(getDuckdbOwnerHealthUrl(duckdbOwnerUrl), {signal: AbortSignal.timeout(1_000)})
    return response.ok
  } catch {
    return false
  }
}

const getActiveDuckdbOwnerGuardError = (params: {duckdbOwnerUrl: string; taskName: string}) => {
  return new Error(
    `${params.taskName} requires exclusive DuckDB maintenance access, but the live DuckDB owner is active at ${params.duckdbOwnerUrl}. Stop the dev/server process first, or use snapshot tools like \`bun run db:studio\` or \`bun run db:query:snapshot -- --sql="SELECT ..."\`.`,
  )
}

const getStuckDuckdbOwnerGuardError = (params: {duckdbOwnerUrl: string; taskName: string}) => {
  return new Error(
    `${params.taskName} found a stale DuckDB owner lease for ${params.duckdbOwnerUrl}. Stop that stuck process before running maintenance so the script does not race a wedged owner.`,
  )
}

const ensureDuckdbMaintenanceIsAvailable = async (taskName: string) => {
  const currentLease = await Effect.runPromise(readDuckdbOwnerLease(env.DUCKDB_PATH))

  if (currentLease === null) {
    return
  }

  const duckdbOwnerUrl = getDuckdbOwnerLeaseUrl(currentLease)
  const isProcessAlive = isDuckdbOwnerLeaseProcessAlive(currentLease)
  const isHeartbeatStale = isDuckdbOwnerLeaseStale(currentLease)
  const isResponsive = await isDuckdbOwnerResponsive(duckdbOwnerUrl)

  if (isProcessAlive && !isHeartbeatStale) {
    throw getActiveDuckdbOwnerGuardError({duckdbOwnerUrl, taskName})
  }

  if (isProcessAlive && isHeartbeatStale) {
    throw getStuckDuckdbOwnerGuardError({duckdbOwnerUrl, taskName})
  }

  if (isResponsive) {
    throw getActiveDuckdbOwnerGuardError({duckdbOwnerUrl, taskName})
  }
}

const getSnapshotFromResponse = async (response: Response): Promise<AppDatabaseSnapshot> => {
  const text = await response.text()

  if (response.status === 404) {
    throw new DuckdbSnapshotRouteUnavailableError('DuckDB snapshot route is unavailable')
  }

  const body = JSON.parse(text) as DuckdbScriptAccessSnapshotResponse

  if (!response.ok || !body.data) {
    throw new Error(body.error ?? `DuckDB snapshot request failed with status ${response.status}`)
  }

  return body.data
}

const createRemoteSnapshot = async (url: string) => {
  const response = await fetch(url, {method: 'POST'})
  return getSnapshotFromResponse(response)
}

export const createRemoteSnapshotFromUrls = async (urls: string[]): Promise<AppDatabaseSnapshot> => {
  const [currentUrl, ...remainingUrls] = urls

  if (currentUrl === undefined) {
    throw new Error('DuckDB snapshot route is unavailable')
  }

  try {
    return await createRemoteSnapshot(currentUrl)
  } catch (error) {
    if (!isStudioServerUnavailable(error) || remainingUrls.length === 0) {
      throw error
    }

    return createRemoteSnapshotFromUrls(remainingUrls)
  }
}

export const withDuckdbMaintenanceAccess = async <_T>(taskName: string, work: () => Promise<_T>) => {
  return withCurrentServerRoleOverride('maintenance-worker', async () => {
    await ensureDuckdbMaintenanceIsAvailable(taskName)
    await ensureCurrentDuckdbOwnerLease()

    try {
      return await work()
    } finally {
      await getAppDatabaseService().close()
    }
  })
}

export const createDuckdbSnapshotForCli = async () => {
  try {
    return await createRemoteSnapshotFromUrls(await getDuckdbStudioUrls())
  } catch (error) {
    if (!isStudioServerUnavailable(error)) {
      throw error
    }

    return withDuckdbMaintenanceAccess('db snapshot fallback', async () => {
      return getAppDatabaseService().createSnapshot()
    })
  }
}
