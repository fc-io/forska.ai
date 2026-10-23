import {adminRouteSurfaceRoutes} from './routeSurfaceInventory/adminRouteSurfaceRoutes.ts'
import {articlesRouteSurfaceRoutes} from './routeSurfaceInventory/articlesRouteSurfaceRoutes.ts'
import {comparisonProjectsRouteSurfaceRoutes} from './routeSurfaceInventory/comparisonProjectsRouteSurfaceRoutes.ts'
import {dataSourcesRouteSurfaceRoutes} from './routeSurfaceInventory/dataSourcesRouteSurfaceRoutes.ts'
import {duckdbStudioRouteSurfaceRoutes} from './routeSurfaceInventory/duckdbStudioRouteSurfaceRoutes.ts'
import {humanAssessmentRouteSurfaceRoutes} from './routeSurfaceInventory/humanAssessmentRouteSurfaceRoutes.ts'
import {judgmentsJobsRouteSurfaceRoutes} from './routeSurfaceInventory/judgmentsJobsRouteSurfaceRoutes.ts'
import {llmStatusRouteSurfaceRoutes} from './routeSurfaceInventory/llmStatusRouteSurfaceRoutes.ts'
import {modelsAndProvidersRouteSurfaceRoutes} from './routeSurfaceInventory/modelsAndProvidersRouteSurfaceRoutes.ts'
import {nvidiaSmiRouteSurfaceRoutes} from './routeSurfaceInventory/nvidiaSmiRouteSurfaceRoutes.ts'
import {projectsRouteSurfaceRoutes} from './routeSurfaceInventory/projectsRouteSurfaceRoutes.ts'
import {promptsRouteSurfaceRoutes} from './routeSurfaceInventory/promptsRouteSurfaceRoutes.ts'
import type {RouteSurfaceRoute} from './routeSurfaceInventory/routeSurfaceInventoryTypes.ts'
import {runtimeAssetsRouteSurfaceRoutes} from './routeSurfaceInventory/runtimeAssetsRouteSurfaceRoutes.ts'
import {runtimeRouteSurfaceRoutes} from './routeSurfaceInventory/runtimeRouteSurfaceRoutes.ts'
import {subprojectsRouteSurfaceRoutes} from './routeSurfaceInventory/subprojectsRouteSurfaceRoutes.ts'
import {tokensRouteSurfaceRoutes} from './routeSurfaceInventory/tokensRouteSurfaceRoutes.ts'
import {usersRouteSurfaceRoutes} from './routeSurfaceInventory/usersRouteSurfaceRoutes.ts'

export {routeSurfaceEntrypoints} from './routeSurfaceInventory/routeSurfaceEntrypoints.ts'
export type {
  RouteSurfaceCategory,
  RouteSurfaceEntrypoint,
  RouteSurfaceProxyClassification,
  RouteSurfaceRoute,
} from './routeSurfaceInventory/routeSurfaceInventoryTypes.ts'

export const routeSurfaceRoutes: RouteSurfaceRoute[] = [
  ...runtimeRouteSurfaceRoutes,
  ...adminRouteSurfaceRoutes,
  ...comparisonProjectsRouteSurfaceRoutes,
  ...judgmentsJobsRouteSurfaceRoutes,
  ...articlesRouteSurfaceRoutes,
  ...humanAssessmentRouteSurfaceRoutes,
  ...modelsAndProvidersRouteSurfaceRoutes,
  ...projectsRouteSurfaceRoutes,
  ...promptsRouteSurfaceRoutes,
  ...runtimeAssetsRouteSurfaceRoutes,
  ...dataSourcesRouteSurfaceRoutes,
  ...duckdbStudioRouteSurfaceRoutes,
  ...tokensRouteSurfaceRoutes,
  ...usersRouteSurfaceRoutes,
  ...llmStatusRouteSurfaceRoutes,
  ...nvidiaSmiRouteSurfaceRoutes,
  ...subprojectsRouteSurfaceRoutes,
]

const normalizePathname = (pathname: string) => {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
}

const escapeRegex = (value: string) => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const getRoutePatternRegex = (path: string) => {
  const segments = path.split('/').map((segment) => {
    return segment.startsWith(':') ? '[^/]+' : escapeRegex(segment)
  })

  return new RegExp(`^${segments.join('/')}$`)
}

const routeSurfaceRouteMatchers = routeSurfaceRoutes.map((route) => {
  return {...route, regex: getRoutePatternRegex(route.path)}
})

export const getRouteSurfaceRouteKey = ({method, path}: Pick<RouteSurfaceRoute, 'method' | 'path'>) => {
  return `${method.toUpperCase()} ${normalizePathname(path)}`
}

export const findRouteSurfaceRoute = ({method, pathname}: {method: string; pathname: string}) => {
  const normalizedMethod = method.toUpperCase()
  const normalizedPathname = normalizePathname(pathname)
  const match = routeSurfaceRouteMatchers.find((route) => {
    return route.method === normalizedMethod && route.regex.test(normalizedPathname)
  })

  return match ?? null
}
