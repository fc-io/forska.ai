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
  expect(getRuntimeProfileCommandEnv({mode: 'stacked-server', profileName: 'primary'}).FORSKA_RUNTIME_SERVICE).toBe(
    'dev-single-server',
  )
})

test('maintenance-only launcher uses the maintenance-worker runtime role', () => {
  expect(getRuntimeProfileCommandEnv({mode: 'maintenance-only-server', profileName: 'primary'}).SERVER_ROLE).toBe(
    'maintenance-worker',
  )
})
