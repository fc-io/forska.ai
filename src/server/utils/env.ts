import {totalmem} from 'node:os'

import {type as arktype} from 'arktype'
import {existsSync, readFileSync} from 'fs'
import {dirname, resolve} from 'path'

import {DEFAULT_API_SERVER_PORT, DEFAULT_VITE_PORT} from '../../utils/runtimePortDefaults.ts'
import {getDefaultMaintenanceDuckdbMemoryLimit} from './duckdbMemoryDefaults.ts'
import {getDuckdbPath} from './getDuckdbPath.ts'
import {getRuntimeLogConfig} from './runtimeLogger.ts'

const envShape = arktype({
  DUCKDB_PATH: 'string',
  DUCKDB_MEMORY_LIMIT: 'string',
  DUCKDB_APPEND_LANE_COUNT: 'number | string.integer.parse | null | undefined',
  DUCKDB_TEMP_DIRECTORY: 'string | null | undefined',
  SERVER_ROLE: arktype('"api" | "maintenance-worker" | "judge-worker" | "auto" | "dev-single"'),
  SERVER_DUCKDB_OWNER_URL: 'string | null | undefined',
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
  PROJECT_MART_LARGE_REBUILD_BATCH_SIZE: 'number | string.integer.parse | null | undefined',
  PROJECT_MART_LARGE_REBUILD_MAX_CYCLES_PER_WAKE: 'number | string.integer.parse | null | undefined',
  PROJECT_MART_LARGE_REBUILD_POLL_INTERVAL_MS: 'number | string.integer.parse | null | undefined',
  FORSKA_REVIEW_SERVING_REBUILD_CHUNK_BATCH_MAX_RSS_BYTES: 'number | string.integer.parse | null | undefined',
  FORSKA_REVIEW_SERVING_REBUILD_CHUNK_BATCH_SIZE: 'number | string.integer.parse | null | undefined',
  FORSKA_DUCKDB_APPEND_TRANSACTION_ENABLED: arktype('"true" | "false" | boolean').pipe((v) => {
    return typeof v === 'string' ? v.toLowerCase() === 'true' : v
  }),
  JUDGE_WORKER_ID: 'string',
  JUDGE_WORKER_JOURNAL_PATH: 'string',
  FORSKA_RUNTIME_PROFILE: arktype('"local" | "primary" | "secondary"'),
  LOG_DIR: 'string',
  LOG_LEVEL: arktype('"DEBUG" | "INFO" | "WARN" | "ERROR"'),
  LOG_STDERR_LEVEL: arktype('"DEBUG" | "INFO" | "WARN" | "ERROR"'),
})

const gibibyte = 1024 ** 3
const defaultReviewServingRebuildChunkBatchSize = 2
const minimumReviewServingRebuildChunkBatchMaxRssBytes = 4 * gibibyte
const maximumReviewServingRebuildChunkBatchMaxRssBytes = 5 * gibibyte

export const getDefaultReviewServingRebuildChunkBatchMaxRssBytes = (totalMemoryBytes = totalmem()) => {
  const memoryBasedCapBytes = Math.floor(totalMemoryBytes * 0.7)

  return Math.max(
    minimumReviewServingRebuildChunkBatchMaxRssBytes,
    Math.min(maximumReviewServingRebuildChunkBatchMaxRssBytes, memoryBasedCapBytes),
  )
}

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

const shouldDefaultToMaintenanceDuckdbMemoryLimit = (serverRole: string | undefined) => {
  return serverRole === 'maintenance-worker' || serverRole === 'dev-single' || serverRole === 'auto'
}

export const loadEnv = ({
  cwd = process.cwd(),
  envValues = process.env,
}: {cwd?: string; envValues?: Record<string, string | undefined>} = {}): typeof envShape.infer => {
  const merged = getEnvWithFileFallback(envValues)
  if (merged.SERVER_ROLE == null || String(merged.SERVER_ROLE).trim() === '') {
    ;(merged as Record<string, string>).SERVER_ROLE = 'auto'
  }
  if (merged.SERVER_DUCKDB_OWNER_URL == null || String(merged.SERVER_DUCKDB_OWNER_URL).trim() === '') {
    ;(merged as Record<string, string>).SERVER_DUCKDB_OWNER_URL = ''
  }
  if (merged.VITE_PORT == null || String(merged.VITE_PORT).trim() === '') {
    ;(merged as Record<string, string>).VITE_PORT = String(DEFAULT_VITE_PORT)
  }
  if (merged.API_SERVER_PORT == null || String(merged.API_SERVER_PORT).trim() === '') {
    ;(merged as Record<string, string>).API_SERVER_PORT = String(DEFAULT_API_SERVER_PORT)
  }
  ;(merged as Record<string, string>).DUCKDB_PATH = getDuckdbPath({duckdbPath: merged.DUCKDB_PATH})
  if (merged.DUCKDB_MEMORY_LIMIT == null || String(merged.DUCKDB_MEMORY_LIMIT).trim() === '') {
    ;(merged as Record<string, string>).DUCKDB_MEMORY_LIMIT = shouldDefaultToMaintenanceDuckdbMemoryLimit(
      String(merged.SERVER_ROLE ?? ''),
    )
      ? getDefaultMaintenanceDuckdbMemoryLimit()
      : '20GB'
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
  if (
    merged.PROJECT_MART_LARGE_REBUILD_BATCH_SIZE == null
    || String(merged.PROJECT_MART_LARGE_REBUILD_BATCH_SIZE).trim() === ''
  ) {
    ;(merged as Record<string, string>).PROJECT_MART_LARGE_REBUILD_BATCH_SIZE = '128'
  }
  if (
    merged.PROJECT_MART_LARGE_REBUILD_MAX_CYCLES_PER_WAKE == null
    || String(merged.PROJECT_MART_LARGE_REBUILD_MAX_CYCLES_PER_WAKE).trim() === ''
  ) {
    ;(merged as Record<string, string>).PROJECT_MART_LARGE_REBUILD_MAX_CYCLES_PER_WAKE = '4'
  }
  if (
    merged.PROJECT_MART_LARGE_REBUILD_POLL_INTERVAL_MS == null
    || String(merged.PROJECT_MART_LARGE_REBUILD_POLL_INTERVAL_MS).trim() === ''
  ) {
    ;(merged as Record<string, string>).PROJECT_MART_LARGE_REBUILD_POLL_INTERVAL_MS = '1000'
  }
  if (
    merged.FORSKA_REVIEW_SERVING_REBUILD_CHUNK_BATCH_MAX_RSS_BYTES == null
    || String(merged.FORSKA_REVIEW_SERVING_REBUILD_CHUNK_BATCH_MAX_RSS_BYTES).trim() === ''
  ) {
    ;(merged as Record<string, string>).FORSKA_REVIEW_SERVING_REBUILD_CHUNK_BATCH_MAX_RSS_BYTES = String(
      getDefaultReviewServingRebuildChunkBatchMaxRssBytes(),
    )
  }
  if (
    merged.FORSKA_REVIEW_SERVING_REBUILD_CHUNK_BATCH_SIZE == null
    || String(merged.FORSKA_REVIEW_SERVING_REBUILD_CHUNK_BATCH_SIZE).trim() === ''
  ) {
    ;(merged as Record<string, string>).FORSKA_REVIEW_SERVING_REBUILD_CHUNK_BATCH_SIZE = String(
      defaultReviewServingRebuildChunkBatchSize,
    )
  }
  if (
    merged.FORSKA_DUCKDB_APPEND_TRANSACTION_ENABLED == null
    || String(merged.FORSKA_DUCKDB_APPEND_TRANSACTION_ENABLED).trim() === ''
  ) {
    ;(merged as Record<string, string>).FORSKA_DUCKDB_APPEND_TRANSACTION_ENABLED = 'false'
  }
  if (merged.JUDGE_WORKER_ID == null) {
    ;(merged as Record<string, string>).JUDGE_WORKER_ID = ''
  }
  if (merged.JUDGE_WORKER_JOURNAL_PATH == null) {
    ;(merged as Record<string, string>).JUDGE_WORKER_JOURNAL_PATH = ''
  }
  const runtimeLogConfig = getRuntimeLogConfig({cwd, envValues: merged})
  ;(merged as Record<string, string>).FORSKA_RUNTIME_PROFILE = runtimeLogConfig.runtimeProfile
  ;(merged as Record<string, string>).LOG_DIR = runtimeLogConfig.logDir
  ;(merged as Record<string, string>).LOG_LEVEL = runtimeLogConfig.logLevel
  ;(merged as Record<string, string>).LOG_STDERR_LEVEL = runtimeLogConfig.logStderrLevel
  return envShape.assert(merged)
}

export const getEnv = () => {
  return loadEnv()
}

export const env = loadEnv()
