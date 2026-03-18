import {Elysia} from 'elysia'

import {env} from '../utils/env.ts'
import {withErrorHandler} from '../utils/routeErrorHandler.ts'
import {shouldServerRoleProxyApiToWriter} from '../utils/serverRole.ts'

const getNormalizedServerWriterUrl = () => {
  const raw = String(env.SERVER_WRITER_URL ?? '').trim()

  if (!shouldServerRoleProxyApiToWriter(env.SERVER_ROLE)) {
    return null
  }

  if (raw === '') {
    throw new Error(`SERVER_WRITER_URL is required when SERVER_ROLE=${env.SERVER_ROLE}`)
  }

  const normalized = raw.endsWith('/') ? raw.slice(0, -1) : raw
  const writerUrl = new URL(normalized)
  const localOrigins = new Set([`http://127.0.0.1:${env.API_SERVER_PORT}`, `http://localhost:${env.API_SERVER_PORT}`])

  if (localOrigins.has(writerUrl.origin)) {
    throw new Error(`SERVER_WRITER_URL must not point to this same API server (${writerUrl.origin})`)
  }

  return writerUrl.toString().endsWith('/') ? writerUrl.toString().slice(0, -1) : writerUrl.toString()
}

const getWriterProxyRequest = (request: Request) => {
  const writerUrl = getNormalizedServerWriterUrl()

  if (writerUrl === null) {
    return null
  }

  const requestUrl = new URL(request.url)
  return requestUrl.pathname.startsWith('/api/')
    ? new Request(`${writerUrl}${requestUrl.pathname}${requestUrl.search}`, request)
    : null
}

const forwardApiRequestToWriter = async (request: Request): Promise<Response | null> => {
  const proxiedRequest = getWriterProxyRequest(request)
  return proxiedRequest === null ? null : fetch(proxiedRequest)
}

export const apiProxyRoutes = new Elysia().use(withErrorHandler()).onRequest(async ({request}) => {
  return forwardApiRequestToWriter(request)
})
