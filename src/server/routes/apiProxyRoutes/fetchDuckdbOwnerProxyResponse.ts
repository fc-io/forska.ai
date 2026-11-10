import {probeDuckdbOwnerCutoverCompatibility} from '../../utils/runtimeCutover.ts'
import {
  type DuckdbOwnerProxyRequestTemplate,
  type DuckdbOwnerStreamingProxyRequestTemplate,
  getDuckdbOwnerProxyRequest,
  getDuckdbOwnerStreamingProxyRequest,
} from './duckdbOwnerProxyRequestTemplate.ts'
import {
  type DuckdbOwnerProxyTimeoutBudgets,
  duckdbOwnerProxyTimeoutBudgets,
  duckdbOwnerStreamingProxyTimeoutMs,
  getDuckdbOwnerProxyBodyIdleTimeoutMs,
  getDuckdbOwnerProxyTimeoutMs,
} from './duckdbOwnerProxyTimeoutMs.ts'
import {warnDuckdbOwnerProxyTimeout} from './duckdbOwnerProxyWarnings.ts'
import {
  createDuckdbOwnerProxyTimeout,
  getDuckdbOwnerProxyTimeoutResponse,
  keepDuckdbOwnerProxyBodyWhileChunksArrive,
  keepDuckdbOwnerProxyTimeoutUntilBodySettles,
} from './fetchDuckdbOwnerProxyResponse/duckdbOwnerProxyTimeout.ts'

const getIncompatibleDuckdbOwnerTargetResponse = async (duckdbOwnerUrl: string) => {
  const result = await probeDuckdbOwnerCutoverCompatibility(duckdbOwnerUrl, 'DuckDB owner proxy target')

  return result.status === 'incompatible' ? Response.json({data: null, error: result.message}, {status: 426}) : null
}

export const fetchDuckdbOwnerProxyRequest = async (
  requestTemplate: DuckdbOwnerProxyRequestTemplate,
  duckdbOwnerUrl: string,
  budgets: DuckdbOwnerProxyTimeoutBudgets = duckdbOwnerProxyTimeoutBudgets,
) => {
  const timeoutMs = getDuckdbOwnerProxyTimeoutMs(requestTemplate, budgets)
  const bodyIdleTimeoutMs = getDuckdbOwnerProxyBodyIdleTimeoutMs(requestTemplate, budgets)
  const startedAtMs = Date.now()
  const warnTimeout = (phase: 'body' | 'body-idle' | 'headers') => {
    warnDuckdbOwnerProxyTimeout(requestTemplate, {
      elapsedMs: Date.now() - startedAtMs,
      phase,
      timeoutMs: phase === 'body-idle' ? bodyIdleTimeoutMs : timeoutMs,
    })
  }
  const timeout = createDuckdbOwnerProxyTimeout(timeoutMs)

  try {
    const response = await fetch(getDuckdbOwnerProxyRequest(requestTemplate, duckdbOwnerUrl, timeout.signal))

    return bodyIdleTimeoutMs === null
      ? keepDuckdbOwnerProxyTimeoutUntilBodySettles(response, timeout, () => {
          warnTimeout('body')
        })
      : keepDuckdbOwnerProxyBodyWhileChunksArrive(response, timeout, {
          clientConnection: requestTemplate.clientConnection,
          idleTimeoutMs: bodyIdleTimeoutMs,
          onBodyIdleTimeout: () => {
            warnTimeout('body-idle')
          },
        })
  } catch (error) {
    timeout.dispose()

    if (timeout.signal.aborted) {
      warnTimeout('headers')
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
