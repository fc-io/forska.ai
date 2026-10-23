import {getCurrentServerDuckdbOwnerUrl} from '../../../utils/serverRuntimeRole.ts'
import type {DuckdbOwnerProxyRequestTemplate} from '../duckdbOwnerProxyRequestTemplate.ts'
import {getDuckdbOwnerProxyRetryTimeoutMs} from '../duckdbOwnerProxyTimeoutMs.ts'
import {warnDuckdbOwnerProxyFailure} from '../duckdbOwnerProxyWarnings.ts'
import {fetchDuckdbOwnerProxyRequest, fetchDuckdbOwnerProxyResponse} from '../fetchDuckdbOwnerProxyResponse.ts'
import {getDuckdbOwnerProxyErrorMessage} from '../getDuckdbOwnerProxyErrorMessage.ts'
import {isRetryableDuckdbOwnerProxyMutation} from '../isRetryableDuckdbOwnerProxyMutation.ts'
import {waitForDuckdbOwnerProxyRetry, waitForDuckdbOwnerProxyTarget} from '../waitForDuckdbOwnerProxyTarget.ts'

const duckdbOwnerProxyRetryableMethods = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PUT'])

export const shouldRetryDuckdbOwnerProxyRequest = (requestTemplate: DuckdbOwnerProxyRequestTemplate) => {
  return (
    duckdbOwnerProxyRetryableMethods.has(requestTemplate.method) || isRetryableDuckdbOwnerProxyMutation(requestTemplate)
  )
}

const shouldWaitForDuckdbOwnerProxyTarget = (requestTemplate: DuckdbOwnerProxyRequestTemplate) => {
  return (
    isRetryableDuckdbOwnerProxyMutation(requestTemplate)
    || (requestTemplate.classification === 'owner-dependent'
      && (requestTemplate.method === 'GET'
        || requestTemplate.method === 'HEAD'
        || requestTemplate.method === 'OPTIONS'))
  )
}

export const fetchNonRetryableDuckdbOwnerProxyResponse = async (
  requestTemplate: DuckdbOwnerProxyRequestTemplate,
  duckdbOwnerUrl: string,
) => {
  const target = await waitForDuckdbOwnerProxyTarget(requestTemplate, duckdbOwnerUrl)

  if ('response' in target) {
    return target.response
  }

  return fetchDuckdbOwnerProxyRequest(requestTemplate, target.duckdbOwnerUrl)
}

export const fetchRetryableDuckdbOwnerProxyResponse = async (
  requestTemplate: DuckdbOwnerProxyRequestTemplate,
  duckdbOwnerUrl: string,
) => {
  if (shouldWaitForDuckdbOwnerProxyTarget(requestTemplate)) {
    const target = await waitForDuckdbOwnerProxyTarget(requestTemplate, duckdbOwnerUrl)

    if ('response' in target) {
      return target.response
    }

    return fetchDuckdbOwnerProxyResponse(requestTemplate, target.duckdbOwnerUrl)
  }

  return fetchDuckdbOwnerProxyResponse(requestTemplate, duckdbOwnerUrl)
}

export const getRetriedProxyResponse = async (
  requestTemplate: DuckdbOwnerProxyRequestTemplate,
  currentDuckdbOwnerUrl: string,
) => {
  const deadlineMs = Date.now() + getDuckdbOwnerProxyRetryTimeoutMs(requestTemplate)

  while (Date.now() < deadlineMs) {
    await waitForDuckdbOwnerProxyRetry()

    try {
      const nextDuckdbOwnerUrl = (await getCurrentServerDuckdbOwnerUrl()) ?? currentDuckdbOwnerUrl
      const target = shouldWaitForDuckdbOwnerProxyTarget(requestTemplate)
        ? await waitForDuckdbOwnerProxyTarget(requestTemplate, nextDuckdbOwnerUrl, deadlineMs)
        : {duckdbOwnerUrl: nextDuckdbOwnerUrl}

      if ('response' in target) {
        return target.response
      }

      return await fetchDuckdbOwnerProxyResponse(requestTemplate, target.duckdbOwnerUrl)
    } catch (error) {
      warnDuckdbOwnerProxyFailure('api-proxy:duckdb-owner-retry-forward-failed', requestTemplate, {
        duckdbOwnerUrl: currentDuckdbOwnerUrl,
        error: getDuckdbOwnerProxyErrorMessage(error),
      })
      continue
    }
  }

  return null
}
