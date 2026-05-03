import {join} from 'node:path'

import {expect, test} from 'bun:test'

import {
  defaultLargeRebuildCommandTestEnv,
  getLastJsonLine,
  migrateLargeRebuildCommandDatabase,
  projectRoot,
} from './largeRebuildCommandTestHelpers.ts'

test('runLargeRebuildWorkerOnce CLI returns structured idle result', () => {
  const duckdbPath = join(projectRoot, '.tmp', 'run-large-rebuild-worker-once.duckdb')
  migrateLargeRebuildCommandDatabase(duckdbPath)

  const result = globalThis.Bun.spawnSync(
    ['bun', 'scripts/runLargeRebuildWorkerOnce.ts', '--worker-id=test-run-large-rebuild-worker-once'],
    {cwd: projectRoot, env: {...defaultLargeRebuildCommandTestEnv, DUCKDB_PATH: duckdbPath}},
  )

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString() || 'run large rebuild worker once failed')
  }

  const response = JSON.parse(getLastJsonLine(result.stdout.toString())) as {
    projectId: string | null
    status: string
    workerId: string
  }

  expect(response).toEqual({
    projectId: null,
    status: 'idle',
    workerId: 'test-run-large-rebuild-worker-once',
  })
})
