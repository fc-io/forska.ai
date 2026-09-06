import {Elysia} from 'elysia'

import {getActiveDuckdbExclusiveWorkSnapshot} from '../utils/duckdbExclusiveWork.ts'
import {getDuckdbServiceReadinessSnapshot} from '../utils/duckdbService.ts'
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
const ownerProxyReadinessFreshMs = 30_000

let lastCompatibleOwnerReadiness: {checkedAtMs: number; duckdbOwnerUrl: string} | null = null

export const resetRuntimeReadyOwnerProbeCacheForTests = () => {
  lastCompatibleOwnerReadiness = null
}

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
    lastCompatibleOwnerReadiness = null
    return false
  }

  const result = await probeDuckdbOwnerRuntimeReadiness(duckdbOwnerUrl, 'runtime readiness DuckDB owner')
  const now = Date.now()

  if (result.status === 'compatible') {
    lastCompatibleOwnerReadiness = {checkedAtMs: now, duckdbOwnerUrl}
    return true
  }

  if (result.status === 'unreachable') {
    const freshOwner =
      lastCompatibleOwnerReadiness?.duckdbOwnerUrl === duckdbOwnerUrl
      && now - lastCompatibleOwnerReadiness.checkedAtMs <= ownerProxyReadinessFreshMs

    if (freshOwner) {
      return true
    }
  }

  if (result.status === 'incompatible') {
    lastCompatibleOwnerReadiness = null
  }

  return false
}

const getConfiguredDuckdbOwnerUrl = () => {
  const value = process.env.SERVER_DUCKDB_OWNER_URL?.trim() ?? ''

  return value === '' ? null : value
}

const getRuntimeReadyDuckdbOwnerUrl = () => {
  return getKnownDuckdbOwnerUrl() ?? getConfiguredDuckdbOwnerUrl()
}

const getLocalDuckdbOwnerReady = (role: ReturnType<typeof getCurrentServerRole>) => {
  if (role !== 'maintenance-worker') {
    return true
  }

  return getDuckdbServiceReadinessSnapshot().ready
}

export const runtimeReadyRoutes = new Elysia()
  .get(runtimeReadyPath, async () => {
    const role = getCurrentServerRole()
    const duckdbOwnerUrl = getRuntimeReadyDuckdbOwnerUrl()
    const ownerProxy = shouldCurrentServerProxyApiToOwner()
    const ownerProxyReady = await getOwnerProxyReady(duckdbOwnerUrl, ownerProxy)
    const localDuckdbOwnerReady = getLocalDuckdbOwnerReady(role)
    const ready = ownerProxyReady && localDuckdbOwnerReady

    return {
      data: {
        capabilities: getServerRoleCapabilities(role),
        duckdbOwner: canCurrentServerOwnDuckdb(),
        duckdbOwnerUrl,
        duckdbExclusiveWork: {active: getActiveDuckdbExclusiveWorkSnapshot() !== null},
        duckdbService: canCurrentServerOwnDuckdb() ? getDuckdbServiceReadinessSnapshot() : null,
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
        duckdbExclusiveWork: {
          active: getActiveDuckdbExclusiveWorkSnapshot() !== null,
          current: getActiveDuckdbExclusiveWorkSnapshot(),
        },
        pid: process.pid,
        role: getCurrentServerRole(),
        runtimeVersion: getRuntimeCutoverVersion(),
        serverRole: process.env.SERVER_ROLE ?? null,
      },
      error: null,
    }
  })
