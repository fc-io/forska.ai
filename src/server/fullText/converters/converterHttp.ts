import {unzipSync} from 'fflate'

import {ConversionError} from './conversionError.ts'

export type ConverterZipEntries = Record<string, Uint8Array>

const permanentConverterStatuses = [400, 401, 403, 404, 413, 415, 422, 504]
const connectionFailureMarkers = [
  'econnrefused',
  'connectionrefused',
  'unable to connect',
  'etimedout',
  'timed out',
  'enotfound',
  'network',
  'socket',
]
const textDecoder = new TextDecoder()

const getErrorCode = (error: unknown): string => {
  return error instanceof Error && 'code' in error ? String(error.code) : ''
}

const isTimeoutError = (error: unknown): boolean => {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

const isConnectionFailure = (error: unknown): boolean => {
  const searchable = `${error instanceof Error ? error.message : String(error)} ${getErrorCode(error)}`.toLowerCase()

  return connectionFailureMarkers.some((marker) => {
    return searchable.includes(marker)
  })
}

export const getFileSizeMB = (bytes: Uint8Array): string => {
  return (bytes.byteLength / (1024 * 1024)).toFixed(2)
}

export const getConverterRoute = (baseURL: string, route: string): string => {
  return `${baseURL.replace(/\/+$/, '')}${route}`
}

const getConverterFetchError = ({
  error,
  fileSizeMB,
  label,
  timeoutMs,
}: {
  error: unknown
  fileSizeMB: string
  label: string
  timeoutMs: number
}): ConversionError => {
  return isTimeoutError(error)
    ? new ConversionError(`${label} conversion timed out after ${timeoutMs}ms (file: ${fileSizeMB}MB)`)
    : new ConversionError(
        `${label} conversion failed: ${error instanceof Error ? error.message : String(error)} (file: ${fileSizeMB}MB)`,
        undefined,
        !isConnectionFailure(error),
      )
}

export const getConverterResponseError = async ({
  fileSizeMB,
  label,
  response,
}: {
  fileSizeMB: string
  label: string
  response: Response
}): Promise<ConversionError> => {
  const body = await response.text().catch(() => {
    return ''
  })
  const details = body ? ` - ${body.slice(0, 500)}` : ''
  const isPermanent =
    permanentConverterStatuses.includes(response.status) || body.toLowerCase().includes('taking too long')

  return new ConversionError(
    `${label} conversion failed: ${response.status} ${response.statusText}${details} (file: ${fileSizeMB}MB)`,
    response.status,
    isPermanent,
  )
}

export const sendConverterRequest = async ({
  fileSizeMB,
  init,
  label,
  timeoutMs,
  url,
}: {
  fileSizeMB: string
  init: RequestInit
  label: string
  timeoutMs: number
  url: string
}): Promise<Response> => {
  return fetch(url, {...init, signal: AbortSignal.timeout(timeoutMs)}).catch((error: unknown) => {
    throw getConverterFetchError({error, fileSizeMB, label, timeoutMs})
  })
}

export const readConverterBytes = async ({
  fileSizeMB,
  label,
  response,
  timeoutMs,
}: {
  fileSizeMB: string
  label: string
  response: Response
  timeoutMs: number
}): Promise<Uint8Array> => {
  const buffer = await response.arrayBuffer().catch((error: unknown) => {
    throw getConverterFetchError({error, fileSizeMB, label, timeoutMs})
  })

  return new Uint8Array(buffer)
}

export const readConverterZip = (bytes: Uint8Array, label: string): ConverterZipEntries => {
  try {
    return unzipSync(bytes)
  } catch (error) {
    throw new ConversionError(
      `${label} returned an unreadable zip: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export const getZipText = (entries: ConverterZipEntries, path: string): string | null => {
  const bytes = entries[path]

  return bytes ? textDecoder.decode(bytes) : null
}

export const parseConverterJson = (text: string, label: string): unknown => {
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new ConversionError(
      `${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export const getZipFileExtension = (path: string): string => {
  const match = /\.([a-z0-9]+)$/i.exec(path)

  return match?.[1]?.toLowerCase() ?? 'bin'
}

export const roundBoundingBoxValue = (value: number): number => {
  return Math.round(value * 10_000) / 10_000
}
