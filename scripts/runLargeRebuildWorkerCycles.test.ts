import {join} from 'node:path'

import {expect, test} from 'bun:test'

import {
  defaultLargeRebuildCommandTestEnv,
  getLastJsonLine,
  migrateLargeRebuildCommandDatabase,
  projectRoot,
} from './largeRebuildCommandTestHelpers.ts'

test('runLargeRebuildWorkerCycles CLI returns structured idle summary', () => {
  const duckdbPath = join(projectRoot, '.tmp', 'run-large-rebuild-worker-cycles.duckdb')
  migrateLargeRebuildCommandDatabase(duckdbPath)

  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      'scripts/runLargeRebuildWorkerCycles.ts',
      '--worker-id=test-run-large-rebuild-worker-cycles',
      '--max-cycles=3',
      '--legacy-admin-ack=legacy-large-rebuild',
    ],
    {cwd: projectRoot, env: {...defaultLargeRebuildCommandTestEnv, DUCKDB_PATH: duckdbPath}},
  )

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString() || 'run large rebuild worker cycles failed')
  }

  const response = JSON.parse(getLastJsonLine(result.stdout.toString())) as {
    completedCycles: number
    cycleResults: Array<{projectId: string | null; status: string; workerId: string}>
    maxCycles: number
    status: string
    stopReason: string
    workerId: string
  }

  expect(response.status).toBe('completed')
  expect(response.workerId).toBe('test-run-large-rebuild-worker-cycles')
  expect(response.maxCycles).toBe(3)
  expect(response.completedCycles).toBe(1)
  expect(response.stopReason).toBe('idle')
  expect(response.cycleResults).toEqual([
    {projectId: null, status: 'idle', workerId: 'test-run-large-rebuild-worker-cycles'},
  ])
})

test('runLargeRebuildWorkerCycles CLI blocks without legacy admin acknowledgement', () => {
  const result = globalThis.Bun.spawnSync(['bun', 'scripts/runLargeRebuildWorkerCycles.ts'], {
    cwd: projectRoot,
    env: {...defaultLargeRebuildCommandTestEnv, DUCKDB_PATH: join(projectRoot, '.tmp', 'unused.duckdb')},
  })

  expect(result.exitCode).toBe(1)
  expect(JSON.parse(getLastJsonLine(result.stderr.toString()))).toEqual({
    command: 'runLargeRebuildWorkerCycles',
    requiredAck: 'legacy-large-rebuild',
    status: 'blocked_legacy_admin_ack_required',
  })
})
