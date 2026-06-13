import {Elysia} from 'elysia'

import {getRuntimeCutoverVersion} from '../utils/runtimeCutover.ts'
import {runtimeReadyPath, runtimeStatePath} from '../utils/runtimeReadyContract.ts'
import {getServerRoleCapabilities} from '../utils/serverRole.ts'
import {
  canCurrentServerOwnDuckdb,
  getCurrentServerRole,
  getKnownDuckdbOwnerUrl,
  shouldCurrentServerProxyApiToOwner,
} from '../utils/serverRuntimeRole.ts'
import {isLocalOperatorApiExposed} from './publicRouteSurfaceGate.ts'

const bunDefaultMaxHttpRequests = 256

const getBunMaxHttpRequestsState = () => {
  const configuredValue = process.env.BUN_CONFIG_MAX_HTTP_REQUESTS?.trim() ?? null
  const parsedValue = Number.parseInt(configuredValue ?? '', 10)
  const configuredMaxHttpRequests = Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : null

  return {
    configuredMaxHttpRequests,
    defaultMaxHttpRequests: bunDefaultMaxHttpRequests,
    effectiveMaxHttpRequests: configuredMaxHttpRequests ?? bunDefaultMaxHttpRequests,
    source: configuredMaxHttpRequests === null ? 'default' : 'env',
  }
}

export const runtimeReadyRoutes = new Elysia()
  .get(runtimeReadyPath, () => {
    const role = getCurrentServerRole()

    return {
      data: {
        capabilities: getServerRoleCapabilities(role),
        duckdbOwner: canCurrentServerOwnDuckdb(),
        duckdbOwnerUrl: getKnownDuckdbOwnerUrl(),
        localOperatorApiExposed: isLocalOperatorApiExposed(),
        ownerProxy: shouldCurrentServerProxyApiToOwner(),
        ready: true,
        role,
        runtimeVersion: getRuntimeCutoverVersion(),
        settingsDiagnosticsApiExposed: true,
      },
      error: null,
    }
  })
  .get(runtimeStatePath, () => {
    return {
      data: {
        bun: {maxHttpRequests: getBunMaxHttpRequestsState()},
        pid: process.pid,
        role: getCurrentServerRole(),
        runtimeVersion: getRuntimeCutoverVersion(),
        serverRole: process.env.SERVER_ROLE ?? null,
      },
      error: null,
    }
  })
