import {join} from 'node:path'

import {expect, test} from 'bun:test'

import {
  defaultLargeRebuildCommandTestEnv,
  getLastJsonLine,
  projectRoot,
  seedLargeRebuildCommandProjectDatabase,
} from './largeRebuildCommandTestHelpers.ts'

test('requestReviewServingLargeRebuild CLI requests active project large rebuilds', () => {
  const duckdbPath = join(projectRoot, '.tmp', 'request-review-serving-large-rebuild.duckdb')
  seedLargeRebuildCommandProjectDatabase({
    duckdbPath,
    projects: [
      {projectId: 'project-request-review-serving-large-rebuild'},
      {archived: true, projectId: 'project-request-review-serving-large-rebuild-archived'},
    ],
  })

  const result = globalThis.Bun.spawnSync(['bun', 'scripts/requestReviewServingLargeRebuild.ts'], {
    cwd: projectRoot,
    env: {...defaultLargeRebuildCommandTestEnv, DUCKDB_PATH: duckdbPath},
  })

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString() || 'request review serving large rebuild failed')
  }

  const response = JSON.parse(getLastJsonLine(result.stdout.toString())) as {
    projectCount: number
    requestedCount: number
    status: string
  }

  expect(response).toEqual({
    projectCount: 1,
    requestedCount: 1,
    status: 'requested',
  })
})
