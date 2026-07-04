import {join} from 'node:path'

import {expect, test} from 'bun:test'

import {
  defaultLargeRebuildCommandTestEnv,
  getLastJsonLine,
  projectRoot,
  seedLargeRebuildCommandProjectDatabase,
} from './largeRebuildCommandTestHelpers.ts'

const runQuery = (duckdbPath: string, sql: string): unknown => {
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
        const database = getAppDatabaseService()
        const rows = await database.queryJson(${JSON.stringify(sql)})
        console.log(JSON.stringify(rows))
        await database.close()
      `,
    ],
    {cwd: projectRoot, env: {...defaultLargeRebuildCommandTestEnv, DUCKDB_PATH: duckdbPath}},
  )

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString() || 'query failed')
  }

  return JSON.parse(getLastJsonLine(result.stdout.toString())) as unknown
}

test('requestReviewServingProjectRebuild CLI requests one project V4 rebuild', () => {
  const duckdbPath = join(projectRoot, '.tmp', 'request-review-serving-project-rebuild.duckdb')
  seedLargeRebuildCommandProjectDatabase({duckdbPath, projects: [{projectId: 'project-request-review-serving'}]})

  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      'scripts/requestReviewServingProjectRebuild.ts',
      '--project-id=project-request-review-serving',
      '--reason=test-request-review-serving-project-rebuild',
    ],
    {cwd: projectRoot, env: {...defaultLargeRebuildCommandTestEnv, DUCKDB_PATH: duckdbPath}},
  )

  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.toString() || result.stdout.toString() || 'request review-serving project rebuild failed',
    )
  }

  const response = JSON.parse(getLastJsonLine(result.stdout.toString())) as {
    projectId: string
    reason: string
    requestIds: string[]
    requestedCount: number
    status: string
  }
  const [requestRow] = runQuery(
    duckdbPath,
    "SELECT project_id AS projectId, reason, status, admission_state AS admissionState FROM app.review_rebuild_request WHERE project_id = 'project-request-review-serving'",
  ) as Array<{admissionState: string; projectId: string; reason: string; status: string}>
  const [legacyRow] = runQuery(
    duckdbPath,
    "SELECT CAST(COUNT(*) AS INTEGER) AS count FROM app.project_mart_large_rebuild_state WHERE project_id = 'project-request-review-serving' AND refresh_token > 0",
  ) as Array<{count: number}>

  expect(response).toMatchObject({
    projectId: 'project-request-review-serving',
    reason: 'test-request-review-serving-project-rebuild',
    requestedCount: 1,
    status: 'requested',
  })
  expect(response.requestIds).toHaveLength(1)
  expect(requestRow).toEqual({
    admissionState: 'admitted',
    projectId: 'project-request-review-serving',
    reason: 'test-request-review-serving-project-rebuild',
    status: 'admitted',
  })
  expect(legacyRow).toEqual({count: 0})
})
