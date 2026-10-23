import {hostname} from 'node:os'

import {env} from '../../../utils/env.ts'
import {getCurrentServerDuckdbOwnerUrl, shouldCurrentServerProxyApiToOwner} from '../../../utils/serverRuntimeRole.ts'
import {duckdbOwnerProxyLogger} from '../duckdbOwnerProxyLogger.ts'
import {
  type DuckdbOwnerProxyRequestTemplate,
  type DuckdbOwnerStreamingProxyRequestTemplate,
  isBufferedDuckdbOwnerProxyRequestTemplate,
} from '../duckdbOwnerProxyRequestTemplate.ts'
import {getDuckdbOwnerProxyFailureResponse} from '../duckdbOwnerProxyResponses.ts'
import {warnDuckdbOwnerProxyFailure} from '../duckdbOwnerProxyWarnings.ts'
import {isRetryableDuckdbOwnerProxyMutation} from '../isRetryableDuckdbOwnerProxyMutation.ts'
import {waitForDuckdbOwnerProxyTargetUrl} from '../waitForDuckdbOwnerProxyTarget.ts'

const getCurrentServerHostAliases = () => {
  const aliases = new Set(['127.0.0.1', '0.0.0.0', 'localhost', '::1'])
  const currentHostname = hostname().trim().toLowerCase()

  if (currentHostname !== '') {
    aliases.add(currentHostname)

    if (currentHostname.endsWith('.local')) {
      aliases.add(currentHostname.slice(0, -'.local'.length))
    } else {
      aliases.add(`${currentHostname}.local`)
    }
  }

  return aliases
}

const currentServerHostAliases = getCurrentServerHostAliases()

const isCurrentServerDuckdbOwnerUrl = (duckdbOwnerUrl: string) => {
  const parsedDuckdbOwnerUrl = new URL(duckdbOwnerUrl)
  const isSamePort = parsedDuckdbOwnerUrl.port === String(env.API_SERVER_PORT)
  const normalizedHostname = parsedDuckdbOwnerUrl.hostname.trim().toLowerCase()

  return isSamePort && currentServerHostAliases.has(normalizedHostname)
}

export const getDuckdbOwnerProxyTargetFailureResponse = async (
  requestTemplate: DuckdbOwnerProxyRequestTemplate | DuckdbOwnerStreamingProxyRequestTemplate,
): Promise<{duckdbOwnerUrl: string} | {response: Response | null}> => {
  const duckdbOwnerUrl =
    isBufferedDuckdbOwnerProxyRequestTemplate(requestTemplate) && isRetryableDuckdbOwnerProxyMutation(requestTemplate)
      ? await waitForDuckdbOwnerProxyTargetUrl(requestTemplate)
      : await getCurrentServerDuckdbOwnerUrl()

  if (duckdbOwnerUrl === null) {
    if (!shouldCurrentServerProxyApiToOwner()) {
      return {response: null}
    }

    if (isBufferedDuckdbOwnerProxyRequestTemplate(requestTemplate)) {
      warnDuckdbOwnerProxyFailure('api-proxy:duckdb-owner-url-unavailable', requestTemplate)
    } else {
      duckdbOwnerProxyLogger.warn(
        'api-proxy:duckdb-owner-streaming-url-unavailable',
        '[api-proxy] DuckDB owner proxy could not forward streaming request',
        {
          classification: requestTemplate.classification,
          failClosedWithoutDuckdbOwner: requestTemplate.failClosedWithoutDuckdbOwner,
          method: requestTemplate.method,
          pathname: requestTemplate.pathname,
          search: requestTemplate.search,
        },
      )
    }
    return {response: getDuckdbOwnerProxyFailureResponse(requestTemplate)}
  }

  if (isCurrentServerDuckdbOwnerUrl(duckdbOwnerUrl)) {
    if (isBufferedDuckdbOwnerProxyRequestTemplate(requestTemplate)) {
      warnDuckdbOwnerProxyFailure('api-proxy:duckdb-owner-self-target', requestTemplate, {duckdbOwnerUrl})
    }
    return {
      response: Response.json(
        {data: null, error: `DuckDB owner proxy target must not point to this same API server (${duckdbOwnerUrl})`},
        {status: 500},
      ),
    }
  }

  return {duckdbOwnerUrl}
}
