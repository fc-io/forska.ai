import {existsSync, readFileSync} from 'node:fs'
import {join} from 'node:path'

import {expect, setDefaultTimeout, test} from 'bun:test'

import {
  defaultLargeRebuildCommandTestEnv,
  getLastJsonLine,
  projectRoot,
  seedLargeRebuildCommandProjectDatabase,
} from './largeRebuildCommandTestHelpers.ts'

setDefaultTimeout(120_000)

const getCommandOutputPath = (name: string) => {
  return join(projectRoot, '.tmp', `${name}-${Date.now()}-${Math.random()}.json`)
}

const getCommandOutput = (outputPath: string, result: ReturnType<typeof globalThis.Bun.spawnSync>) => {
  return existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : result.stdout.toString()
}

const runProjectRebuildScript = (duckdbPath: string, args: string[]) => {
  const outputPath = getCommandOutputPath('request-review-serving-project-rebuild-output')
  const result = globalThis.Bun.spawnSync(
    ['bun', 'scripts/requestReviewServingProjectRebuild.ts', ...args, `--json-output-file=${outputPath}`],
    {cwd: projectRoot, env: {...defaultLargeRebuildCommandTestEnv, DUCKDB_PATH: duckdbPath}},
  )

  return {output: getCommandOutput(outputPath, result), result}
}

const runQuery = (duckdbPath: string, sql: string): unknown => {
  const outputPath = getCommandOutputPath('request-review-serving-project-rebuild-query')
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {writeFileSync} = await import('node:fs')
        const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
        const database = getAppDatabaseService()
        const rows = await database.queryJson(${JSON.stringify(sql)})
        const output = JSON.stringify(rows)
        writeFileSync(${JSON.stringify(outputPath)}, output + '\\n', 'utf8')
        console.log(output)
        await database.close()
      `,
    ],
    {cwd: projectRoot, env: {...defaultLargeRebuildCommandTestEnv, DUCKDB_PATH: duckdbPath}},
  )

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString() || 'query failed')
  }

  return JSON.parse(getLastJsonLine(getCommandOutput(outputPath, result))) as unknown
}

test('requestReviewServingProjectRebuild CLI requests one project V4 rebuild', () => {
  const duckdbPath = join(projectRoot, '.tmp', 'request-review-serving-project-rebuild.duckdb')
  seedLargeRebuildCommandProjectDatabase({duckdbPath, projects: [{projectId: 'project-request-review-serving'}]})

  const runScript = runProjectRebuildScript(duckdbPath, [
      '--project-id=project-request-review-serving',
      '--reason=test-request-review-serving-project-rebuild',
    ])

  if (runScript.result.exitCode !== 0) {
    throw new Error(
      runScript.output
        || runScript.result.stderr.toString()
        || runScript.result.stdout.toString()
        || 'request review-serving project rebuild failed',
    )
  }

  const response = JSON.parse(getLastJsonLine(runScript.output)) as {
    components: string[] | null
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
    components: null,
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

test('requestReviewServingProjectRebuild CLI expands narrow requests for a fresh bootstrap', () => {
  const duckdbPath = join(projectRoot, '.tmp', 'request-review-serving-project-rebuild-components.duckdb')
  seedLargeRebuildCommandProjectDatabase({duckdbPath, projects: [{projectId: 'project-request-review-serving'}]})

  const runScript = runProjectRebuildScript(duckdbPath, [
      '--project-id=project-request-review-serving',
      '--reason=test-request-review-serving-project-rebuild-components',
      '--components=projectScope',
    ])

  if (runScript.result.exitCode !== 0) {
    throw new Error(
      runScript.output
        || runScript.result.stderr.toString()
        || runScript.result.stdout.toString()
        || 'request narrow review-serving project rebuild failed',
    )
  }

  const response = JSON.parse(getLastJsonLine(runScript.output)) as {
    components: string[] | null
    projectId: string
    reason: string
    requestIds: string[]
    requestedCount: number
    status: string
  }
  const [requestRow] = runQuery(
    duckdbPath,
    "SELECT requested_components_json AS requestedComponentsJson FROM app.review_rebuild_request WHERE project_id = 'project-request-review-serving'",
  ) as Array<{requestedComponentsJson: string}>
  const requestChunkComponents = runQuery(
    duckdbPath,
    `SELECT DISTINCT projection_component AS component
     FROM app.review_rebuild_chunk_manifest
     WHERE request_id = '${response.requestIds[0]}'
     ORDER BY component ASC`,
  ) as Array<{component: string}>

  expect(response).toMatchObject({
    components: ['projectScope'],
    projectId: 'project-request-review-serving',
    requestedCount: 1,
    status: 'requested',
  })
  expect(JSON.parse(requestRow.requestedComponentsJson)).toEqual(['projectScope'])
  expect(
    requestChunkComponents.map((row) => {
      return row.component
    }),
  ).toEqual([
    'display',
    'humanStatus',
    'judgmentInputContent',
    'llmStatus',
    'payload',
    'posting',
    'projectScope',
    'queue',
    'search',
    'selectedImport',
    'summary',
  ])
})
