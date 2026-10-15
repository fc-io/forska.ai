import {runtimeProfiles} from '../../utils/runtimeProfile.ts'

const localHostnames = new Set(['127.0.0.1', '::1', '[::1]', 'localhost'])

const getTrimmedValue = (value: string | null | undefined) => {
  const normalizedValue = String(value ?? '').trim()

  return normalizedValue === '' ? null : normalizedValue
}

const getDirectLocalApiOrigin = (locationOrigin: string | null | undefined) => {
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

const getCurrentLocationOrigin = () => {
  return typeof window === 'undefined' ? null : window.location.origin
}

export const getApiRequestUrl = (path: string, locationOrigin = getCurrentLocationOrigin()) => {
  const directLocalApiOrigin = getDirectLocalApiOrigin(locationOrigin)

  return directLocalApiOrigin ? `${directLocalApiOrigin}${path}` : path
}
