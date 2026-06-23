import {existsSync, rmSync} from 'node:fs'
import {dirname, join} from 'node:path'

import {expect, test} from 'bun:test'

const projectRoot = process.cwd()
const defaultEnv = {
  ...process.env,
  API_SERVER_PORT: '39106',
  RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
  RUN_SERVER_FULL_TEXT_FETCHING: 'false',
  SERVER_DUCKDB_OWNER_URL: '',
  SERVER_ROLE: 'maintenance-worker',
  VITE_PORT: '39916',
}

const getLastJsonLine = (output: string) => {
  const [lastLine = ''] = output
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      return (line.startsWith('{') && line.endsWith('}')) || (line.startsWith('[') && line.endsWith(']'))
    })
    .slice(-1)

  if (lastLine === '') {
    throw new Error(`Expected JSON output but received: ${output}`)
  }

  return lastLine
}

const removeFileIfExists = (filePath: string) => {
  if (existsSync(filePath)) {
    rmSync(filePath, {force: true, recursive: true})
  }
}

const seedDatabase = (duckdbPath: string) => {
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
        const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')

        await migrateDuckdb()
        const database = getAppDatabaseService()
        await database.run(\`
          INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
          VALUES ('judgment-fact-repair-connection', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1');

          INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
          VALUES ('judgment-fact-repair-model', 'judgment-fact-repair-connection', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE);

          INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
          VALUES ('judgment-fact-repair-project', 'Judgment Fact Repair Project', 'judgment-fact-repair-model', TRUE, TRUE, FALSE, FALSE);
        \`)
        await database.close()
      `,
    ],
    {cwd: projectRoot, env: {...defaultEnv, DUCKDB_PATH: duckdbPath}},
  )

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString() || 'request judgment fact repair seed failed')
  }
}

const runQuery = (duckdbPath: string, sql: string): unknown => {
  const result = globalThis.Bun.spawnSync(['bun', 'scripts/dbQuerySnapshot.ts', `--sql=${sql}`], {
    cwd: projectRoot,
    env: {...defaultEnv, DUCKDB_PATH: duckdbPath},
  })

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString() || 'query failed')
  }

  return JSON.parse(getLastJsonLine(result.stdout.toString())) as unknown
}

test('requestJudgmentFactRepair schedules V4 repair work without legacy mart rebuild state', () => {
  const duckdbPath = join(projectRoot, '.tmp', `request-judgment-fact-repair-${Date.now()}.duckdb`)
  removeFileIfExists(dirname(duckdbPath))
  seedDatabase(duckdbPath)

  const runScript = globalThis.Bun.spawnSync(
    ['bun', 'scripts/requestJudgmentFactRepair.ts', '--project-id=judgment-fact-repair-project'],
    {cwd: projectRoot, env: {...defaultEnv, DUCKDB_PATH: duckdbPath}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(runScript.stderr.toString() || runScript.stdout.toString() || 'request judgment fact repair failed')
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    projectIds: string[]
    requestIds: string[]
    requestedCount: number
    status: string
  }
  const [requestRow] = runQuery(
    duckdbPath,
    "SELECT project_id AS projectId, reason, status, admission_state AS admissionState, requested_components_json AS requestedComponentsJson FROM app.review_rebuild_request WHERE project_id = 'judgment-fact-repair-project'",
  ) as Array<{
    admissionState: string
    projectId: string
    reason: string
    requestedComponentsJson: string
    status: string
  }>
  const [largeRebuildState] = runQuery(
    duckdbPath,
    "SELECT CAST(COUNT(*) AS INTEGER) AS count FROM app.project_mart_large_rebuild_state WHERE project_id = 'judgment-fact-repair-project' AND refresh_token > 0",
  ) as Array<{count: number}>

  expect(result).toMatchObject({projectIds: ['judgment-fact-repair-project'], requestedCount: 1, status: 'requested'})
  expect(result.requestIds).toHaveLength(1)
  expect(requestRow).toMatchObject({
    admissionState: 'admitted',
    projectId: 'judgment-fact-repair-project',
    reason: 'requestJudgmentFactRepair',
    status: 'admitted',
  })
  expect(JSON.parse(requestRow.requestedComponentsJson)).toEqual([
    'judgmentInputContent',
    'llmStatus',
    'humanStatus',
    'queue',
    'posting',
    'summary',
    'payload',
  ])
  expect(largeRebuildState).toEqual({count: 0})
})
