import {existsSync, rmSync} from 'node:fs'
import {dirname, join} from 'node:path'

import {expect, test} from 'bun:test'

const projectRoot = process.cwd()
const defaultEnv = {
  ...process.env,
  API_SERVER_PORT: '39107',
  RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
  RUN_SERVER_FULL_TEXT_FETCHING: 'false',
  SERVER_DUCKDB_OWNER_URL: '',
  SERVER_ROLE: 'maintenance-worker',
  VITE_PORT: '39917',
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
          VALUES ('repair-prompts-connection', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1');

          INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
          VALUES ('repair-prompts-model', 'repair-prompts-connection', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE);

          INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
          VALUES
            ('repair-prompts-project', 'Repair Prompts Project', 'repair-prompts-model', TRUE, TRUE, FALSE, FALSE),
            ('repair-prompts-other-project', 'Repair Prompts Other Project', 'repair-prompts-model', TRUE, TRUE, FALSE, FALSE);

          INSERT INTO app.prompt (id, original_text, transformed_text, prompt_heading, type, content_hash)
          VALUES ('repair-prompts-shared-prompt', 'Shared prompt', 'Shared prompt transformed', 'Shared heading', 'boolean', 'repair-prompts-shared-hash');

          INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled, origin_project_id)
          VALUES
            ('repair-prompts-project-prompt', 'repair-prompts-project', 'repair-prompts-shared-prompt', 1, TRUE, 'repair-prompts-project'),
            ('repair-prompts-other-project-prompt', 'repair-prompts-other-project', 'repair-prompts-shared-prompt', 1, TRUE, 'repair-prompts-other-project');

          INSERT INTO app.article (id, article_id, article_title, article_created_at, article_updated_at)
          VALUES ('repair-prompts-article', 'repair-prompts-external', 'Repair Prompts Article', TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T01:00:00.000Z');

          INSERT INTO app.project_article (id, project_id, article_id)
          VALUES ('repair-prompts-project-article', 'repair-prompts-project', 'repair-prompts-article');
        \`)
        await database.close()
      `,
    ],
    {cwd: projectRoot, env: {...defaultEnv, DUCKDB_PATH: duckdbPath}},
  )

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString() || 'repair owned project prompts seed failed')
  }
}

const runQuery = (duckdbPath: string, sql: string) => {
  const result = globalThis.Bun.spawnSync(['bun', 'scripts/dbQuerySnapshot.ts', `--sql=${sql}`], {
    cwd: projectRoot,
    env: {...defaultEnv, DUCKDB_PATH: duckdbPath},
  })

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString() || 'query failed')
  }

  return JSON.parse(getLastJsonLine(result.stdout.toString()))
}

test('repairOwnedProjectPrompts queues project-wide dirty materialization for repaired prompts', () => {
  const duckdbPath = join(projectRoot, '.tmp', `repair-owned-project-prompts-${Date.now()}.duckdb`)
  removeFileIfExists(dirname(duckdbPath))
  seedDatabase(duckdbPath)

  const runScript = globalThis.Bun.spawnSync(
    ['bun', 'scripts/repairOwnedProjectPrompts.ts', '--apply', '--project-id=repair-prompts-project'],
    {
      cwd: projectRoot,
      env: {...defaultEnv, DUCKDB_PATH: duckdbPath},
    },
  )

  if (runScript.exitCode !== 0) {
    throw new Error(runScript.stderr.toString() || runScript.stdout.toString() || 'repair owned project prompts failed')
  }

  const output = runScript.stdout.toString()
  const [projectPrompt] = runQuery(
    duckdbPath,
    "SELECT prompt_id AS promptId FROM app.project_prompt WHERE id = 'repair-prompts-project-prompt'",
  ) as Array<{promptId: string}>
  const [refreshState] = runQuery(
    duckdbPath,
    "SELECT CAST(dirty_token AS INTEGER) AS dirtyToken, requested_by AS requestedBy FROM app.project_mart_refresh_state WHERE project_id = 'repair-prompts-project'",
  ) as Array<{dirtyToken: number; requestedBy: string}>
  const [materialization] = runQuery(
    duckdbPath,
    "SELECT materialization_status AS materializationStatus, CAST(source_scope_expected_row_count AS INTEGER) AS expectedRowCount, CAST(target_dirty_token AS INTEGER) AS targetDirtyToken FROM app.project_mart_dirty_materialization_state WHERE project_id = 'repair-prompts-project'",
  ) as Array<{expectedRowCount: number; materializationStatus: string; targetDirtyToken: number}>

  expect(output).toContain('[repairOwnedProjectPrompts] queued dirty materializations: 1')
  expect(projectPrompt.promptId).not.toBe('repair-prompts-shared-prompt')
  expect(refreshState).toEqual({dirtyToken: 1, requestedBy: 'repairOwnedProjectPrompts'})
  expect(materialization).toEqual({
    expectedRowCount: 1,
    materializationStatus: 'pending',
    targetDirtyToken: 1,
  })
})
