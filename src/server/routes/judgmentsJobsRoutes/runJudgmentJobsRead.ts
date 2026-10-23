import {getDuckdbOwnerConnectionProxyHeaders} from '../../utils/duckdbOwnerConnections.ts'
import {HttpError} from '../../utils/httpError.ts'
import {probeDuckdbOwnerCutoverCompatibility} from '../../utils/runtimeCutover.ts'
import {
  getCurrentServerDuckdbOwnerUrl,
  getCurrentServerRole,
  shouldCurrentServerProxyApiToOwner,
} from '../../utils/serverRuntimeRole.ts'
import {duckdbOwnerPrivateApiPrefix} from '../apiRouteClassification.ts'
import {getMaintenanceUnavailableError} from './getMaintenanceUnavailableError.ts'

const getJudgmentJobsOwnerProxyData = async <T>(request: Request): Promise<T | null> => {
  if (getCurrentServerRole() !== 'api' || !shouldCurrentServerProxyApiToOwner()) {
    return null
  }

  const duckdbOwnerUrl = await getCurrentServerDuckdbOwnerUrl()

  if (duckdbOwnerUrl === null) {
    return null
  }

  const compatibility = await probeDuckdbOwnerCutoverCompatibility(duckdbOwnerUrl, 'DuckDB owner proxy target')

  if (compatibility.status === 'incompatible') {
    throw new HttpError(426, compatibility.message)
  }

  const requestUrl = new URL(request.url)
  const headers = new Headers({
    ...Object.fromEntries(request.headers.entries()),
    ...getDuckdbOwnerConnectionProxyHeaders(),
  })

  const response = await fetch(
    new Request(`${duckdbOwnerUrl}${duckdbOwnerPrivateApiPrefix}${requestUrl.pathname}${requestUrl.search}`, {
      headers,
      method: request.method,
    }),
  )
  const rawBody = await response.text()
  const body = (() => {
    if (rawBody.trim() === '') {
      return null
    }

    try {
      return JSON.parse(rawBody) as T
    } catch {
      return null
    }
  })()

  if (response.ok) {
    if (body !== null) {
      return body
    }

    throw new HttpError(502, 'DuckDB owner proxy target returned invalid JSON')
  }

  const errorMessage =
    typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
      ? body.error
      : rawBody.trim() !== ''
        ? rawBody.trim()
        : 'DuckDB owner proxy target unavailable'

  throw new HttpError(response.status, errorMessage)
}

export const runJudgmentJobsRead = async <T>({
  operation,
  request,
}: {
  operation: () => Promise<T>
  request: Request
}): Promise<T> => {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof HttpError) {
      throw error
    }

    const proxyResponse = await getJudgmentJobsOwnerProxyData<T>(request)

    if (proxyResponse !== null) {
      return proxyResponse
    }

    if (getCurrentServerRole() === 'api') {
      throw getMaintenanceUnavailableError('judgment job read model is unavailable', error)
    }

    throw error
  }
}
