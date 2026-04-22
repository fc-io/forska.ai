import {runtimeReadyPath} from '../utils/runtimeReadyContract.ts'
import {duckdbStudioSnapshotPath} from './DuckdbStudioRoutes.ts'

export const duckdbOwnerPrivateApiPrefix = '/__duckdb-owner-rpc'

export type ApiRouteClassification =
  | 'duckdb-owner-diagnostics'
  | 'local-bootstrap'
  | 'non-api'
  | 'owner-dependent'
  | 'unclassified'

const duckdbOwnerDiagnosticsPaths = ['/api/duckdb_owner_connections', '/api/duckdb_owner_connections/heartbeat']
const ownerDependentPaths = [duckdbStudioSnapshotPath]

const normalizePathname = (pathname: string) => {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
}

export const classifyApiRoute = (pathname: string): ApiRouteClassification => {
  const normalizedPathname = normalizePathname(pathname)

  return !normalizedPathname.startsWith('/api/')
    ? 'non-api'
    : normalizedPathname === runtimeReadyPath
      ? 'local-bootstrap'
      : duckdbOwnerDiagnosticsPaths.includes(normalizedPathname)
        ? 'duckdb-owner-diagnostics'
        : ownerDependentPaths.includes(normalizedPathname)
          ? 'owner-dependent'
          : 'unclassified'
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
