import {runtimeReadyPath} from '../utils/runtimeReadyContract.ts'
import {findRouteSurfaceRoute} from './routeSurfaceInventory.ts'

export const duckdbOwnerPrivateApiPrefix = '/__duckdb-owner-rpc'

export type ApiRouteClassification =
  | 'duckdb-owner-diagnostics'
  | 'local-bootstrap'
  | 'non-api'
  | 'ownerless-readable-diagnostics'
  | 'owner-dependent'
  | 'unclassified'

const normalizePathname = (pathname: string) => {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
}

export const isProjectTransferStreamingUploadPath = (pathname: string, method: string) => {
  const normalizedPathname = normalizePathname(pathname)

  return method.toUpperCase() === 'PUT' && normalizedPathname.match(/^\/api\/projects\/import\/[^/]+\/upload$/) !== null
}

export const classifyApiRoute = (pathname: string, method = 'GET'): ApiRouteClassification => {
  const normalizedPathname = normalizePathname(pathname)
  const routeSurfaceRoute = findRouteSurfaceRoute({method, pathname: normalizedPathname})

  return !normalizedPathname.startsWith('/api/')
    ? 'non-api'
    : normalizedPathname === runtimeReadyPath
      ? 'local-bootstrap'
      : (routeSurfaceRoute?.proxyClassification ?? 'unclassified')
}

export const shouldApiRouteProxyToDuckdbOwner = (classification: ApiRouteClassification) => {
  return (
    classification === 'duckdb-owner-diagnostics'
    || classification === 'owner-dependent'
    || classification === 'unclassified'
  )
}

export const shouldApiRouteFailClosedWithoutDuckdbOwner = (classification: ApiRouteClassification) => {
  return classification === 'owner-dependent' || classification === 'unclassified'
}

export const getDuckdbOwnerProxyPathname = ({
  classification,
  pathname,
}: {
  classification: ApiRouteClassification
  pathname: string
}) => {
  return classification === 'owner-dependent' || classification === 'unclassified'
    ? `${duckdbOwnerPrivateApiPrefix}${pathname}`
    : pathname
}
