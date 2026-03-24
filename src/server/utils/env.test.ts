import {expect, test} from 'bun:test'

import {loadEnv} from './env.ts'

test('uses local dev port defaults without env files', () => {
  const resolvedEnv = loadEnv({envValues: {}})

  expect(resolvedEnv.VITE_PORT).toBe(3000)
  expect(resolvedEnv.API_SERVER_PORT).toBe(3001)
})
