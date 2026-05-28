import {expect, test} from 'bun:test'

import {classifyApiRoute} from './apiRouteClassification.ts'
import {duckdbOwnerConnectionsRoutes} from './DuckdbOwnerConnectionsRoutes.ts'
import {judgmentDispatchTelemetryRoutes} from './JudgmentDispatchTelemetryRoutes.ts'
import {getProductApiRoutes} from './productApiRoutes.ts'
import {publicRouteSurfaceGatedCategories} from './publicRouteSurfaceGate.ts'
import {
  getRouteSurfaceRouteKey,
  routeSurfaceEntrypoints,
  type RouteSurfaceRoute,
  routeSurfaceRoutes,
} from './routeSurfaceInventory.ts'
import {runtimeReadyRoutes} from './runtimeReadyRoutes.ts'

type MountedRoute = {method: string; path: string}

const getMountedRoutes = (): MountedRoute[] => {
  return [
    ...runtimeReadyRoutes.routes,
    ...duckdbOwnerConnectionsRoutes.routes,
    ...judgmentDispatchTelemetryRoutes.routes,
    ...getProductApiRoutes().routes,
  ].map((route) => {
    return {method: String(route.method).toUpperCase(), path: route.path}
  })
}

const getMountedRouteKey = ({method, path}: MountedRoute) => {
  return `${method.toUpperCase()} ${path}`
}

const getDuplicateValues = (values: string[]) => {
  return [
    ...new Set(
      values.filter((value, index) => {
        return values.indexOf(value) !== index
      }),
    ),
  ].sort()
}

const getInventoryKeys = () => {
  return routeSurfaceRoutes.map(getRouteSurfaceRouteKey)
}

const getMountedRouteKeys = () => {
  return getMountedRoutes().map(getMountedRouteKey)
}

const isSensitiveCategory = (category: RouteSurfaceRoute['category']) => {
  return [
    'internal-runtime-api',
    'local-diagnostics-api',
    'maintenance-debug-api',
    'remove-before-release',
    'sensitive-local-api',
  ].includes(category)
}

test('route surface inventory exactly covers mounted API routes', () => {
  const inventoryKeys = getInventoryKeys()
  const mountedRouteKeys = getMountedRouteKeys()
  const missingFromInventory = mountedRouteKeys.filter((key) => {
    return !inventoryKeys.includes(key)
  })
  const staleInventoryRoutes = inventoryKeys.filter((key) => {
    return !mountedRouteKeys.includes(key)
  })

  expect({missingFromInventory, staleInventoryRoutes}).toEqual({missingFromInventory: [], staleInventoryRoutes: []})
})

test('route surface inventory has no duplicate route keys', () => {
  expect(getDuplicateValues(getInventoryKeys())).toEqual([])
})

test('mounted API routes are explicit in the owner proxy classifier', () => {
  const unclassifiedRoutes = getMountedRoutes()
    .map((route) => {
      return {...route, classification: classifyApiRoute(route.path, route.method)}
    })
    .filter((route) => {
      return route.classification === 'unclassified'
    })

  expect(unclassifiedRoutes).toEqual([])
  expect(classifyApiRoute('/api/example', 'GET')).toBe('unclassified')
})

test('sensitive route categories carry an explicit sensitivity note', () => {
  const missingSensitivityRoutes = routeSurfaceRoutes.filter((route) => {
    return isSensitiveCategory(route.category) && String(route.sensitivity ?? '').trim() === ''
  })

  expect(missingSensitivityRoutes).toEqual([])
})

test('release-blocked current routes are explicit', () => {
  const blockedRouteKeys = routeSurfaceRoutes
    .filter((route) => {
      return route.category === 'remove-before-release'
    })
    .map(getRouteSurfaceRouteKey)

  expect(blockedRouteKeys).toEqual(['POST /api/datasources/import/fhir-ehr-patients'])
})

test('public route surface gate covers internal, diagnostics, debug, and remove-before-release categories', () => {
  expect([...publicRouteSurfaceGatedCategories].sort()).toEqual([
    'internal-runtime-api',
    'local-diagnostics-api',
    'maintenance-debug-api',
    'remove-before-release',
  ])
})

test('listener and proxy entrypoints are local by default', () => {
  const unsafeEntrypoints = routeSurfaceEntrypoints.filter((entrypoint) => {
    return entrypoint.defaultBind !== 'loopback' && entrypoint.defaultBind !== 'process-local'
  })

  expect(unsafeEntrypoints).toEqual([])
})
