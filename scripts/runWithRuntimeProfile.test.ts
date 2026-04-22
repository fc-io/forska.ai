import {expect, test} from 'bun:test'

import {getRuntimeProfileCommandEnv} from './runWithRuntimeProfile.ts'

test('propagates the selected runtime profile into launcher child env', () => {
  expect(getRuntimeProfileCommandEnv({mode: 'app', profileName: 'primary'}).FORSKA_RUNTIME_PROFILE).toBe('primary')

  expect(
    getRuntimeProfileCommandEnv({mode: 'maintenance-only-server', profileName: 'secondary'}).FORSKA_RUNTIME_PROFILE,
  ).toBe('secondary')
})

test('fixes sink-owning runtime service names in launcher child env', () => {
  expect(getRuntimeProfileCommandEnv({mode: 'app-server', profileName: 'primary'}).FORSKA_RUNTIME_SERVICE).toBe(
    'app-server',
  )
  expect(getRuntimeProfileCommandEnv({mode: 'api-only-server', profileName: 'primary'}).FORSKA_RUNTIME_SERVICE).toBe(
    'api-server',
  )
  expect(
    getRuntimeProfileCommandEnv({mode: 'maintenance-only-server', profileName: 'primary'}).FORSKA_RUNTIME_SERVICE,
  ).toBe('maintenance-worker-server')
  expect(getRuntimeProfileCommandEnv({mode: 'judge-only-server', profileName: 'primary'}).FORSKA_RUNTIME_SERVICE).toBe(
    'judge-worker-server',
  )
  expect(getRuntimeProfileCommandEnv({mode: 'stacked-server', profileName: 'primary'}).FORSKA_RUNTIME_SERVICE).toBe(
    'dev-single-server',
  )
})

test('maintenance-only launcher uses the maintenance-worker runtime role', () => {
  expect(getRuntimeProfileCommandEnv({mode: 'maintenance-only-server', profileName: 'primary'}).SERVER_ROLE).toBe(
    'maintenance-worker',
  )
})

test('judge-only launcher uses the judge-worker runtime role and journal identity', () => {
  expect(getRuntimeProfileCommandEnv({mode: 'judge-only-server', profileName: 'secondary'})).toMatchObject({
    API_SERVER_PORT: '3103',
    FORSKA_RUNTIME_PROFILE: 'secondary',
    JUDGE_WORKER_ID: 'secondary-judge-worker',
    SERVER_DUCKDB_OWNER_URL: 'http://127.0.0.1:3102',
    SERVER_ROLE: 'judge-worker',
  })
})
