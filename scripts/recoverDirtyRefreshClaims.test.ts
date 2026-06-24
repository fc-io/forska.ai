import {existsSync, rmSync} from 'node:fs'
import {dirname, join} from 'node:path'

import {expect, test} from 'bun:test'

const projectRoot = process.cwd()
const defaultEnv = {
  ...process.env,
  API_SERVER_PORT: '39105',
  RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
  RUN_SERVER_FULL_TEXT_FETCHING: 'false',
  SERVER_DUCKDB_OWNER_URL: '',
  SERVER_ROLE: 'maintenance-worker',
  VITE_PORT: '39915',
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

const runSeed = (duckdbPath: string, sql: string) => {
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
          VALUES ('recover-dirty-connection', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1');

          INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
          VALUES ('recover-dirty-model', 'recover-dirty-connection', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE);

          ${sql}
        \`)
        await database.close()
      `,
    ],
    {cwd: projectRoot, env: {...defaultEnv, DUCKDB_PATH: duckdbPath}},
  )

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString() || 'recover dirty refresh seed failed')
  }
}

const runQuery = <T>(duckdbPath: string, sql: string) => {
  const result = globalThis.Bun.spawnSync(['bun', 'scripts/dbQuerySnapshot.ts', `--sql=${sql}`], {
    cwd: projectRoot,
    env: {...defaultEnv, DUCKDB_PATH: duckdbPath},
  })

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString() || 'query failed')
  }

  return JSON.parse(getLastJsonLine(result.stdout.toString())) as T
}

test('recoverDirtyRefreshClaims lists dirty materialization, quarantine, refresh, and large rebuild risks', () => {
  const duckdbPath = join(projectRoot, '.tmp', `recover-dirty-refresh-claims-list-${Date.now()}.duckdb`)
  removeFileIfExists(dirname(duckdbPath))
  runSeed(
    duckdbPath,
    `
      INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
      VALUES ('recover-list-project', 'Recover List Project', 'recover-dirty-model', TRUE, TRUE, FALSE, FALSE);

      INSERT INTO app.article (id, article_id, article_title, article_created_at, article_updated_at)
      VALUES ('recover-list-article', 'recover-list-external', 'Recover List Article', TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T01:00:00.000Z');

      INSERT INTO app.project_mart_refresh_state (
        project_id,
        dirty_token,
        active_dirty_token,
        last_completed_dirty_token,
        refresh_status,
        worker_id,
        lease_expires_at
      ) VALUES (
        'recover-list-project',
        2,
        2,
        0,
        'running',
        'stale-refresh-worker',
        TIMESTAMPTZ '2026-04-01T00:00:00.000Z'
      );

      INSERT INTO app.project_mart_dirty_materialization_state (
        project_id,
        source_kind,
        target_dirty_token,
        inserted_row_count,
        materialization_status,
        materialization_owner,
        lease_expires_at
      ) VALUES (
        'recover-list-project',
        'project_scope_article',
        2,
        1,
        'running',
        'stale-materialization-worker',
        TIMESTAMPTZ '2026-04-01T00:00:00.000Z'
      );

      INSERT INTO app.project_mart_dirty_refresh_article_quarantine (
        project_id,
        article_id,
        dirty_token,
        error
      ) VALUES (
        'recover-list-project',
        'recover-list-article',
        1,
        'bad row'
      );

      INSERT INTO app.project_mart_large_rebuild_state (
        project_id,
        refresh_token,
        rebuild_phase,
        refresh_status,
        worker_id,
        lease_expires_at
      ) VALUES (
        'recover-list-project',
        3,
        'project_scope_article',
        'running',
        'stale-large-worker',
        TIMESTAMPTZ '2026-04-01T00:00:00.000Z'
      );
    `,
  )

  const runScript = globalThis.Bun.spawnSync(['bun', 'scripts/recoverDirtyRefreshClaims.ts'], {
    cwd: projectRoot,
    env: {...defaultEnv, DUCKDB_PATH: duckdbPath},
  })

  if (runScript.exitCode !== 0) {
    throw new Error(runScript.stderr.toString() || runScript.stdout.toString() || 'recover list failed')
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    staleClaims: Array<{projectId: string}>
    staleDirtyMaterializations: Array<{projectId: string}>
    staleLargeRebuildClaims: Array<{projectId: string}>
    unresolvedQuarantineBarriers: Array<{projectId: string}>
  }

  expect(
    result.staleClaims.map((row) => {
      return row.projectId
    }),
  ).toEqual(['recover-list-project'])
  expect(
    result.staleDirtyMaterializations.map((row) => {
      return row.projectId
    }),
  ).toEqual(['recover-list-project'])
  expect(
    result.staleLargeRebuildClaims.map((row) => {
      return row.projectId
    }),
  ).toEqual(['recover-list-project'])
  expect(
    result.unresolvedQuarantineBarriers.map((row) => {
      return row.projectId
    }),
  ).toEqual(['recover-list-project'])
})

test('recoverDirtyRefreshClaims recovers stale dirty-refresh claims only with explicit confirmation', () => {
  const duckdbPath = join(projectRoot, '.tmp', `recover-dirty-refresh-claims-apply-${Date.now()}.duckdb`)
  removeFileIfExists(dirname(duckdbPath))
  runSeed(
    duckdbPath,
    `
      INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
      VALUES ('recover-apply-project', 'Recover Apply Project', 'recover-dirty-model', TRUE, TRUE, FALSE, FALSE);

      INSERT INTO app.prompt (id, original_text, content_hash)
      VALUES ('recover-apply-prompt', 'Recover prompt', 'recover-apply-prompt-hash');

      INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
      VALUES ('recover-apply-project-prompt', 'recover-apply-project', 'recover-apply-prompt', 1, TRUE);

      INSERT INTO app.article (id, article_id, article_title, article_created_at, article_updated_at)
      VALUES ('recover-apply-article', 'recover-apply-external', 'Recover Apply Article', TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T01:00:00.000Z');

      INSERT INTO app.project_article (id, project_id, article_id)
      VALUES ('recover-apply-project-article', 'recover-apply-project', 'recover-apply-article');

      INSERT INTO app.review_projection_identity_manifest (
        manifest_id,
        project_id,
        projection_component,
        projection_identity,
        base_generation,
        patch_watermark,
        input_watermark,
        input_digest,
        definition_version,
        status
      ) VALUES (
        'recover-apply-summary-manifest',
        'recover-apply-project',
        'summary',
        'summary:recover-apply',
        1,
        1,
        1,
        'summary-digest',
        'summary:v1',
        'active'
      );

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
        'recover-apply-project',
        'recover-apply-snapshot',
        'active',
        'recover-apply-review-config',
        '{}'::JSON,
        '{"required":[{"component":"summary","projectionIdentity":"summary:recover-apply","baseGeneration":1,"patchWatermark":1}],"optional":[]}'::JSON,
        '["summary"]'::JSON,
        '[]'::JSON,
        '{}'::JSON,
        TIMESTAMPTZ '2026-04-01T00:00:00.000Z'
      );

      INSERT INTO app.project_mart_refresh_state (
        project_id,
        dirty_token,
        active_dirty_token,
        last_completed_dirty_token,
        refresh_status,
        worker_id,
        lease_expires_at
      ) VALUES (
        'recover-apply-project',
        1,
        1,
        0,
        'running',
        'stale-refresh-worker',
        TIMESTAMPTZ '2026-04-01T00:00:00.000Z'
      );

      INSERT INTO app.project_mart_refresh_article_state (
        project_id,
        article_id,
        first_dirty_token,
        last_dirty_token
      ) VALUES (
        'recover-apply-project',
        'recover-apply-article',
        1,
        1
      );

      INSERT INTO app.project_mart_dirty_materialization_state (
        project_id,
        source_kind,
        target_dirty_token,
        inserted_row_count,
        materialization_status,
        materialization_owner,
        lease_expires_at
      ) VALUES (
        'recover-apply-project',
        'project_scope_article',
        1,
        1,
        'running',
        'stale-materialization-worker',
        TIMESTAMPTZ '2026-04-01T00:00:00.000Z'
      );

      INSERT INTO app.project_mart_large_rebuild_state (
        project_id,
        refresh_token,
        rebuild_phase,
        refresh_status,
        worker_id,
        lease_expires_at
      ) VALUES (
        'recover-apply-project',
        2,
        'project_scope_article',
        'running',
        'stale-large-worker',
        TIMESTAMPTZ '2026-04-01T00:00:00.000Z'
      );
    `,
  )

  const runScript = globalThis.Bun.spawnSync(['bun', 'scripts/recoverDirtyRefreshClaims.ts', '--recover', '--yes'], {
    cwd: projectRoot,
    env: {...defaultEnv, DUCKDB_PATH: duckdbPath},
  })

  if (runScript.exitCode !== 0) {
    throw new Error(runScript.stderr.toString() || runScript.stdout.toString() || 'recover apply failed')
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    recoverAttempted: boolean
    recoveryResult: {kind: string; projectIds: string[]; reason: string; requestIds: string[]}
    recoveryResults: Array<{kind: string; projectIds: string[]; reason: string; requestIds: string[]}>
    status: string
  }
  const [state] = runQuery<
    Array<{
      activeDirtyToken: number
      lastCompletedDirtyToken: number
      leaseExpiresAt: string | null
      refreshStatus: string
    }>
  >(
    duckdbPath,
    "SELECT refresh_status AS refreshStatus, CAST(active_dirty_token AS INTEGER) AS activeDirtyToken, CAST(last_completed_dirty_token AS INTEGER) AS lastCompletedDirtyToken, lease_expires_at AS leaseExpiresAt FROM app.project_mart_refresh_state WHERE project_id = 'recover-apply-project'",
  )
  const [materializationState] = runQuery<
    Array<{leaseExpiresAt: string | null; materializationOwner: string | null; materializationStatus: string}>
  >(
    duckdbPath,
    "SELECT materialization_status AS materializationStatus, materialization_owner AS materializationOwner, lease_expires_at AS leaseExpiresAt FROM app.project_mart_dirty_materialization_state WHERE project_id = 'recover-apply-project'",
  )
  const [largeRebuildState] = runQuery<
    Array<{leaseExpiresAt: string | null; refreshStatus: string; supersededAt: string | null; workerId: string | null}>
  >(
    duckdbPath,
    "SELECT refresh_status AS refreshStatus, worker_id AS workerId, lease_expires_at AS leaseExpiresAt, superseded_at AS supersededAt FROM app.project_mart_large_rebuild_state WHERE project_id = 'recover-apply-project'",
  )
  const [requestCount] = runQuery<Array<{requestCount: number}>>(
    duckdbPath,
    "SELECT CAST(COUNT(*) AS INTEGER) AS requestCount FROM app.review_rebuild_request WHERE project_id = 'recover-apply-project'",
  )

  expect(result.recoverAttempted).toBe(true)
  expect(result.status).toBe('recovered')
  expect(result.recoveryResult).toMatchObject({
    kind: 'v4_rebuild_request',
    projectIds: ['recover-apply-project'],
    reason: 'recoverDirtyRefreshClaims.staleLegacyClaim',
  })
  expect(result.recoveryResult.requestIds).toHaveLength(1)
  expect(
    result.recoveryResults.map((recoveryResult) => {
      return recoveryResult.reason
    }),
  ).toEqual(['recoverDirtyRefreshClaims.staleLegacyClaim'])
  expect(requestCount?.requestCount).toBe(1)
  expect(state).toEqual({activeDirtyToken: 0, lastCompletedDirtyToken: 1, leaseExpiresAt: null, refreshStatus: 'idle'})
  expect(materializationState).toEqual({
    leaseExpiresAt: null,
    materializationOwner: null,
    materializationStatus: 'completed',
  })
  expect(largeRebuildState).toMatchObject({leaseExpiresAt: null, refreshStatus: 'idle', workerId: null})
  expect(largeRebuildState?.supersededAt).not.toBeNull()
})
