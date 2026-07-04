import {expect, test} from 'bun:test'

import {loadEnv} from './env.ts'

test('uses local dev port defaults without env files', () => {
  const resolvedEnv = loadEnv({envValues: {}})

  expect(resolvedEnv.VITE_PORT).toBe(3000)
  expect(resolvedEnv.API_SERVER_PORT).toBe(3001)
  expect(resolvedEnv.DUCKDB_APPEND_LANE_COUNT).toBe(2)
  expect(resolvedEnv.PROJECT_MART_LARGE_REBUILD_BATCH_SIZE).toBe(128)
  expect(resolvedEnv.PROJECT_MART_LARGE_REBUILD_MAX_CYCLES_PER_WAKE).toBe(4)
  expect(resolvedEnv.PROJECT_MART_LARGE_REBUILD_POLL_INTERVAL_MS).toBe(1000)
  expect(resolvedEnv.FORSKA_REVIEW_SERVING_REBUILD_CHUNK_BATCH_MAX_RSS_BYTES).toBe(0)
  expect(resolvedEnv.FORSKA_REVIEW_SERVING_REBUILD_CHUNK_BATCH_SIZE).toBe(1)
  expect(resolvedEnv.FORSKA_RUNTIME_PROFILE).toBe('local')
  expect(resolvedEnv.LOG_DIR).toBe(`${process.cwd()}/logs/runtime/local`)
  expect(resolvedEnv.LOG_LEVEL).toBe('INFO')
  expect(resolvedEnv.LOG_STDERR_LEVEL).toBe('WARN')
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
