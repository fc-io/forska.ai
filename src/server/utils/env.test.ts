import {expect, test} from 'bun:test'

import {getDefaultReviewServingRebuildChunkBatchMaxRssBytes, loadEnv} from './env.ts'

test('uses local dev port defaults without env files', () => {
  const resolvedEnv = loadEnv({envValues: {}})

  expect(resolvedEnv.VITE_PORT).toBe(3000)
  expect(resolvedEnv.API_SERVER_PORT).toBe(3001)
  expect(resolvedEnv.DUCKDB_APPEND_LANE_COUNT).toBe(2)
  expect(resolvedEnv.PROJECT_MART_LARGE_REBUILD_BATCH_SIZE).toBe(128)
  expect(resolvedEnv.PROJECT_MART_LARGE_REBUILD_MAX_CYCLES_PER_WAKE).toBe(4)
  expect(resolvedEnv.PROJECT_MART_LARGE_REBUILD_POLL_INTERVAL_MS).toBe(1000)
  expect(resolvedEnv.FORSKA_REVIEW_SERVING_REBUILD_CHUNK_BATCH_MAX_RSS_BYTES).toBe(
    getDefaultReviewServingRebuildChunkBatchMaxRssBytes(),
  )
  expect(resolvedEnv.FORSKA_REVIEW_SERVING_REBUILD_CHUNK_BATCH_SIZE).toBe(2)
  expect(resolvedEnv.FORSKA_DUCKDB_APPEND_TRANSACTION_ENABLED).toBe(false)
  expect(resolvedEnv.FORSKA_RUNTIME_PROFILE).toBe('local')
  expect(resolvedEnv.LOG_DIR).toBe(`${process.cwd()}/logs/runtime/local`)
  expect(resolvedEnv.LOG_LEVEL).toBe('INFO')
  expect(resolvedEnv.LOG_STDERR_LEVEL).toBe('WARN')
})

test('preserves explicit review serving rebuild chunk batch overrides', () => {
  const resolvedEnv = loadEnv({
    envValues: {
      FORSKA_REVIEW_SERVING_REBUILD_CHUNK_BATCH_MAX_RSS_BYTES: '0',
      FORSKA_REVIEW_SERVING_REBUILD_CHUNK_BATCH_SIZE: '1',
    },
  })

  expect(resolvedEnv.FORSKA_REVIEW_SERVING_REBUILD_CHUNK_BATCH_MAX_RSS_BYTES).toBe(0)
  expect(resolvedEnv.FORSKA_REVIEW_SERVING_REBUILD_CHUNK_BATCH_SIZE).toBe(1)
})

test('preserves explicit DuckDB append transaction opt-in', () => {
  const resolvedEnv = loadEnv({envValues: {FORSKA_DUCKDB_APPEND_TRANSACTION_ENABLED: 'true'}})

  expect(resolvedEnv.FORSKA_DUCKDB_APPEND_TRANSACTION_ENABLED).toBe(true)
})

test('bounds default review serving rebuild chunk batch RSS cap from system memory', () => {
  const gibibyte = 1024 ** 3

  expect(getDefaultReviewServingRebuildChunkBatchMaxRssBytes(4 * gibibyte)).toBe(4 * gibibyte)
  expect(getDefaultReviewServingRebuildChunkBatchMaxRssBytes(10 * gibibyte)).toBe(5 * gibibyte)
  expect(getDefaultReviewServingRebuildChunkBatchMaxRssBytes(128 * gibibyte)).toBe(5 * gibibyte)
})

test('uses configured runtime log filtering and profile values', () => {
  const resolvedEnv = loadEnv({
    cwd: '/repo/forska',
    envValues: {FORSKA_RUNTIME_PROFILE: 'secondary', LOG_LEVEL: 'debug', LOG_STDERR_LEVEL: 'error'},
  })

  expect(resolvedEnv.FORSKA_RUNTIME_PROFILE).toBe('secondary')
  expect(resolvedEnv.LOG_DIR).toBe('/repo/forska/logs/runtime/secondary')
  expect(resolvedEnv.LOG_LEVEL).toBe('DEBUG')
  expect(resolvedEnv.LOG_STDERR_LEVEL).toBe('ERROR')
})
