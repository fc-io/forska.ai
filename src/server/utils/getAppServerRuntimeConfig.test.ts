import {expect, test} from 'bun:test'

import {getAppServerRuntimeConfig} from './getAppServerRuntimeConfig.ts'

test('uses local app-server defaults without env files', () => {
  const runtimeConfig = getAppServerRuntimeConfig({envValues: {}})

  expect(runtimeConfig.apiHost).toBe('127.0.0.1')
  expect(runtimeConfig.apiPort).toBe(3001)
  expect(runtimeConfig.apiScheme).toBe('http')
  expect(runtimeConfig.logDir).toBe(`${process.cwd()}/logs/runtime/local`)
  expect(runtimeConfig.logLevel).toBe('INFO')
  expect(runtimeConfig.logStderrLevel).toBe('WARN')
  expect(runtimeConfig.port).toBe(8080)
  expect(runtimeConfig.runtimeProfile).toBe('local')
})

test('resolves app-server log config through shared runtime config', () => {
  const runtimeConfig = getAppServerRuntimeConfig({
    cwd: '/repo/forska',
    envValues: {FORSKA_RUNTIME_PROFILE: 'primary', LOG_LEVEL: 'warn', LOG_STDERR_LEVEL: 'error'},
  })

  expect(runtimeConfig.logDir).toBe('/repo/forska/logs/runtime/primary')
  expect(runtimeConfig.logLevel).toBe('WARN')
  expect(runtimeConfig.logStderrLevel).toBe('ERROR')
  expect(runtimeConfig.runtimeProfile).toBe('primary')
})
