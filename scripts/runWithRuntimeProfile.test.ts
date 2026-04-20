import {expect, test} from 'bun:test'

import {getRuntimeProfileCommandEnv} from './runWithRuntimeProfile.ts'

test('propagates the selected runtime profile into launcher child env', () => {
  expect(getRuntimeProfileCommandEnv({mode: 'app', profileName: 'primary'}).FORSKA_RUNTIME_PROFILE).toBe('primary')

  expect(
    getRuntimeProfileCommandEnv({mode: 'worker-only-server', profileName: 'secondary'}).FORSKA_RUNTIME_PROFILE,
  ).toBe('secondary')
})
