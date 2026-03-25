import {expect, test} from 'bun:test'

import {getAppServerRuntimeConfig} from './getAppServerRuntimeConfig.ts'

test('uses local app-server defaults without env files', () => {
  const runtimeConfig = getAppServerRuntimeConfig({envValues: {}})

  expect(runtimeConfig.apiHost).toBe('localhost')
  expect(runtimeConfig.apiPort).toBe(3001)
  expect(runtimeConfig.apiScheme).toBe('http')
  expect(runtimeConfig.port).toBe(8080)
})
