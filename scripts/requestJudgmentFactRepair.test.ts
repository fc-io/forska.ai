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

const runDatabaseMutation = (duckdbPath: string, sql: string) => {
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')

        const database = getAppDatabaseService()
        await database.run(\`${sql}\`)
        await database.close()
      `,
    ],
    {cwd: projectRoot, env: {...defaultEnv, DUCKDB_PATH: duckdbPath}},
  )

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString() || 'database mutation failed')
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

          INSERT INTO app.article (id, article_id, article_title, article_created_at, article_updated_at)
          VALUES (
            'judgment-fact-repair-article',
            'judgment-fact-repair-article',
            'Judgment fact repair article',
            TIMESTAMPTZ '2026-04-01T00:00:00.000Z',
            TIMESTAMPTZ '2026-04-01T00:00:00.000Z'
          );

          INSERT INTO app.project_article (id, project_id, article_id)
          VALUES (
            'judgment-fact-repair-project-article',
            'judgment-fact-repair-project',
            'judgment-fact-repair-article'
          );

          INSERT INTO app.review_projection_identity_manifest (
            manifest_id,
            project_id,
            projection_component,
            base_generation,
            input_watermark,
            input_digest,
            projection_identity,
            definition_version,
            status
          ) VALUES
            ('judgment-fact-repair-judgment-input-content-manifest', 'judgment-fact-repair-project', 'judgmentInputContent', 1, 1, 'judgment-input-content-digest', 'judgmentInputContent:judgment-fact-repair', 'judgmentInputContent:v1', 'active'),
            ('judgment-fact-repair-llm-status-manifest', 'judgment-fact-repair-project', 'llmStatus', 1, 1, 'llm-status-digest', 'llmStatus:judgment-fact-repair', 'llmStatus:v1', 'active'),
            ('judgment-fact-repair-human-status-manifest', 'judgment-fact-repair-project', 'humanStatus', 1, 1, 'human-status-digest', 'humanStatus:judgment-fact-repair', 'humanStatus:v1', 'active'),
            ('judgment-fact-repair-queue-manifest', 'judgment-fact-repair-project', 'queue', 1, 1, 'queue-digest', 'queue:judgment-fact-repair', 'queue:v1', 'active'),
            ('judgment-fact-repair-posting-manifest', 'judgment-fact-repair-project', 'posting', 1, 1, 'posting-digest', 'posting:judgment-fact-repair', 'posting:v1', 'active'),
            ('judgment-fact-repair-summary-manifest', 'judgment-fact-repair-project', 'summary', 1, 1, 'summary-digest', 'summary:judgment-fact-repair', 'summary:v1', 'active'),
            ('judgment-fact-repair-payload-manifest', 'judgment-fact-repair-project', 'payload', 1, 1, 'payload-digest', 'payload:judgment-fact-repair', 'payload:v1', 'active');

          INSERT INTO app.review_serving_snapshot_manifest (
            project_id,
            snapshot_id,
            snapshot_status,
            review_config_hash,
            composed_identity_json,
            component_state_json,
            required_components_json,
            optional_components_json,
            source_watermarks_json,
            activated_at
          ) VALUES (
            'judgment-fact-repair-project',
            'judgment-fact-repair-snapshot',
            'active',
            'judgment-fact-repair-review-config',
            '{}'::JSON,
            '{"required":[{"component":"judgmentInputContent","projectionIdentity":"judgmentInputContent:judgment-fact-repair","baseGeneration":1,"patchWatermark":1},{"component":"llmStatus","projectionIdentity":"llmStatus:judgment-fact-repair","baseGeneration":1,"patchWatermark":1},{"component":"humanStatus","projectionIdentity":"humanStatus:judgment-fact-repair","baseGeneration":1,"patchWatermark":1},{"component":"queue","projectionIdentity":"queue:judgment-fact-repair","baseGeneration":1,"patchWatermark":1},{"component":"posting","projectionIdentity":"posting:judgment-fact-repair","baseGeneration":1,"patchWatermark":1},{"component":"summary","projectionIdentity":"summary:judgment-fact-repair","baseGeneration":1,"patchWatermark":1},{"component":"payload","projectionIdentity":"payload:judgment-fact-repair","baseGeneration":1,"patchWatermark":1}],"optional":[]}'::JSON,
            '["judgmentInputContent","llmStatus","humanStatus","queue","posting","summary","payload"]'::JSON,
            '[]'::JSON,
            '{}'::JSON,
            TIMESTAMPTZ '2026-04-01T00:00:00.000Z'
          );
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

test('requestJudgmentFactRepair continues all-active repairs after an empty project fails', () => {
  const duckdbPath = join(projectRoot, '.tmp', `request-judgment-fact-repair-all-active-${Date.now()}.duckdb`)
  removeFileIfExists(dirname(duckdbPath))
  seedDatabase(duckdbPath)
  runDatabaseMutation(
    duckdbPath,
    `
      INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
      VALUES ('judgment-empty-project', 'Judgment Empty Project', 'judgment-fact-repair-model', TRUE, TRUE, FALSE, FALSE);
    `,
  )

  const runScript = globalThis.Bun.spawnSync(['bun', 'scripts/requestJudgmentFactRepair.ts', '--all-active-projects'], {
    cwd: projectRoot,
    env: {...defaultEnv, DUCKDB_PATH: duckdbPath},
  })

  if (runScript.exitCode !== 0) {
    throw new Error(runScript.stderr.toString() || runScript.stdout.toString() || 'request all-active repair failed')
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    failedCount: number
    failedProjects: Array<{error: string; projectId: string}>
    projectIds: string[]
    requestIds: string[]
    requestedCount: number
    status: string
  }
  const [validRequestCount] = runQuery(
    duckdbPath,
    "SELECT CAST(COUNT(*) AS INTEGER) AS count FROM app.review_rebuild_request WHERE project_id = 'judgment-fact-repair-project'",
  ) as Array<{count: number}>
  const [emptyRequestCount] = runQuery(
    duckdbPath,
    "SELECT CAST(COUNT(*) AS INTEGER) AS count FROM app.review_rebuild_request WHERE project_id = 'judgment-empty-project'",
  ) as Array<{count: number}>

  expect(result).toMatchObject({
    failedCount: 0,
    failedProjects: [],
    projectIds: ['judgment-empty-project', 'judgment-fact-repair-project'],
    requestedCount: 2,
    status: 'requested',
  })
  expect(result.requestIds).toHaveLength(2)
  expect(validRequestCount).toEqual({count: 1})
  expect(emptyRequestCount).toEqual({count: 0})
})
