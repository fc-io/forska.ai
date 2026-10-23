import {probeDuckdbOwnerRuntimeReadiness} from '../../utils/runtimeCutover.ts'
import {getCurrentServerDuckdbOwnerUrl} from '../../utils/serverRuntimeRole.ts'
import type {DuckdbOwnerProxyRequestTemplate} from './duckdbOwnerProxyRequestTemplate.ts'
import {getDuckdbOwnerProxyUnavailableResponse} from './duckdbOwnerProxyResponses.ts'
import {getDuckdbOwnerProxyRetryTimeoutMs} from './duckdbOwnerProxyTimeoutMs.ts'
import {warnDuckdbOwnerProxyFailure} from './duckdbOwnerProxyWarnings.ts'
import {getDuckdbOwnerProxyErrorMessage} from './getDuckdbOwnerProxyErrorMessage.ts'

const duckdbOwnerProxyRetryDelayMs = 250

export const waitForDuckdbOwnerProxyRetry = async () => {
  await new Promise((resolve) => {
    setTimeout(resolve, duckdbOwnerProxyRetryDelayMs)
  })
}

export const waitForDuckdbOwnerProxyTarget = async (
  requestTemplate: DuckdbOwnerProxyRequestTemplate,
  duckdbOwnerUrl: string,
  deadlineMs = Date.now() + getDuckdbOwnerProxyRetryTimeoutMs(requestTemplate),
): Promise<{duckdbOwnerUrl: string} | {response: Response}> => {
  const result = await probeDuckdbOwnerRuntimeReadiness(duckdbOwnerUrl, 'DuckDB owner proxy target')

  if (result.status === 'incompatible' && !result.message.includes('is not ready owner')) {
    return {response: Response.json({data: null, error: result.message}, {status: 426})}
  }

  if (result.status === 'compatible') {
    return {duckdbOwnerUrl}
  }

  if (Date.now() >= deadlineMs) {
    warnDuckdbOwnerProxyFailure('api-proxy:duckdb-owner-readiness-timeout', requestTemplate, {
      duckdbOwnerUrl,
      readiness:
        result.status === 'unreachable'
          ? {error: getDuckdbOwnerProxyErrorMessage(result.error), status: result.status}
          : {message: result.message, runtimeVersion: result.runtimeVersion, status: result.status},
    })
    return {response: getDuckdbOwnerProxyUnavailableResponse(requestTemplate)}
  }

  await waitForDuckdbOwnerProxyRetry()
  const nextDuckdbOwnerUrl = (await getCurrentServerDuckdbOwnerUrl()) ?? duckdbOwnerUrl
  return waitForDuckdbOwnerProxyTarget(requestTemplate, nextDuckdbOwnerUrl, deadlineMs)
}

export const waitForDuckdbOwnerProxyTargetUrl = async (
  requestTemplate: DuckdbOwnerProxyRequestTemplate,
  deadlineMs = Date.now() + getDuckdbOwnerProxyRetryTimeoutMs(requestTemplate),
): Promise<string | null> => {
  while (Date.now() < deadlineMs) {
    const duckdbOwnerUrl = await getCurrentServerDuckdbOwnerUrl()

    if (duckdbOwnerUrl !== null) {
      return duckdbOwnerUrl
    }

    await waitForDuckdbOwnerProxyRetry()
  }

  const finalDuckdbOwnerUrl = await getCurrentServerDuckdbOwnerUrl()

  if (finalDuckdbOwnerUrl === null) {
    warnDuckdbOwnerProxyFailure('api-proxy:duckdb-owner-url-discovery-timeout', requestTemplate)
  }

  return finalDuckdbOwnerUrl
}
