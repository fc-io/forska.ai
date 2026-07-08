import {Elysia} from 'elysia'

import {getRuntimeCutoverVersion, probeDuckdbOwnerRuntimeReadiness} from '../utils/runtimeCutover.ts'
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

const getOwnerProxyReady = async (duckdbOwnerUrl: string | null, ownerProxy: boolean) => {
  if (!ownerProxy) {
    return true
  }

  if (duckdbOwnerUrl === null) {
    return false
  }

  const result = await probeDuckdbOwnerRuntimeReadiness(duckdbOwnerUrl, 'runtime readiness DuckDB owner')

  return result.status === 'compatible'
}

const getConfiguredDuckdbOwnerUrl = () => {
  const value = process.env.SERVER_DUCKDB_OWNER_URL?.trim() ?? ''

  return value === '' ? null : value
}

const getRuntimeReadyDuckdbOwnerUrl = () => {
  return getKnownDuckdbOwnerUrl() ?? getConfiguredDuckdbOwnerUrl()
}

export const runtimeReadyRoutes = new Elysia()
  .get(runtimeReadyPath, async () => {
    const role = getCurrentServerRole()
    const duckdbOwnerUrl = getRuntimeReadyDuckdbOwnerUrl()
    const ownerProxy = shouldCurrentServerProxyApiToOwner()
    const ready = await getOwnerProxyReady(duckdbOwnerUrl, ownerProxy)

    return {
      data: {
        capabilities: getServerRoleCapabilities(role),
        duckdbOwner: canCurrentServerOwnDuckdb(),
        duckdbOwnerUrl,
        localOperatorApiExposed: isLocalOperatorApiExposed(),
        ownerProxy,
        ready,
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
