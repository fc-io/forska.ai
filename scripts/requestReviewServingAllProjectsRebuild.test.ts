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

const runAllProjectsRebuildScript = (duckdbPath: string, args: string[] = []) => {
  const outputPath = getCommandOutputPath('request-review-serving-all-projects-rebuild-output')
  const result = globalThis.Bun.spawnSync(
    ['bun', 'scripts/requestReviewServingAllProjectsRebuild.ts', ...args, `--json-output-file=${outputPath}`],
    {cwd: projectRoot, env: {...defaultLargeRebuildCommandTestEnv, DUCKDB_PATH: duckdbPath}},
  )

  return {output: getCommandOutput(outputPath, result), result}
}

const runQuery = (duckdbPath: string, sql: string): unknown => {
  const outputPath = getCommandOutputPath('request-review-serving-all-projects-rebuild-query')
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

test('requestReviewServingAllProjectsRebuild CLI requests active project rebuilds', () => {
  const duckdbPath = join(projectRoot, '.tmp', 'request-review-serving-all-projects-rebuild.duckdb')
  seedLargeRebuildCommandProjectDatabase({
    duckdbPath,
    projects: [
      {projectId: 'project-request-review-serving-all-projects-rebuild'},
      {archived: true, projectId: 'project-request-review-serving-all-projects-rebuild-archived'},
    ],
  })

  const runScript = runAllProjectsRebuildScript(duckdbPath)

  if (runScript.result.exitCode !== 0) {
    throw new Error(
      runScript.output
        || runScript.result.stderr.toString()
        || runScript.result.stdout.toString()
        || 'request review serving all projects rebuild failed',
    )
  }

  const response = JSON.parse(getLastJsonLine(runScript.output)) as {
    failedCount: number
    failedProjects: Array<{error: string; projectId: string}>
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

  expect(response).toMatchObject({
    failedCount: 0,
    failedProjects: [],
    projectCount: 1,
    requestedCount: 1,
    status: 'requested',
  })
  expect(response.requestIds).toHaveLength(1)
  expect(requestRows).toEqual([
    {
      admissionState: 'admitted',
      projectId: 'project-request-review-serving-all-projects-rebuild',
      reason: 'requestReviewServingAllProjectsRebuild',
      status: 'admitted',
    },
  ])
  expect(legacyRow).toEqual({count: 0})
})

test('requestReviewServingAllProjectsRebuild CLI continues after an empty active project', () => {
  const duckdbPath = join(projectRoot, '.tmp', 'request-review-serving-all-projects-rebuild-empty-project.duckdb')
  seedLargeRebuildCommandProjectDatabase({
    duckdbPath,
    projects: [
      {projectId: 'project-empty-review-serving-large-rebuild', skipRebuildSeed: true},
      {projectId: 'project-valid-review-serving-large-rebuild'},
    ],
  })

  const runScript = runAllProjectsRebuildScript(duckdbPath)

  if (runScript.result.exitCode !== 0) {
    throw new Error(
      runScript.output
        || runScript.result.stderr.toString()
        || runScript.result.stdout.toString()
        || 'request review serving all projects rebuild failed',
    )
  }

  const response = JSON.parse(getLastJsonLine(runScript.output)) as {
    failedCount: number
    failedProjects: Array<{error: string; projectId: string}>
    projectCount: number
    requestIds: string[]
    requestedCount: number
    status: string
  }
  const requestRows = runQuery(
    duckdbPath,
    'SELECT project_id AS projectId, reason, status, admission_state AS admissionState FROM app.review_rebuild_request ORDER BY project_id ASC',
  ) as Array<{admissionState: string; projectId: string; reason: string; status: string}>

  expect(response).toMatchObject({
    failedCount: 0,
    failedProjects: [],
    projectCount: 2,
    requestedCount: 2,
    status: 'requested',
  })
  expect(response.requestIds).toHaveLength(2)
  expect(requestRows).toEqual([
    {
      admissionState: 'admitted',
      projectId: 'project-valid-review-serving-large-rebuild',
      reason: 'requestReviewServingAllProjectsRebuild',
      status: 'admitted',
    },
  ])
})
