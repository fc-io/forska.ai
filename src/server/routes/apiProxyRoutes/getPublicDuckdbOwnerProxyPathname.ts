import {duckdbOwnerPrivateApiPrefix, normalizeApiRoutePathname} from '../apiRouteClassification.ts'
import type {DuckdbOwnerProxyRequestTemplate} from './duckdbOwnerProxyRequestTemplate.ts'

export const getPublicDuckdbOwnerProxyPathname = (requestTemplate: DuckdbOwnerProxyRequestTemplate) => {
  const publicPathname = requestTemplate.pathname.startsWith(duckdbOwnerPrivateApiPrefix)
    ? requestTemplate.pathname.slice(duckdbOwnerPrivateApiPrefix.length)
    : requestTemplate.pathname

  return normalizeApiRoutePathname(publicPathname)
}
