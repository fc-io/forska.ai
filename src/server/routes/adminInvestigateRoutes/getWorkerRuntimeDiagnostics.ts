import {getJudgmentJobSqliteHealthProjectionService} from '../../services/judgmentJobSqliteHealthProjectionService.ts'
import {
  type DuckdbOwnerConnectionRecord,
  getDuckdbOwnerConnectionsOverview,
} from '../../utils/duckdbOwnerConnections.ts'
import {getOwnerlessRouteBackendSelections} from '../../utils/ownerlessReadableBackends.ts'
import {
  getServerRoleCapabilities,
  type ServerRole,
  type ServerRoleCapability,
  serverRoles,
} from '../../utils/serverRole.ts'
import {canCurrentServerOwnDuckdb, getCurrentServerRole, getKnownDuckdbOwnerUrl} from '../../utils/serverRuntimeRole.ts'
import {getCutoverRefusalStatus} from './getWorkerRuntimeDiagnostics/getCutoverRefusalStatus.ts'
import {getJudgmentJobReadPathMode} from './getWorkerRuntimeDiagnostics/getJudgmentJobReadPathMode.ts'
import {getPendingCompletionAckVisibilityFromSharedState} from './getWorkerRuntimeDiagnostics/getPendingCompletionAckVisibilityFromSharedState.ts'
import {getRouteServingMode} from './getWorkerRuntimeDiagnostics/getRouteServingMode.ts'
import {workerRuntimeDiagnosticsPath} from './workerRuntimeDiagnosticsPath.ts'

const getLocalServerRole = (): ServerRole | null => {
  const configuredRole = process.env.SERVER_ROLE

  return serverRoles.includes(configuredRole as ServerRole) ? (configuredRole as ServerRole) : null
}

const getConfiguredCapabilities = (localRole: ServerRole | null): ServerRoleCapability[] => {
  return localRole === null ? [] : getServerRoleCapabilities(localRole)
}

export const getWorkerRuntimeDiagnostics = async () => {
  const localRole = getLocalServerRole()
  const serverRole = getCurrentServerRole()
  const capabilities = getServerRoleCapabilities(serverRole)
  const ownerConnections = await getDuckdbOwnerConnectionsOverview()
  const registeredProcesses = [ownerConnections.owner, ...ownerConnections.followers].filter(
    (record): record is DuckdbOwnerConnectionRecord => {
      return record !== null
    },
  )
  const ownerlessBackendSelections = getOwnerlessRouteBackendSelections()
  const workerRuntimeDiagnosticsBackend =
    ownerlessBackendSelections.find((selection) => {
      return selection.method === 'GET' && selection.pathname === workerRuntimeDiagnosticsPath
    }) ?? null

  return {
    capabilities,
    configuredCapabilities: getConfiguredCapabilities(localRole),
    cutoverRefusal: getCutoverRefusalStatus(registeredProcesses),
    duckdbOwnership: {
      canOwnDuckdb: capabilities.includes('duckdb-owner'),
      duckdbOwnerUrl: getKnownDuckdbOwnerUrl(),
      ownerRecord: ownerConnections.owner,
      ownsDuckdb: canCurrentServerOwnDuckdb(),
    },
    localRole,
    ownerlessBackends: {
      selections: ownerlessBackendSelections,
      validated: ownerlessBackendSelections.length > 0,
      workerRuntimeDiagnostics: workerRuntimeDiagnosticsBackend,
    },
    pendingCompletionAckVisibility: await getPendingCompletionAckVisibilityFromSharedState(),
    readPath: {
      judgmentJobs: {
        mode: getJudgmentJobReadPathMode(),
        sharedProjectionFreshnessMs: getJudgmentJobSqliteHealthProjectionService().getProjectionFreshnessMs(),
      },
    },
    registry: ownerConnections.registry,
    registryDerivedEligibleConsumers: ownerConnections.registry.capabilities.map((capability) => {
      return {
        capability: capability.capability,
        eligibleConsumerCount: capability.eligibleConsumerCount,
        eligibleConsumerPresent: capability.eligibleConsumerPresent,
        freshConsumerCount: capability.freshConsumerCount,
        registeredConsumerCount: capability.registeredConsumerCount,
        staleConsumerCount: capability.staleConsumerCount,
      }
    }),
    registeredProcesses,
    routeServing: getRouteServingMode(),
    runtimeVersion: ownerConnections.runtimeVersion,
    serverRole,
    takeoverState: ownerConnections.registry.takeover,
  }
}
