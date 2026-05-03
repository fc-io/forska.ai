import {rmSync} from 'node:fs'

import {expect, test} from 'bun:test'

const removeFileIfExists = (filePath: string) => {
  rmSync(filePath, {force: true, recursive: true})
}

const getLastJsonLine = (stdout: string) => {
  const lines = stdout
    .split('\n')
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      return line !== ''
    })

  return lines.at(-1) ?? ''
}

const getScript = (body: string) => {
  return `
    const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
    const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
    const {cleanupNextArchivedProjectBatch, runArchivedProjectBoundedCleanup} = await import('./src/server/services/archivedProjectCleanupService.ts')

    await migrateDuckdb()

    const database = getAppDatabaseService()

    await database.run(\`
      INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
      VALUES ('archived-cleanup-connection', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1');

      INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
      VALUES ('archived-cleanup-model', 'archived-cleanup-connection', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE);

      INSERT INTO app.project (
        id,
        name,
        model_id,
        archived,
        use_title,
        use_abstract,
        use_fulltext,
        use_fulltext_no_images
      )
      VALUES (
        'archived-cleanup-project',
        'Archived Cleanup Project',
        'archived-cleanup-model',
        TRUE,
        TRUE,
        TRUE,
        FALSE,
        FALSE
      );

      INSERT INTO app.archived_project_delete_tombstone (project_id)
      VALUES ('archived-cleanup-project');

      INSERT INTO app.article (id, article_title, article_created_at)
      VALUES ('archived-cleanup-article', 'Archived Cleanup Article', TIMESTAMPTZ '2026-01-01T00:00:00Z');

      INSERT INTO app.prompt (id, original_text, content_hash)
      VALUES ('archived-cleanup-prompt', 'Archived cleanup prompt', 'archived-cleanup-prompt-hash');

      INSERT INTO app.import_route (id, route)
      VALUES ('archived-cleanup-route', '/archived-cleanup');

      INSERT INTO app.project_import_route (id, project_id, import_route_id)
      VALUES ('archived-cleanup-project-route', 'archived-cleanup-project', 'archived-cleanup-route');

      INSERT INTO app.project_article (id, project_id, article_id)
      VALUES ('archived-cleanup-project-article', 'archived-cleanup-project', 'archived-cleanup-article');

      INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order)
      VALUES ('archived-cleanup-project-prompt', 'archived-cleanup-project', 'archived-cleanup-prompt', 0);

      INSERT INTO app.review (id, project_id, article_id, opened)
      VALUES ('archived-cleanup-review', 'archived-cleanup-project', 'archived-cleanup-article', TRUE);

      INSERT INTO app.judgment_job (id, project_id, status)
      VALUES ('archived-cleanup-job', 'archived-cleanup-project', 'running');

      INSERT INTO app.token_use (
        id,
        judgment_job_id,
        requests,
        total_prompt_tokens,
        total_completion_tokens,
        total_tokens
      )
      VALUES ('archived-cleanup-token-use', 'archived-cleanup-job', 1, 2, 3, 5);

      INSERT INTO app.judgment (
        id,
        article_id,
        prompt_id,
        model_id,
        project_id,
        is_answered,
        answered_original,
        use_title,
        use_abstract,
        use_fulltext,
        use_fulltext_no_images
      )
      VALUES (
        'archived-cleanup-judgment',
        'archived-cleanup-article',
        'archived-cleanup-prompt',
        'archived-cleanup-model',
        'archived-cleanup-project',
        TRUE,
        'yes',
        TRUE,
        TRUE,
        FALSE,
        FALSE
      );

      INSERT INTO app.judgment_human (id, project_id, article_id, prompt_id, is_answered, answer)
      VALUES (
        'archived-cleanup-human-judgment',
        'archived-cleanup-project',
        'archived-cleanup-article',
        'archived-cleanup-prompt',
        TRUE,
        'yes'
      );

      INSERT INTO app.judgment_human_summary (id, project_id, article_id, answer, origin)
      VALUES (
        'archived-cleanup-human-summary',
        'archived-cleanup-project',
        'archived-cleanup-article',
        'yes',
        'manual_override'
      );

      INSERT INTO app.project_mart_refresh_state (
        project_id,
        dirty_token,
        active_dirty_token,
        last_completed_dirty_token,
        refresh_status
      )
      VALUES ('archived-cleanup-project', 7, 6, 5, 'running');

      INSERT INTO app.project_mart_refresh_article_state (
        project_id,
        article_id,
        first_dirty_token,
        last_dirty_token
      )
      VALUES ('archived-cleanup-project', 'archived-cleanup-article', 5, 7);

      INSERT INTO app.project_mart_dirty_materialization_state (
        project_id,
        source_kind,
        target_dirty_token,
        materialization_status
      )
      VALUES ('archived-cleanup-project', 'project_scope', 7, 'pending');

      INSERT INTO app.project_mart_dirty_refresh_article_quarantine (
        project_id,
        article_id,
        dirty_token,
        error
      )
      VALUES ('archived-cleanup-project', 'archived-cleanup-article', 6, 'blocked');

      INSERT INTO app.project_mart_large_rebuild_state (
        project_id,
        refresh_token,
        rebuild_phase,
        refresh_status
      )
      VALUES ('archived-cleanup-project', 9, 'project_scope_article', 'running');

      INSERT INTO app.judgment_job_sqlite_outbox_import (
        job_id,
        outbox_seq,
        queue_prompt_id,
        judgment_id,
        article_id,
        prompt_id,
        model_id,
        project_id,
        import_status
      )
      VALUES (
        'archived-cleanup-job',
        1,
        'archived-cleanup-queue-prompt',
        'archived-cleanup-judgment',
        'archived-cleanup-article',
        'archived-cleanup-prompt',
        'archived-cleanup-model',
        'archived-cleanup-project',
        'imported'
      );

      INSERT INTO app.judgment_job_sqlite_health_projection (
        job_id,
        projection_source,
        projected_at,
        fresh_until_at,
        has_outbox_rows,
        outbox_row_count
      )
      VALUES (
        'archived-cleanup-job',
        'test',
        current_timestamp,
        current_timestamp,
        TRUE,
        1
      );

      INSERT INTO mart.project_scope_article (
        project_id,
        article_id,
        in_curated_scope,
        in_route_scope
      )
      VALUES ('archived-cleanup-project', 'archived-cleanup-article', TRUE, FALSE);

      INSERT INTO mart.judgment_fact (
        judgment_id,
        article_id,
        prompt_id,
        model_id,
        project_id,
        use_title,
        use_abstract,
        use_fulltext,
        use_fulltext_no_images,
        is_answered,
        answered_original,
        confidence_original,
        quotes,
        article_title,
        created_at,
        updated_at
      )
      VALUES (
        'archived-cleanup-judgment',
        'archived-cleanup-article',
        'archived-cleanup-prompt',
        'archived-cleanup-model',
        'archived-cleanup-project',
        TRUE,
        TRUE,
        FALSE,
        FALSE,
        TRUE,
        'yes',
        50,
        '[]'::JSON,
        'Archived Cleanup Article',
        current_timestamp,
        current_timestamp
      );
    \`)

    ${body}
  `
}

const runScript = <T>(body: string) => {
  const duckdbPath = `/tmp/f2-archived-project-cleanup-${Date.now()}-${Math.random().toString(16).slice(2)}.duckdb`
  const result = globalThis.Bun.spawnSync(['bun', '-e', getScript(body)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      API_SERVER_PORT: '3001',
      DUCKDB_PATH: duckdbPath,
      SERVER_DUCKDB_OWNER_URL: '',
      SERVER_ROLE: 'maintenance-worker',
      VITE_PORT: '3000',
    },
  })

  try {
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'Archived cleanup test failed')
    }

    return JSON.parse(getLastJsonLine(result.stdout.toString())) as T
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
    removeFileIfExists('/tmp/duckdb-temp')
  }
}

test('bounded cleanup keeps tombstoned project identity until blockers are cleared and preserves shared judgment facts', () => {
  const result = runScript<{
    firstBatch: {deletedRowCount: number; phase: string; projectId: string | null; tableName: string | null}
    finalSnapshot: {
      appJudgmentProjectId: string | null
      martJudgmentProjectId: string | null
      projectArticleRows: number
      projectRows: number
      runtimeRows: number
    }
    runResult: {deletedRowCount: number; status: string}
    snapshotAfterFirstBatch: {projectArticleRows: number; projectRows: number; runtimeRows: number}
  }>(`
    const firstBatch = await cleanupNextArchivedProjectBatch({batchSize: 1})
    const [snapshotAfterFirstBatch] = await database.queryJson(\`
      SELECT
        (SELECT COUNT(*) FROM app.project WHERE id = 'archived-cleanup-project')::INTEGER AS projectRows,
        (SELECT COUNT(*) FROM app.project_article WHERE project_id = 'archived-cleanup-project')::INTEGER AS projectArticleRows,
        (
          (SELECT COUNT(*) FROM app.project_mart_refresh_state WHERE project_id = 'archived-cleanup-project')
          + (SELECT COUNT(*) FROM app.project_mart_refresh_article_state WHERE project_id = 'archived-cleanup-project')
          + (SELECT COUNT(*) FROM app.project_mart_dirty_materialization_state WHERE project_id = 'archived-cleanup-project')
          + (SELECT COUNT(*) FROM app.project_mart_dirty_refresh_article_quarantine WHERE project_id = 'archived-cleanup-project')
          + (SELECT COUNT(*) FROM app.project_mart_large_rebuild_state WHERE project_id = 'archived-cleanup-project')
        )::INTEGER AS runtimeRows
    \`)
    const runResult = await runArchivedProjectBoundedCleanup({batchSize: 1, maxBatches: 80})
    const [finalSnapshot] = await database.queryJson(\`
      SELECT
        (SELECT COUNT(*) FROM app.project WHERE id = 'archived-cleanup-project')::INTEGER AS projectRows,
        (SELECT COUNT(*) FROM app.project_article WHERE project_id = 'archived-cleanup-project')::INTEGER AS projectArticleRows,
        (
          (SELECT COUNT(*) FROM app.project_mart_refresh_state WHERE project_id = 'archived-cleanup-project')
          + (SELECT COUNT(*) FROM app.project_mart_refresh_article_state WHERE project_id = 'archived-cleanup-project')
          + (SELECT COUNT(*) FROM app.project_mart_dirty_materialization_state WHERE project_id = 'archived-cleanup-project')
          + (SELECT COUNT(*) FROM app.project_mart_dirty_refresh_article_quarantine WHERE project_id = 'archived-cleanup-project')
          + (SELECT COUNT(*) FROM app.project_mart_large_rebuild_state WHERE project_id = 'archived-cleanup-project')
        )::INTEGER AS runtimeRows,
        (SELECT project_id FROM app.judgment WHERE id = 'archived-cleanup-judgment') AS appJudgmentProjectId,
        (SELECT project_id FROM mart.judgment_fact WHERE judgment_id = 'archived-cleanup-judgment') AS martJudgmentProjectId
    \`)

    console.log(JSON.stringify({firstBatch, finalSnapshot, runResult, snapshotAfterFirstBatch}))
    await database.close()
  `)

  expect(result.firstBatch).toEqual({
    deletedRowCount: 1,
    phase: 'mart_cleanup',
    projectId: 'archived-cleanup-project',
    tableName: 'mart.project_scope_article',
  })
  expect(result.snapshotAfterFirstBatch).toEqual({projectArticleRows: 1, projectRows: 1, runtimeRows: 5})
  expect(result.runResult.status).toBe('completed')
  expect(result.finalSnapshot).toEqual({
    appJudgmentProjectId: null,
    martJudgmentProjectId: null,
    projectArticleRows: 0,
    projectRows: 0,
    runtimeRows: 0,
  })
})
