import {hostname as getHostname} from 'node:os'

import {DEFAULT_API_SERVER_PORT, DEFAULT_APP_SERVER_PORT} from '../../utils/runtimePortDefaults.ts'
import {getRuntimeLogProfile, type RuntimeLogProfile} from './runtimeLogger.ts'

export type RuntimeProcessServiceName =
  | 'api-server'
  | 'app-server'
  | 'dev-single-server'
  | 'judge-worker-server'
  | 'maintenance-worker-server'
  | 'single-server'

export type RuntimeProcessServerRole = 'api' | 'auto' | 'dev-single' | 'judge-worker' | 'maintenance-worker'

export type RuntimeProcessIdentity = {
  hostname: string
  instanceId: string
  listenPort: number
  pid: number
  processStartedAt: string
  runtimeProfile: RuntimeLogProfile
  service: RuntimeProcessServiceName
}

export type RuntimeProcessLogIdentity =
  | RuntimeProcessIdentity
  | (RuntimeProcessIdentity & {serverRole: RuntimeProcessServerRole})

type RuntimeProcessIdentityOptions = {
  envValues?: Record<string, string | undefined>
  hostnameValue?: string
  listenPort?: number
  pid?: number
  processStartedAt?: string
  runtimeProfile?: RuntimeLogProfile
  service?: RuntimeProcessServiceName
}

type RuntimeProcessIdentityState = {identity: RuntimeProcessIdentity | null}

declare global {
  var __forskaRuntimeProcessIdentityState: RuntimeProcessIdentityState | undefined
}

const runtimeProcessServiceNames = [
  'api-server',
  'app-server',
  'dev-single-server',
  'judge-worker-server',
  'maintenance-worker-server',
  'single-server',
] as const

const getRuntimeProcessIdentityState = () => {
  globalThis.__forskaRuntimeProcessIdentityState ??= {identity: null}

  return globalThis.__forskaRuntimeProcessIdentityState
}

const getTrimmedValue = (value: string | null | undefined) => {
  const normalizedValue = String(value ?? '').trim()

  return normalizedValue === '' ? null : normalizedValue
}

const getNumberValue = (value: string | null | undefined) => {
  const normalizedValue = getTrimmedValue(value)
  const numericValue = Number(normalizedValue)

  return normalizedValue === null || !Number.isFinite(numericValue) ? null : numericValue
}

const getRuntimeProcessServiceName = (value: string | null | undefined): RuntimeProcessServiceName => {
  const normalizedValue = getTrimmedValue(value)
  const matchedServiceName = runtimeProcessServiceNames.find((serviceName) => {
    return serviceName === normalizedValue
  })

  return matchedServiceName ?? 'single-server'
}

const getDefaultListenPort = (service: RuntimeProcessServiceName, envValues: Record<string, string | undefined>) => {
  return service === 'app-server'
    ? (getNumberValue(envValues.APP_SERVER_PORT) ?? getNumberValue(envValues.PROD_SERVER) ?? DEFAULT_APP_SERVER_PORT)
    : (getNumberValue(envValues.API_SERVER_PORT) ?? DEFAULT_API_SERVER_PORT)
}

const getRuntimeInstanceId = (identity: Omit<RuntimeProcessIdentity, 'instanceId'>) => {
  return `${identity.service}:${identity.hostname}:${identity.listenPort}:${identity.pid}:${identity.processStartedAt}`
}

export const resolveRuntimeProcessIdentity = ({
  envValues = process.env,
  hostnameValue = getHostname(),
  listenPort,
  pid = process.pid,
  processStartedAt = new Date().toISOString(),
  runtimeProfile,
  service,
}: RuntimeProcessIdentityOptions = {}): RuntimeProcessIdentity => {
  const resolvedService = service ?? getRuntimeProcessServiceName(envValues.FORSKA_RUNTIME_SERVICE)
  const identity = {
    hostname: hostnameValue,
    listenPort: listenPort ?? getDefaultListenPort(resolvedService, envValues),
    pid,
    processStartedAt,
    runtimeProfile: runtimeProfile ?? getRuntimeLogProfile({envValues}),
    service: resolvedService,
  }

  return {...identity, instanceId: getRuntimeInstanceId(identity)}
}

export const initializeRuntimeProcessIdentity = (options: RuntimeProcessIdentityOptions = {}) => {
  const state = getRuntimeProcessIdentityState()

  if (state.identity === null) {
    state.identity = resolveRuntimeProcessIdentity(options)
  }

  return state.identity
}

export const getRuntimeProcessIdentity = (options: RuntimeProcessIdentityOptions = {}) => {
  return initializeRuntimeProcessIdentity(options)
}

export const getRuntimeProcessLogIdentity = ({
  identity = getRuntimeProcessIdentity(),
  serverRole,
}: {identity?: RuntimeProcessIdentity; serverRole?: RuntimeProcessServerRole} = {}): RuntimeProcessLogIdentity => {
  return identity.service === 'app-server' || serverRole === undefined ? identity : {...identity, serverRole}
}

export const resetRuntimeProcessIdentityForTests = () => {
  getRuntimeProcessIdentityState().identity = null
}
