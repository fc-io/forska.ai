import {Elysia} from 'elysia'

import {withErrorHandler} from '../utils/routeErrorHandler.ts'
import {disableIdleTimeoutForLongDownloadRequest} from './apiProxyRoutes/disableIdleTimeoutForLongDownloadRequest.ts'
import {getDuckdbOwnerProxyRetryTimeoutMs} from './apiProxyRoutes/duckdbOwnerProxyTimeoutMs.ts'
import {forwardApiRequestToDuckdbOwner} from './apiProxyRoutes/forwardApiRequestToDuckdbOwner.ts'
import {getIncompatibleDuckdbOwnerPeerResponse} from './apiProxyRoutes/getIncompatibleDuckdbOwnerPeerResponse.ts'

export const getDuckdbOwnerProxyRetryTimeoutMsForTesting = getDuckdbOwnerProxyRetryTimeoutMs

export const apiProxyRoutes = new Elysia().use(withErrorHandler()).onRequest(async ({request, server}) => {
  disableIdleTimeoutForLongDownloadRequest(request, server)

  const incompatiblePeerResponse = getIncompatibleDuckdbOwnerPeerResponse(request)

  if (incompatiblePeerResponse !== null) {
    return incompatiblePeerResponse
  }

  return forwardApiRequestToDuckdbOwner(request, server)
})
