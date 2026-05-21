import {runtimeReadyPath, runtimeStatePath} from '../utils/runtimeReadyContract.ts'
import {duckdbStudioSnapshotPath} from './DuckdbStudioRoutes.ts'

export const duckdbOwnerPrivateApiPrefix = '/__duckdb-owner-rpc'

export type ApiRouteClassification =
  | 'duckdb-owner-diagnostics'
  | 'local-bootstrap'
  | 'non-api'
  | 'ownerless-readable-diagnostics'
  | 'owner-dependent'
  | 'unclassified'

const duckdbOwnerDiagnosticsPaths = ['/api/duckdb_owner_connections', '/api/duckdb_owner_connections/heartbeat']
const ownerDependentPaths = [duckdbStudioSnapshotPath]
const ownerlessReadableDiagnosticsPaths = [
  runtimeStatePath,
  '/api/admin/worker-runtime-diagnostics',
  '/api/judgmentsjobs',
  '/api/judgmentsjobs-health',
  '/api/judgmentsjobs-provider-telemetry-history',
]

const normalizePathname = (pathname: string) => {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
}

const isJudgmentJobReadableDiagnosticsPath = (pathname: string, method: string) => {
  const normalizedMethod = method.toUpperCase()
  const dynamicMatch = pathname.match(/^\/api\/judgmentsjobs\/[^/]+(?:\/health)?$/)
  const dispatchTelemetryMatch = pathname.match(/^\/api\/admin\/judgment-dispatch-runtime\/[^/]+$/)

  return (
    normalizedMethod === 'GET'
    && (ownerlessReadableDiagnosticsPaths.includes(pathname)
      || dynamicMatch !== null
      || dispatchTelemetryMatch !== null)
  )
}

const isOwnerBackedJudgmentJobPath = (pathname: string, method: string) => {
  const normalizedMethod = method.toUpperCase()
  const claimOrCompletionMatch = pathname.match(/^\/api\/judgmentsjobs\/[^/]+\/(?:claim|claims|complete|completions)$/)
  const controlMatch = pathname.match(
    /^\/api\/judgmentsjobs\/[^/]+(?:\/(?:checkpoint|drain|preflight|quarantine|repair|start-clean|unquarantine))?$/,
  )
  const heartbeatMatch = pathname === '/api/judgmentsjobs-worker-heartbeats'
  const snapshotMatch =
    pathname.match(/^\/api\/judgmentsjobs\/execution-snapshots\/[^/]+$/)
    || pathname.match(/^\/api\/judgmentsjobs-execution-snapshots\/[^/]+$/)

  return (
    heartbeatMatch
    || snapshotMatch !== null
    || claimOrCompletionMatch !== null
    || (controlMatch !== null && ['DELETE', 'PATCH', 'POST'].includes(normalizedMethod))
  )
}

export const isProjectTransferStreamingUploadPath = (pathname: string, method: string) => {
  const normalizedPathname = normalizePathname(pathname)

  return method.toUpperCase() === 'PUT' && normalizedPathname.match(/^\/api\/projects\/import\/[^/]+\/upload$/) !== null
}

const isOwnerBackedProjectTransferPath = (pathname: string, method: string) => {
  const normalizedMethod = method.toUpperCase()
  const exportProjectMatch = pathname.match(/^\/api\/projects\/[^/]+\/export-project$/)
  const exportPackageMatch = pathname.match(/^\/api\/projects\/export\/[^/]+(?:\/download)?$/)
  const createImportSessionMatch = pathname === '/api/projects/import/sessions'
  const analyzeImportSessionMatch = pathname.match(/^\/api\/projects\/import\/[^/]+\/analyze$/)
  const importSessionMatch = pathname.match(/^\/api\/projects\/import\/[^/]+$/)
  const resolveImportDependenciesMatch = pathname.match(/^\/api\/projects\/import\/[^/]+\/resolve-dependencies$/)
  const commitImportSessionMatch = pathname.match(/^\/api\/projects\/import\/[^/]+\/commit$/)
  const csvExportMatch = pathname.match(/^\/api\/projects\/[^/]+\/export$/)

  return (
    (normalizedMethod === 'POST'
      && (exportProjectMatch !== null || createImportSessionMatch || csvExportMatch !== null))
    || (normalizedMethod === 'GET' && (exportPackageMatch !== null || importSessionMatch !== null))
    || isProjectTransferStreamingUploadPath(pathname, normalizedMethod)
    || (normalizedMethod === 'DELETE' && importSessionMatch !== null)
    || (normalizedMethod === 'POST' && analyzeImportSessionMatch !== null)
    || (normalizedMethod === 'POST' && resolveImportDependenciesMatch !== null)
    || (normalizedMethod === 'POST' && commitImportSessionMatch !== null)
  )
}

export const classifyApiRoute = (pathname: string, method = 'GET'): ApiRouteClassification => {
  const normalizedPathname = normalizePathname(pathname)

  return !normalizedPathname.startsWith('/api/')
    ? 'non-api'
    : normalizedPathname === runtimeReadyPath
      ? 'local-bootstrap'
      : duckdbOwnerDiagnosticsPaths.includes(normalizedPathname)
        ? 'duckdb-owner-diagnostics'
        : isJudgmentJobReadableDiagnosticsPath(normalizedPathname, method)
          ? 'ownerless-readable-diagnostics'
          : isOwnerBackedJudgmentJobPath(normalizedPathname, method)
            ? 'owner-dependent'
            : isOwnerBackedProjectTransferPath(normalizedPathname, method)
              ? 'owner-dependent'
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
