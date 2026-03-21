import {type as arktype} from 'arktype'
import {existsSync, readFileSync} from 'fs'
import {dirname, resolve} from 'path'

import {getDuckdbPath} from './getDuckdbPath.ts'

const envShape = arktype({
  DUCKDB_PATH: 'string',
  DUCKDB_MEMORY_LIMIT: 'string',
  DUCKDB_TEMP_DIRECTORY: 'string | null | undefined',
  SERVER_ROLE: arktype('"auto" | "writer" | "api" | "worker" | "dev-single"'),
  SERVER_WRITER_URL: 'string | null | undefined',
  VITE_PORT: 'number | string.integer.parse',
  API_SERVER_PORT: 'number | string.integer.parse',
  RUN_SERVER_FULL_TEXT_FETCHING: arktype('"true" | "false" | boolean').pipe((v) => {
    return typeof v === 'string' ? v.toLowerCase() === 'true' : v
  }),
  RUN_SERVER_JUDGING: arktype('"true" | "false" | boolean').pipe((v) => {
    return typeof v === 'string' ? v.toLowerCase() === 'true' : v
  }),
  RUN_SERVER_FULL_TEXT_CONVERSION_CRON: arktype('"true" | "false" | boolean').pipe((v) => {
    return typeof v === 'string' ? v.toLowerCase() === 'true' : v
  }),
  DOCLING_SERVE_URL: 'string | null | undefined',
  FULL_TEXT_CONVERSION_BATCH_SIZE: 'number | string.integer.parse | null | undefined',
  FULL_TEXT_CONVERSION_CONCURRENCY: 'number | string.integer.parse | null | undefined',
})

const readFromFileVar = (key: string): string | undefined => {
  const fileVar = `${key}_FILE`
  const filePath = process.env[fileVar]
  return filePath && existsSync(filePath) ? readFileSync(filePath, 'utf8').trim() : undefined
}

const getEnvWithFileFallback = (): Record<string, string | undefined> => {
  const source = {...process.env}
  const withFile = (k: string): void => {
    if (!source[k]) {
      const v = readFromFileVar(k)
      if (v) source[k] = v
    }
  }
  withFile('DUCKDB_PATH')
  return source
}

const loadEnv = (): typeof envShape.infer => {
  const merged = getEnvWithFileFallback()
  // Default to true when not provided
  if (merged.RUN_SERVER_JUDGING == null || merged.RUN_SERVER_JUDGING === '') {
    // string form to satisfy shape before parsing to boolean via pipe
    ;(merged as Record<string, string>).RUN_SERVER_JUDGING = 'true'
  }
  if (merged.SERVER_ROLE == null || String(merged.SERVER_ROLE).trim() === '') {
    ;(merged as Record<string, string>).SERVER_ROLE = 'auto'
  }
  if (merged.SERVER_WRITER_URL == null || String(merged.SERVER_WRITER_URL).trim() === '') {
    ;(merged as Record<string, string>).SERVER_WRITER_URL = ''
  }
  ;(merged as Record<string, string>).DUCKDB_PATH = getDuckdbPath({duckdbPath: merged.DUCKDB_PATH})
  if (merged.DUCKDB_MEMORY_LIMIT == null || String(merged.DUCKDB_MEMORY_LIMIT).trim() === '') {
    ;(merged as Record<string, string>).DUCKDB_MEMORY_LIMIT = '20GB'
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
  // Provide a stable default when DOCLING_SERVE_URL is not provided
  if (merged.DOCLING_SERVE_URL == null || String(merged.DOCLING_SERVE_URL).trim() === '') {
    ;(merged as Record<string, string>).DOCLING_SERVE_URL = 'http://localhost:5001'
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
