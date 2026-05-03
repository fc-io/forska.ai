import {join} from 'node:path'

import {expect, test} from 'bun:test'

import {
  defaultLargeRebuildCommandTestEnv,
  getLastJsonLine,
  projectRoot,
  seedLargeRebuildCommandProjectDatabase,
} from './largeRebuildCommandTestHelpers.ts'

test('requestProjectLargeRebuild CLI requests one project large rebuild', () => {
  const duckdbPath = join(projectRoot, '.tmp', 'request-project-large-rebuild.duckdb')
  seedLargeRebuildCommandProjectDatabase({
    duckdbPath,
    projects: [{projectId: 'project-request-large-rebuild'}],
  })

  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      'scripts/requestProjectLargeRebuild.ts',
      '--project-id=project-request-large-rebuild',
      '--reason=test-request-project-large-rebuild',
    ],
    {cwd: projectRoot, env: {...defaultLargeRebuildCommandTestEnv, DUCKDB_PATH: duckdbPath}},
  )

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString() || 'request project large rebuild failed')
  }

  const response = JSON.parse(getLastJsonLine(result.stdout.toString())) as {
    projectId: string
    reason: string
    requestedCount: number
    status: string
  }

  expect(response).toEqual({
    projectId: 'project-request-large-rebuild',
    reason: 'test-request-project-large-rebuild',
    requestedCount: 1,
    status: 'requested',
  })
})
