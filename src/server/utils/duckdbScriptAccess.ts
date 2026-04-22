import {Effect} from 'effect'

import {type AppDatabaseSnapshot, getAppDatabaseService} from '../services/appDatabaseService.ts'
import {
  getDuckdbOwnerLeaseWriterUrl,
  isDuckdbOwnerLeaseProcessAlive,
  isDuckdbOwnerLeaseStale,
  readDuckdbOwnerLease,
} from './duckdbOwnerLease.ts'
import {env} from './env.ts'
import {ensureCurrentDuckdbOwnerLease, withCurrentServerRoleOverride} from './serverRuntimeRole.ts'

type DuckdbScriptAccessSnapshotResponse = {data?: AppDatabaseSnapshot; error?: string}

const duckdbStudioSnapshotPath = '/api/duckdbStudioSnapshots'

const getWriterHealthUrl = (writerUrl: string) => {
  return `${writerUrl}/api/writer_connections`
}

const getNormalizedWriterUrl = (value: string | null | undefined) => {
  const raw = String(value ?? '').trim()
  return raw === '' ? null : raw.endsWith('/') ? raw.slice(0, -1) : raw
}

const getDuckdbStudioUrl = (writerUrl: string) => {
  return `${writerUrl}${duckdbStudioSnapshotPath}`
}

const getDuckdbStudioUrls = async () => {
  const currentLease = await Effect.runPromise(readDuckdbOwnerLease(env.DUCKDB_PATH))
  const leaseWriterUrl = currentLease === null ? null : getDuckdbOwnerLeaseWriterUrl(currentLease)
  const configuredWriterUrl = getNormalizedWriterUrl(env.SERVER_WRITER_URL)
  const localWriterUrl = getNormalizedWriterUrl(`http://127.0.0.1:${env.API_SERVER_PORT}`)
  const writerUrls = [leaseWriterUrl, configuredWriterUrl, localWriterUrl]
    .filter((writerUrl): writerUrl is string => {
      return writerUrl !== null
    })
    .filter((writerUrl, index, values) => {
      return values.indexOf(writerUrl) === index
    })

  return writerUrls.map((writerUrl) => {
    return getDuckdbStudioUrl(writerUrl)
  })
}

const getErrorText = (error: unknown) => {
  const causeText = error instanceof Error && error.cause instanceof Error ? ` ${error.cause.message}` : ''
  return error instanceof Error ? `${error.message}${causeText}` : String(error)
}

const isStudioServerUnavailable = (error: unknown) => {
  const errorText = getErrorText(error)
  return (
    errorText.includes('ECONNREFUSED')
    || errorText.includes('fetch failed')
    || errorText.includes('connection refused')
    || errorText.includes('Unable to connect')
  )
}

const isWriterResponsive = async (writerUrl: string) => {
  try {
    const response = await fetch(getWriterHealthUrl(writerUrl), {signal: AbortSignal.timeout(1_000)})
    return response.ok
  } catch {
    return false
  }
}

const getActiveWriterGuardError = (params: {taskName: string; writerUrl: string}) => {
  return new Error(
    `${params.taskName} requires exclusive DuckDB maintenance access, but the live DuckDB owner is active at ${params.writerUrl}. Stop the dev/server process first, or use snapshot tools like \`bun run db:studio\` or \`bun run db:query:snapshot -- --sql="SELECT ..."\`.`,
  )
}

const getStuckWriterGuardError = (params: {taskName: string; writerUrl: string}) => {
  return new Error(
    `${params.taskName} found a stale DuckDB owner lease for ${params.writerUrl}. Stop that stuck process before running maintenance so the script does not race a wedged owner.`,
  )
}

const ensureDuckdbMaintenanceIsAvailable = async (taskName: string) => {
  const currentLease = await Effect.runPromise(readDuckdbOwnerLease(env.DUCKDB_PATH))

  if (currentLease === null) {
    return
  }

  const writerUrl = getDuckdbOwnerLeaseWriterUrl(currentLease)
  const isProcessAlive = isDuckdbOwnerLeaseProcessAlive(currentLease)
  const isHeartbeatStale = isDuckdbOwnerLeaseStale(currentLease)
  const isResponsive = await isWriterResponsive(writerUrl)

  if (isProcessAlive && !isHeartbeatStale) {
    throw getActiveWriterGuardError({taskName, writerUrl})
  }

  if (isProcessAlive && isHeartbeatStale) {
    throw getStuckWriterGuardError({taskName, writerUrl})
  }

  if (isResponsive) {
    throw getActiveWriterGuardError({taskName, writerUrl})
  }
}

const getSnapshotFromResponse = async (response: Response): Promise<AppDatabaseSnapshot> => {
  const body = (await response.json()) as DuckdbScriptAccessSnapshotResponse

  if (!response.ok || !body.data) {
    throw new Error(body.error ?? `DuckDB snapshot request failed with status ${response.status}`)
  }

  return body.data
}

const createRemoteSnapshot = async (url: string) => {
  const response = await fetch(url, {method: 'POST'})
  return getSnapshotFromResponse(response)
}

const createRemoteSnapshotFromUrls = async (urls: string[]): Promise<AppDatabaseSnapshot> => {
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
