import {join} from 'node:path'

import {expect, test} from 'bun:test'

import {
  defaultLargeRebuildCommandTestEnv,
  getLastJsonLine,
  projectRoot,
  seedLargeRebuildCommandProjectDatabase,
} from './largeRebuildCommandTestHelpers.ts'

const runQuery = (duckdbPath: string, sql: string): unknown => {
  const result = globalThis.Bun.spawnSync(['bun', 'scripts/dbQuerySnapshot.ts', `--sql=${sql}`], {
    cwd: projectRoot,
    env: {...defaultLargeRebuildCommandTestEnv, DUCKDB_PATH: duckdbPath},
  })

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString() || 'query failed')
  }

  return JSON.parse(getLastJsonLine(result.stdout.toString())) as unknown
}

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
    throw new Error(
      result.stderr.toString() || result.stdout.toString() || 'request review serving large rebuild failed',
    )
  }

  const response = JSON.parse(getLastJsonLine(result.stdout.toString())) as {
    projectCount: number
    requestIds: string[]
    requestedCount: number
    status: string
  }
  const requestRows = runQuery(
    duckdbPath,
    'SELECT project_id AS projectId, reason, status, admission_state AS admissionState FROM app.review_rebuild_request ORDER BY project_id ASC',
  ) as Array<{admissionState: string; projectId: string; reason: string; status: string}>
  const [legacyRow] = runQuery(
    duckdbPath,
    'SELECT CAST(COUNT(*) AS INTEGER) AS count FROM app.project_mart_large_rebuild_state WHERE refresh_token > 0',
  ) as Array<{count: number}>

  expect(response).toMatchObject({projectCount: 1, requestedCount: 1, status: 'requested'})
  expect(response.requestIds).toHaveLength(1)
  expect(requestRows).toEqual([
    {
      admissionState: 'admitted',
      projectId: 'project-request-review-serving-large-rebuild',
      reason: 'requestReviewServingLargeRebuild',
      status: 'admitted',
    },
  ])
  expect(legacyRow).toEqual({count: 0})
})
