import {existsSync, rmSync} from 'node:fs'
import {dirname, join} from 'node:path'

import {expect, test} from 'bun:test'

const projectRoot = process.cwd()
const defaultEnv = {
  ...process.env,
  API_SERVER_PORT: '39104',
  RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
  RUN_SERVER_FULL_TEXT_FETCHING: 'false',
  SERVER_DUCKDB_OWNER_URL: '',
  SERVER_ROLE: 'maintenance-worker',
  VITE_PORT: '39914',
}

const getLastJsonLine = (output: string) => {
  const [lastLine = ''] = output
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      return line.startsWith('{') && line.endsWith('}')
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
          VALUES ('inspect-dirty-connection', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1');

          INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
          VALUES ('inspect-dirty-model', 'inspect-dirty-connection', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE);

          INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
          VALUES ('inspect-dirty-project', 'Inspect Dirty Project', 'inspect-dirty-model', TRUE, TRUE, FALSE, FALSE);

          INSERT INTO app.article (id, article_id, article_title, article_created_at, article_updated_at)
          VALUES ('inspect-dirty-article', 'inspect-dirty-external', 'Inspect Dirty Article', TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T01:00:00.000Z');

          INSERT INTO app.project_article (id, project_id, article_id)
          VALUES ('inspect-dirty-project-article', 'inspect-dirty-project', 'inspect-dirty-article');

          INSERT INTO app.project_mart_refresh_state (
            project_id,
            dirty_token,
            active_dirty_token,
            last_completed_dirty_token,
            refresh_status,
            last_requested_at
          ) VALUES (
            'inspect-dirty-project',
            2,
            1,
            0,
            'idle',
            TIMESTAMPTZ '2026-04-05T10:00:00.000Z'
          );

          INSERT INTO app.project_mart_refresh_article_state (
            project_id,
            article_id,
            first_dirty_token,
            last_dirty_token
          ) VALUES (
            'inspect-dirty-project',
            'inspect-dirty-article',
            1,
            2
          );

          INSERT INTO app.project_mart_dirty_materialization_state (
            project_id,
            source_kind,
            target_dirty_token,
            inserted_row_count,
            source_scope_expected_row_count,
            materialization_status,
            materialization_owner,
            lease_expires_at
          ) VALUES (
            'inspect-dirty-project',
            'project_scope_article',
            2,
            0,
            1,
            'running',
            'materializer-worker',
            TIMESTAMPTZ '2026-04-05T10:01:00.000Z'
          );

          INSERT INTO app.project_mart_dirty_refresh_article_quarantine (
            project_id,
            article_id,
            dirty_token,
            error,
            detected_by
          ) VALUES (
            'inspect-dirty-project',
            'inspect-dirty-article',
            1,
            'bad row',
            'test'
          );

          INSERT INTO app.project_mart_large_rebuild_state (
            project_id,
            refresh_token,
            rebuild_phase,
            refresh_status,
            worker_id,
            lease_expires_at
          ) VALUES (
            'inspect-dirty-project',
            3,
            'project_scope_article',
            'running',
            'large-worker',
            TIMESTAMPTZ '2026-04-05T10:01:00.000Z'
          );
        \`)
        await database.close()
      `,
    ],
    {cwd: projectRoot, env: {...defaultEnv, DUCKDB_PATH: duckdbPath}},
  )

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString() || 'inspect dirty refresh seed failed')
  }
}

test('inspectDirtyRefreshRisk reports materialization, quarantine, scope, and large rebuild state', () => {
  const duckdbPath = join(projectRoot, '.tmp', `inspect-dirty-refresh-risk-${Date.now()}.duckdb`)
  removeFileIfExists(dirname(duckdbPath))
  seedDatabase(duckdbPath)

  const runScript = globalThis.Bun.spawnSync(
    ['bun', 'scripts/inspectDirtyRefreshRisk.ts', '--project-id=inspect-dirty-project'],
    {
      cwd: projectRoot,
      env: {...defaultEnv, DUCKDB_PATH: duckdbPath},
    },
  )

  if (runScript.exitCode !== 0) {
    throw new Error(runScript.stderr.toString() || runScript.stdout.toString() || 'inspect dirty refresh failed')
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    dirtyMaterialization: {blockingCount: number; totalCount: number}
    largeRebuild: {rebuildPhase: string; refreshStatus: string; refreshToken: string}
    plannedWork: string
    quarantine: {unresolvedBarrierCount: number}
    scope: {articleCount: number; dirtyArticleCount: number}
  }

  expect(result.dirtyMaterialization).toMatchObject({blockingCount: 1, totalCount: 1})
  expect(result.quarantine.unresolvedBarrierCount).toBe(1)
  expect(result.scope).toEqual({articleCount: 1, dirtyArticleCount: 1})
  expect(result.largeRebuild).toMatchObject({
    rebuildPhase: 'project_scope_article',
    refreshStatus: 'running',
    refreshToken: '3',
  })
  expect(result.plannedWork).toBe('dirty-materialization')
})
