import {probeDuckdbOwnerCutoverCompatibility} from '../../utils/runtimeCutover.ts'
import {
  type DuckdbOwnerProxyRequestTemplate,
  type DuckdbOwnerStreamingProxyRequestTemplate,
  getDuckdbOwnerProxyRequest,
  getDuckdbOwnerStreamingProxyRequest,
} from './duckdbOwnerProxyRequestTemplate.ts'
import {getDuckdbOwnerProxyTimeoutMs} from './duckdbOwnerProxyTimeoutMs.ts'
import {
  createDuckdbOwnerProxyTimeout,
  getDuckdbOwnerProxyTimeoutResponse,
  keepDuckdbOwnerProxyTimeoutUntilBodySettles,
} from './fetchDuckdbOwnerProxyResponse/duckdbOwnerProxyTimeout.ts'

const duckdbOwnerStreamingProxyTimeoutMs = 10 * 60 * 1000

const getIncompatibleDuckdbOwnerTargetResponse = async (duckdbOwnerUrl: string) => {
  const result = await probeDuckdbOwnerCutoverCompatibility(duckdbOwnerUrl, 'DuckDB owner proxy target')

  return result.status === 'incompatible' ? Response.json({data: null, error: result.message}, {status: 426}) : null
}

export const fetchDuckdbOwnerProxyRequest = async (
  requestTemplate: DuckdbOwnerProxyRequestTemplate,
  duckdbOwnerUrl: string,
) => {
  const timeoutMs = getDuckdbOwnerProxyTimeoutMs(requestTemplate)

  if (timeoutMs === null) {
    return fetch(getDuckdbOwnerProxyRequest(requestTemplate, duckdbOwnerUrl))
  }

  const timeout = createDuckdbOwnerProxyTimeout(timeoutMs)

  try {
    const response = await fetch(getDuckdbOwnerProxyRequest(requestTemplate, duckdbOwnerUrl, timeout.signal))

    return keepDuckdbOwnerProxyTimeoutUntilBodySettles(response, timeout)
  } catch (error) {
    timeout.dispose()

    if (timeout.signal.aborted) {
      return getDuckdbOwnerProxyTimeoutResponse(timeoutMs)
    }

    throw error
  }
}

export const fetchDuckdbOwnerProxyResponse = async (
  requestTemplate: DuckdbOwnerProxyRequestTemplate,
  duckdbOwnerUrl: string,
) => {
  const incompatibleTargetResponse = await getIncompatibleDuckdbOwnerTargetResponse(duckdbOwnerUrl)

  if (incompatibleTargetResponse !== null) {
    return incompatibleTargetResponse
  }

  return fetchDuckdbOwnerProxyRequest(requestTemplate, duckdbOwnerUrl)
}

export const fetchDuckdbOwnerStreamingProxyResponse = async (
  requestTemplate: DuckdbOwnerStreamingProxyRequestTemplate,
  duckdbOwnerUrl: string,
) => {
  const incompatibleTargetResponse = await getIncompatibleDuckdbOwnerTargetResponse(duckdbOwnerUrl)

  if (incompatibleTargetResponse !== null) {
    return incompatibleTargetResponse
  }

  const timeout = createDuckdbOwnerProxyTimeout(duckdbOwnerStreamingProxyTimeoutMs)

  try {
    const response = await fetch(getDuckdbOwnerStreamingProxyRequest(requestTemplate, duckdbOwnerUrl, timeout.signal))

    return keepDuckdbOwnerProxyTimeoutUntilBodySettles(response, timeout)
  } catch (error) {
    timeout.dispose()

    if (timeout.signal.aborted) {
      return getDuckdbOwnerProxyTimeoutResponse(duckdbOwnerStreamingProxyTimeoutMs)
    }

    throw error
  }
}
