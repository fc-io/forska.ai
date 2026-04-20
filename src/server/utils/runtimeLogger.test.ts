import {expect, test} from 'bun:test'

import {getRuntimeServiceNameForServerRole} from './runtimeBootstrap.ts'
import {getDefaultRuntimeLogDir, getRuntimeLogConfig, getRuntimeLogProfile} from './runtimeLogger.ts'
import {
  getRuntimeProcessLogIdentity,
  initializeRuntimeProcessIdentity,
  resetRuntimeProcessIdentityForTests,
  resolveRuntimeProcessIdentity,
} from './runtimeProcessIdentity.ts'

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

test('resolves one runtime process identity with stable instance id shape', () => {
  expect(
    resolveRuntimeProcessIdentity({
      envValues: {FORSKA_RUNTIME_PROFILE: 'primary'},
      hostnameValue: 'test-host',
      listenPort: 3002,
      pid: 48192,
      processStartedAt: '2026-04-12T10:10:00.000Z',
      service: 'worker-server',
    }),
  ).toEqual({
    hostname: 'test-host',
    instanceId: 'worker-server:test-host:3002:48192:2026-04-12T10:10:00.000Z',
    listenPort: 3002,
    pid: 48192,
    processStartedAt: '2026-04-12T10:10:00.000Z',
    runtimeProfile: 'primary',
    service: 'worker-server',
  })
})

test('omits serverRole for app-server runtime log identity', () => {
  resetRuntimeProcessIdentityForTests()
  initializeRuntimeProcessIdentity({
    hostnameValue: 'test-host',
    listenPort: 8080,
    pid: 100,
    processStartedAt: '2026-04-12T10:10:00.000Z',
    service: 'app-server',
  })
  const identity = getRuntimeProcessLogIdentity({serverRole: 'api'})

  expect(identity.service).toBe('app-server')
  expect('serverRole' in identity).toBe(false)
  resetRuntimeProcessIdentityForTests()
})
