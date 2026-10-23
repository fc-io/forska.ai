import {getDuckdbOwnerConnectionRuntimeVersionError} from '../../utils/duckdbOwnerConnections.ts'
import {classifyApiRoute, shouldApiRouteProxyToDuckdbOwner} from '../apiRouteClassification.ts'

export const getIncompatibleDuckdbOwnerPeerResponse = (request: Request) => {
  const requestUrl = new URL(request.url)
  const classification = classifyApiRoute(requestUrl.pathname, request.method)
  const error = shouldApiRouteProxyToDuckdbOwner(classification)
    ? getDuckdbOwnerConnectionRuntimeVersionError(request.headers)
    : null

  return error === null ? null : Response.json({data: null, error: error.message}, {status: 426})
}
