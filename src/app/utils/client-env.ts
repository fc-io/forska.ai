import {type as arktype} from 'arktype'

import {DEFAULT_API_SERVER_PORT} from '../../utils/runtimePortDefaults.ts'

const envShape = arktype({VITE_SERVER_API: 'string'})

const getTrimmedValue = (value: string | null | number | undefined): string | null => {
  const normalized = String(value ?? '').trim()
  return normalized === '' ? null : normalized
}

const trimTrailingSlash = (value: string | null): string | null => {
  return value ? value.replace(/\/+$/, '') : null
}

const getServerApiServerPort = (): string | undefined => {
  return typeof process === 'undefined' ? undefined : process.env.API_SERVER_PORT
}

export const resolveClientApiOrigin = ({
  apiServerPort,
  directOrigin,
  locationOrigin,
}: {
  apiServerPort?: number | string | null | undefined
  directOrigin?: string | null | undefined
  locationOrigin?: string | null | undefined
} = {}): string => {
  const resolvedDirectOrigin = trimTrailingSlash(getTrimmedValue(directOrigin))
  const resolvedLocationOrigin = trimTrailingSlash(getTrimmedValue(locationOrigin))
  const resolvedApiServerPort = getTrimmedValue(apiServerPort) ?? String(DEFAULT_API_SERVER_PORT)
  return resolvedDirectOrigin ?? resolvedLocationOrigin ?? `http://127.0.0.1:${resolvedApiServerPort}`
}

const loadEnv = (): typeof envShape.infer => {
  console.log(import.meta.env.VITE_SERVER_API)
  return envShape.assert({
    VITE_SERVER_API: resolveClientApiOrigin({
      directOrigin: import.meta.env.VITE_SERVER_API,
      locationOrigin: typeof window === 'undefined' ? undefined : window.location.origin,
      apiServerPort: getServerApiServerPort(),
    }),
  })
}

export const env = loadEnv()
