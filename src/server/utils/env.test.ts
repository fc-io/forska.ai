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
})
