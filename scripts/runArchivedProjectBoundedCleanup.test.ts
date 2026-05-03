import {join} from 'node:path'

import {expect, test} from 'bun:test'

import {
  defaultLargeRebuildCommandTestEnv,
  getLastJsonLine,
  migrateLargeRebuildCommandDatabase,
  projectRoot,
} from './largeRebuildCommandTestHelpers.ts'

test('runArchivedProjectBoundedCleanup CLI returns structured completed result', () => {
  const duckdbPath = join(projectRoot, '.tmp', 'run-archived-project-bounded-cleanup.duckdb')
  migrateLargeRebuildCommandDatabase(duckdbPath)

  const result = globalThis.Bun.spawnSync(['bun', 'scripts/runArchivedProjectBoundedCleanup.ts', '--max-batches=1'], {
    cwd: projectRoot,
    env: {...defaultLargeRebuildCommandTestEnv, DUCKDB_PATH: duckdbPath},
  })

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString() || 'archived project cleanup command failed')
  }

  const response = JSON.parse(getLastJsonLine(result.stdout.toString())) as {
    batches: Array<{phase: string; projectId: string | null}>
    deletedRowCount: number
    status: string
  }

  expect(response).toEqual({
    batches: [{deletedRowCount: 0, phase: 'idle', projectId: null, tableName: null}],
    deletedRowCount: 0,
    status: 'completed',
  })
})
