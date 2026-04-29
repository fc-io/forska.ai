import {type as arktype} from 'arktype'

import {DEFAULT_API_SERVER_PORT} from '../../utils/runtimePortDefaults.ts'
import {runtimeProfiles} from '../../utils/runtimeProfile.ts'
import {getDesktopApiOrigin} from './getDesktopApiOrigin.ts'

const envShape = arktype({VITE_SERVER_API: 'string'})
const desktopDefaultApiOrigin = 'http://127.0.0.1:32101'
const localHostnames = new Set(['127.0.0.1', '::1', '[::1]', 'localhost'])

const getTrimmedValue = (value: string | null | number | undefined): string | null => {
  const normalized = String(value ?? '').trim()
  return normalized === '' ? null : normalized
}

const trimTrailingSlash = (value: string | null): string | null => {
  return value ? value.replace(/\/+$/, '') : null
}

const getNormalizedLocationOrigin = (value: string | null | undefined): string | null => {
  const normalizedValue = trimTrailingSlash(getTrimmedValue(value))

  if (!normalizedValue) {
    return null
  }

  const protocol = new URL(normalizedValue).protocol

  return protocol === 'http:' || protocol === 'https:' ? normalizedValue : null
}

const isDesktopLocationProtocol = (value: string | null | undefined): boolean => {
  const normalizedValue = getTrimmedValue(value)

  return normalizedValue === 'views:' || normalizedValue === 'file:'
}

const getLocalRuntimeApiOrigin = (locationOrigin: string | null | undefined): string | null => {
  const normalizedLocationOrigin = getTrimmedValue(locationOrigin)

  if (!normalizedLocationOrigin) {
    return null
  }

  const parsedOrigin = new URL(normalizedLocationOrigin)
  const normalizedHostname = parsedOrigin.hostname.trim().toLowerCase()
  const matchingRuntimeProfile = Object.values(runtimeProfiles).find((runtimeProfile) => {
    return runtimeProfile.env.VITE_PORT === parsedOrigin.port
  })

  return localHostnames.has(normalizedHostname) && matchingRuntimeProfile
    ? `http://127.0.0.1:${matchingRuntimeProfile.env.API_SERVER_PORT}`
    : null
}

const getServerApiServerPort = (): string | undefined => {
  return typeof process === 'undefined' ? undefined : process.env.API_SERVER_PORT
}

export const resolveClientApiOrigin = ({
  apiServerPort,
  desktopOrigin,
  directOrigin,
  locationOrigin,
  locationProtocol,
}: {
  apiServerPort?: number | string | null | undefined
  desktopOrigin?: string | null | undefined
  directOrigin?: string | null | undefined
  locationOrigin?: string | null | undefined
  locationProtocol?: string | null | undefined
} = {}): string => {
  const resolvedDirectOrigin = trimTrailingSlash(getTrimmedValue(directOrigin))
  const resolvedDesktopOrigin = trimTrailingSlash(getTrimmedValue(desktopOrigin))
  const resolvedLocalRuntimeApiOrigin = getLocalRuntimeApiOrigin(locationOrigin)
  const resolvedLocationOrigin = getNormalizedLocationOrigin(locationOrigin)
  const resolvedApiServerPort = getTrimmedValue(apiServerPort) ?? String(DEFAULT_API_SERVER_PORT)
  const resolvedDesktopFallbackOrigin = isDesktopLocationProtocol(locationProtocol) ? desktopDefaultApiOrigin : null

  return (
    resolvedDesktopOrigin
    ?? resolvedDirectOrigin
    ?? resolvedLocalRuntimeApiOrigin
    ?? resolvedLocationOrigin
    ?? resolvedDesktopFallbackOrigin
    ?? `http://127.0.0.1:${resolvedApiServerPort}`
  )
}

const loadEnv = (): typeof envShape.infer => {
  return envShape.assert({
    VITE_SERVER_API: resolveClientApiOrigin({
      directOrigin: import.meta.env.VITE_SERVER_API,
      desktopOrigin: getDesktopApiOrigin(),
      locationOrigin: typeof window === 'undefined' ? undefined : window.location.origin,
      locationProtocol: typeof window === 'undefined' ? undefined : window.location.protocol,
      apiServerPort: getServerApiServerPort(),
    }),
  })
}

export const env = loadEnv()
