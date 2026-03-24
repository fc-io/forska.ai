import {existsSync, readFileSync} from 'fs'
import {dirname, resolve} from 'path'

import {type as arktype} from 'arktype'

import {DEFAULT_API_SERVER_PORT, DEFAULT_VITE_PORT} from '../../utils/runtimePortDefaults.ts'
import {getDuckdbPath} from './getDuckdbPath.ts'

const envShape = arktype({
  DUCKDB_PATH: 'string',
  DUCKDB_MEMORY_LIMIT: 'string',
  DUCKDB_APPEND_LANE_COUNT: 'number | string.integer.parse | null | undefined',
  DUCKDB_TEMP_DIRECTORY: 'string | null | undefined',
  SERVER_ROLE: arktype('"auto" | "writer" | "api" | "worker" | "dev-single"'),
  SERVER_WRITER_URL: 'string | null | undefined',
  VITE_PORT: 'number | string.integer.parse',
  API_SERVER_PORT: 'number | string.integer.parse',
  RUN_SERVER_FULL_TEXT_FETCHING: arktype('"true" | "false" | boolean').pipe((v) => {
    return typeof v === 'string' ? v.toLowerCase() === 'true' : v
  }),
  RUN_SERVER_FULL_TEXT_CONVERSION_CRON: arktype('"true" | "false" | boolean').pipe((v) => {
    return typeof v === 'string' ? v.toLowerCase() === 'true' : v
  }),
  FULL_TEXT_CONVERSION_BATCH_SIZE: 'number | string.integer.parse | null | undefined',
  FULL_TEXT_CONVERSION_CONCURRENCY: 'number | string.integer.parse | null | undefined',
})

const readFromFileVar = (envValues: Record<string, string | undefined>, key: string): string | undefined => {
  const fileVar = `${key}_FILE`
  const filePath = envValues[fileVar]
  return filePath && existsSync(filePath) ? readFileSync(filePath, 'utf8').trim() : undefined
}

const getEnvWithFileFallback = (envValues: Record<string, string | undefined>): Record<string, string | undefined> => {
  const source = {...envValues}
  const withFile = (k: string): void => {
    if (!source[k]) {
      const v = readFromFileVar(envValues, k)
      if (v) source[k] = v
    }
  }
  withFile('DUCKDB_PATH')
  return source
}

export const loadEnv = ({
  envValues = process.env,
}: {envValues?: Record<string, string | undefined>} = {}): typeof envShape.infer => {
  const merged = getEnvWithFileFallback(envValues)
  if (merged.SERVER_ROLE == null || String(merged.SERVER_ROLE).trim() === '') {
    ;(merged as Record<string, string>).SERVER_ROLE = 'auto'
  }
  if (merged.SERVER_WRITER_URL == null || String(merged.SERVER_WRITER_URL).trim() === '') {
    ;(merged as Record<string, string>).SERVER_WRITER_URL = ''
  }
  if (merged.VITE_PORT == null || String(merged.VITE_PORT).trim() === '') {
    ;(merged as Record<string, string>).VITE_PORT = String(DEFAULT_VITE_PORT)
  }
  if (merged.API_SERVER_PORT == null || String(merged.API_SERVER_PORT).trim() === '') {
    ;(merged as Record<string, string>).API_SERVER_PORT = String(DEFAULT_API_SERVER_PORT)
  }
  ;(merged as Record<string, string>).DUCKDB_PATH = getDuckdbPath({duckdbPath: merged.DUCKDB_PATH})
  if (merged.DUCKDB_MEMORY_LIMIT == null || String(merged.DUCKDB_MEMORY_LIMIT).trim() === '') {
    ;(merged as Record<string, string>).DUCKDB_MEMORY_LIMIT = '20GB'
  }
  if (merged.DUCKDB_APPEND_LANE_COUNT == null || String(merged.DUCKDB_APPEND_LANE_COUNT).trim() === '') {
    ;(merged as Record<string, string>).DUCKDB_APPEND_LANE_COUNT = '2'
  }
  if (merged.DUCKDB_TEMP_DIRECTORY == null || String(merged.DUCKDB_TEMP_DIRECTORY).trim() === '') {
    const duckdbPath = String(merged.DUCKDB_PATH ?? '')
    const defaultTempDirectory = duckdbPath === ':memory:' ? undefined : resolve(dirname(duckdbPath), 'duckdb-temp')
    merged.DUCKDB_TEMP_DIRECTORY = defaultTempDirectory
  }
  // Default to false when not provided (prevents accidental background fetching)
  if (merged.RUN_SERVER_FULL_TEXT_FETCHING == null || merged.RUN_SERVER_FULL_TEXT_FETCHING === '') {
    ;(merged as Record<string, string>).RUN_SERVER_FULL_TEXT_FETCHING = 'false'
  }
  // Default to false when not provided (prevents accidental background conversion)
  if (merged.RUN_SERVER_FULL_TEXT_CONVERSION_CRON == null || merged.RUN_SERVER_FULL_TEXT_CONVERSION_CRON === '') {
    ;(merged as Record<string, string>).RUN_SERVER_FULL_TEXT_CONVERSION_CRON = 'false'
  }
  if (merged.FULL_TEXT_CONVERSION_BATCH_SIZE == null || String(merged.FULL_TEXT_CONVERSION_BATCH_SIZE).trim() === '') {
    ;(merged as Record<string, string>).FULL_TEXT_CONVERSION_BATCH_SIZE = '5'
  }
  if (
    merged.FULL_TEXT_CONVERSION_CONCURRENCY == null
    || String(merged.FULL_TEXT_CONVERSION_CONCURRENCY).trim() === ''
  ) {
    ;(merged as Record<string, string>).FULL_TEXT_CONVERSION_CONCURRENCY = '1'
  }
  return envShape.assert(merged)
}

export const env = loadEnv()
