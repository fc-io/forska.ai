import {expect, test} from 'bun:test'

import {getRuntimeServiceNameForServerRole} from './runtimeBootstrap.ts'
import {getDefaultRuntimeLogDir, getRuntimeLogConfig, getRuntimeLogProfile} from './runtimeLogger.ts'

test('defaults unresolved runtime log profile to local', () => {
  expect(getRuntimeLogProfile({envValues: {}})).toBe('local')
  expect(getRuntimeLogProfile({envValues: {FORSKA_RUNTIME_PROFILE: 'unknown'}})).toBe('local')
})

test('resolves default runtime log dir under writable root and profile', () => {
  expect(getDefaultRuntimeLogDir({cwd: '/repo/forska', envValues: {FORSKA_RUNTIME_PROFILE: 'primary'}})).toBe(
    '/repo/forska/logs/runtime/primary',
  )
})

test('resolves desktop runtime log dir under desktop writable root', () => {
  const envValues = {
    DUCKDB_PATH: '/Users/tester/Library/Application Support/Forska/desktop/forska.duckdb',
    FORSKA_DESKTOP_MODE: 'true',
    FORSKA_RUNTIME_PROFILE: 'local',
  }

  expect(getDefaultRuntimeLogDir({cwd: '/repo/forska', envValues})).toBe(
    '/Users/tester/Library/Application Support/Forska/desktop/logs/runtime/local',
  )
})

test('normalizes runtime log filtering env and resolves explicit log dirs', () => {
  expect(
    getRuntimeLogConfig({
      cwd: '/repo/forska',
      envValues: {LOG_DIR: 'tmp/logs', LOG_LEVEL: 'debug', LOG_STDERR_LEVEL: 'error'},
    }),
  ).toEqual({logDir: '/repo/forska/tmp/logs', logLevel: 'DEBUG', logStderrLevel: 'ERROR', runtimeProfile: 'local'})
})

test('selects stable runtime service names from server role before runtime imports', () => {
  expect(getRuntimeServiceNameForServerRole({SERVER_ROLE: 'api'})).toBe('api-server')
  expect(getRuntimeServiceNameForServerRole({SERVER_ROLE: 'worker'})).toBe('worker-server')
  expect(getRuntimeServiceNameForServerRole({SERVER_ROLE: 'writer'})).toBe('worker-server')
  expect(getRuntimeServiceNameForServerRole({SERVER_ROLE: 'dev-single'})).toBe('dev-single-server')
  expect(getRuntimeServiceNameForServerRole({SERVER_ROLE: 'auto'})).toBe('single-server')
  expect(getRuntimeServiceNameForServerRole({})).toBe('single-server')
})
