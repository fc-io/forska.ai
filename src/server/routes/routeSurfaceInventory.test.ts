import {readdirSync, readFileSync, statSync} from 'node:fs'
import {join} from 'node:path'

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
type SourceFile = {path: string; source: string}

const projectRoot = process.cwd()

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

const collectSourceFiles = (directory: string): string[] => {
  return readdirSync(join(projectRoot, directory)).flatMap((entry) => {
    const path = join(directory, entry)
    const absolutePath = join(projectRoot, path)

    if (statSync(absolutePath).isDirectory()) {
      return collectSourceFiles(path)
    }

    return /\.(tsx?|jsx?)$/.test(path) ? [path] : []
  })
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

const adminClientSurfaceFiles = (): SourceFile[] => {
  const files = [
    ...collectSourceFiles('src/app/routes/+admin'),
    'src/app/routes/+settings/+index.tsx',
    'src/components/Navigation.tsx',
  ]

  return files.map((path) => {
    return {path, source: readFileSync(join(projectRoot, path), 'utf8')}
  })
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

test('admin API routes stay classified as diagnostics, maintenance, sensitive, or local-only', () => {
  const allowedAdminCategories = new Set<RouteSurfaceRoute['category']>([
    'local-diagnostics-api',
    'maintenance-debug-api',
    'sensitive-local-api',
  ])
  const adminRoutes = routeSurfaceRoutes.filter((route) => {
    return route.path.startsWith('/api/admin') || route.path.includes('/api/admin/')
  })
  const invalidRoutes = adminRoutes.filter((route) => {
    return (
      !allowedAdminCategories.has(route.category)
      || String(route.releaseDecision ?? '').trim() === ''
      || String(route.sensitivity ?? '').trim() === ''
    )
  })

  expect(adminRoutes.length).toBeGreaterThan(0)
  expect(invalidRoutes).toEqual([])
})

test('admin client pages only call inventoried admin APIs and do not import server DB code', () => {
  const adminInventoryPaths = new Set(
    routeSurfaceRoutes
      .filter((route) => {
        return route.path.startsWith('/api/admin/')
      })
      .map((route) => {
        return route.path
      }),
  )
  const clientFiles = adminClientSurfaceFiles()
  const adminApiCalls = clientFiles.flatMap(({path, source}) => {
    return [...source.matchAll(/apiClient\.api\.admin\[['"]([^'"]+)['"]\]/g)].map((match) => {
      return {path, routePath: `/api/admin/${match[1]}`}
    })
  })
  const uninventoriedAdminApiCalls = adminApiCalls.filter((call) => {
    return !adminInventoryPaths.has(call.routePath)
  })
  const serverDbImports = clientFiles.filter(({source}) => {
    const importSpecifiers = [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((match) => {
      return match[1] ?? ''
    })

    return importSpecifiers.some((specifier) => {
      return (
        specifier.includes('/server/')
        || specifier.includes('@duckdb')
        || specifier.includes('appDatabaseService')
        || specifier.includes('duckdbService')
      )
    })
  })
  const retiredLegacyControlLeaks = clientFiles.filter(({source}) => {
    return (
      source.includes('/admin/project-mart-large-rebuild')
      || source.includes('projectMartLargeRebuildHeartbeat')
      || source.includes('project-mart-dirty-materialization-requeue')
      || source.includes('Maintenance rebuild tuning')
    )
  })

  expect(uninventoriedAdminApiCalls).toEqual([])
  expect(serverDbImports).toEqual([])
  expect(retiredLegacyControlLeaks).toEqual([])
})
