import {type spawn} from 'node:child_process'

import {expect, test} from 'bun:test'

import {getCodexCliLoginStatus} from './codexCliAuth.ts'

test('reports the Codex CLI as unavailable when spawning throws synchronously', async () => {
  const spawnProcess = (() => {
    throw Object.assign(new Error('spawn codex EPERM'), {code: 'EPERM'})
  }) as typeof spawn

  const status = await getCodexCliLoginStatus({spawnProcess})

  expect(status).toEqual({loggedIn: false, method: null, ok: false, raw: 'spawn codex EPERM'})
})
