import {constants} from 'node:fs'
import {access, mkdir} from 'node:fs/promises'
import {dirname} from 'node:path'

import {validateReadOnlyDuckdbService} from '../services/readOnlyDuckdbService.ts'
import {getEnv} from './env.ts'
import {runtimeReadyPath} from './runtimeReadyContract.ts'

export type OwnerlessReadableBackend = 'live-read-only-duckdb' | 'ownerless-control-state' | 'process-runtime-state'

type OwnerlessRouteDeclaration = {
  backends: OwnerlessReadableBackend[]
  method: 'GET' | 'POST'
  pathname: string
  routeKind: 'bootstrap' | 'diagnostics'
}

export type OwnerlessRouteBackendSelection = {
  backend: OwnerlessReadableBackend
  method: OwnerlessRouteDeclaration['method']
  pathname: string
  routeKind: OwnerlessRouteDeclaration['routeKind']
}

type OwnerlessRouteBackendState = {selections: OwnerlessRouteBackendSelection[]}

declare global {
  var __forskaOwnerlessRouteBackendState: OwnerlessRouteBackendState | undefined
}

const getOwnerlessRouteBackendState = () => {
  globalThis.__forskaOwnerlessRouteBackendState ??= {selections: []}

  return globalThis.__forskaOwnerlessRouteBackendState
}

const ownerlessRouteBackendState = getOwnerlessRouteBackendState()

export const ownerlessRouteDeclarations = [
  {backends: ['process-runtime-state'], method: 'GET', pathname: runtimeReadyPath, routeKind: 'bootstrap'},
  {
    backends: ['live-read-only-duckdb', 'ownerless-control-state'],
    method: 'GET',
    pathname: '/api/duckdb_owner_connections',
    routeKind: 'diagnostics',
  },
  {
    backends: ['ownerless-control-state'],
    method: 'POST',
    pathname: '/api/duckdb_owner_connections/heartbeat',
    routeKind: 'diagnostics',
  },
  {
    backends: ['ownerless-control-state', 'process-runtime-state'],
    method: 'GET',
    pathname: '/api/admin/worker-runtime-diagnostics',
    routeKind: 'diagnostics',
  },
  {
    backends: ['process-runtime-state'],
    method: 'GET',
    pathname: '/api/admin/judgment-dispatch-runtime/:jobId',
    routeKind: 'diagnostics',
  },
] satisfies OwnerlessRouteDeclaration[]

const getRouteLabel = (route: OwnerlessRouteDeclaration) => {
  return `${route.method} ${route.pathname}`
}

const getUniqueBackends = (backends: OwnerlessReadableBackend[]) => {
  return backends.filter((backend, index, values) => {
    return values.indexOf(backend) === index
  })
}

const validateProcessRuntimeStateBackend = async () => {
  return undefined
}

const validateOwnerlessControlStateBackend = async () => {
  const env = getEnv()

  if (env.DUCKDB_PATH === ':memory:') {
    throw new Error('ownerless control-state backend requires file-backed DUCKDB_PATH')
  }

  const controlStateDirectory = dirname(env.DUCKDB_PATH)

  await mkdir(controlStateDirectory, {recursive: true})
  await access(controlStateDirectory, constants.R_OK | constants.W_OK)
}

const validateLiveReadOnlyDuckdbBackend = async () => {
  await validateReadOnlyDuckdbService('api-read-only')
}

const validateOwnerlessBackend = async (backend: OwnerlessReadableBackend) => {
  return backend === 'process-runtime-state'
    ? validateProcessRuntimeStateBackend()
    : backend === 'ownerless-control-state'
      ? validateOwnerlessControlStateBackend()
      : validateLiveReadOnlyDuckdbBackend()
}

const getValidatedBackendSelection = async (
  route: OwnerlessRouteDeclaration,
  backends: OwnerlessReadableBackend[],
): Promise<OwnerlessRouteBackendSelection> => {
  const [backend, ...remainingBackends] = backends

  if (!backend) {
    throw new Error(`Ownerless route ${getRouteLabel(route)} has no configured ownerless-readable backend`)
  }

  try {
    await validateOwnerlessBackend(backend)

    return {backend, method: route.method, pathname: route.pathname, routeKind: route.routeKind}
  } catch (error) {
    if (remainingBackends.length === 0) {
      throw error
    }

    return getValidatedBackendSelection(route, remainingBackends)
  }
}

const validateOwnerlessRouteDeclaration = async (route: OwnerlessRouteDeclaration) => {
  return getValidatedBackendSelection(route, getUniqueBackends(route.backends))
}

export const validateOwnerlessRouteBackends = async () => {
  const selections = await Promise.all(
    ownerlessRouteDeclarations.map((route) => {
      return validateOwnerlessRouteDeclaration(route)
    }),
  )

  ownerlessRouteBackendState.selections = selections
  return selections
}

export const getOwnerlessRouteBackendSelections = () => {
  return [...ownerlessRouteBackendState.selections]
}

export const resetOwnerlessRouteBackendsForTests = () => {
  ownerlessRouteBackendState.selections = []
}
