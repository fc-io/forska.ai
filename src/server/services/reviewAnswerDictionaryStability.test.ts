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
    const {runArchivedProjectBoundedCleanup} = await import('./src/server/services/archivedProjectCleanupService.ts')
    const {getDuckdbMartMaintenanceService} = await import('./src/server/services/getDuckdbMartMaintenanceService.ts')
    const {getReviewAnswerDictionaryStabilityService} = await import('./src/server/services/reviewAnswerDictionaryStabilityService.ts')

    await migrateDuckdb()

    const database = getAppDatabaseService()
    const martMaintenanceService = getDuckdbMartMaintenanceService()
    const dictionaryStabilityService = getReviewAnswerDictionaryStabilityService()

    await database.run(\`
      INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
      VALUES ('dictionary-stability-connection', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1');

      INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
      VALUES ('dictionary-stability-model', 'dictionary-stability-connection', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE);
    \`)

    ${body}
  `
}

const runScript = <T>(body: string) => {
  const duckdbPath = `/tmp/f2-review-answer-dictionary-stability-${Date.now()}-${Math.random().toString(16).slice(2)}.duckdb`
  const result = globalThis.Bun.spawnSync(['bun', '-e', getScript(body)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      API_SERVER_PORT: '3001',
      DUCKDB_PATH: duckdbPath,
      SERVER_ROLE: 'dev-single',
      VITE_PORT: '3000',
    },
  })

  try {
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'Dictionary stability test failed')
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

test('project refresh appends dictionary values and stores judgment display metadata in serving detail', () => {
  const result = runScript<{
    activeDetailRows: Array<{judgmentProjectId: string | null; snapshotProjectId: string | null}>
    dictionaryRows: Array<{answerId: number; answerValue: string}>
    factRows: Array<{projectId: string | null; snapshotProjectId: string | null}>
    initialDictionaryRows: Array<{answerId: number; answerValue: string}>
  }>(`
    await database.run(\`
      INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
      VALUES ('dictionary-stability-project', 'Dictionary Stability Project', 'dictionary-stability-model', TRUE, TRUE, FALSE, FALSE);

      INSERT INTO app.prompt (id, original_text, content_hash)
      VALUES ('dictionary-stability-prompt', 'Dictionary stability prompt', 'dictionary-stability-prompt-hash');

      INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
      VALUES ('dictionary-stability-project-prompt', 'dictionary-stability-project', 'dictionary-stability-prompt', 1, TRUE);

      INSERT INTO app.article (id, article_title, article_created_at, article_updated_at, article_id)
      VALUES ('dictionary-stability-article', 'Dictionary Stability Article', TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T01:00:00.000Z', 'external-dictionary-stability');

      INSERT INTO app.project_article (id, project_id, article_id)
      VALUES ('dictionary-stability-project-article', 'dictionary-stability-project', 'dictionary-stability-article');

      INSERT INTO app.judgment (
        id,
        article_id,
        prompt_id,
        model_id,
        project_id,
        snapshot_project_id,
        snapshot_project_model_name,
        use_title,
        use_abstract,
        use_fulltext,
        use_fulltext_no_images,
        is_answered,
        answered_original,
        answered_original_as_array,
        confidence_original
      )
      VALUES (
        'dictionary-stability-judgment',
        'dictionary-stability-article',
        'dictionary-stability-prompt',
        'dictionary-stability-model',
        'dictionary-stability-project',
        'dictionary-stability-project',
        'Dictionary Stability Model',
        TRUE,
        TRUE,
        FALSE,
        FALSE,
        TRUE,
        'yes',
        ['yes'],
        90
      );
    \`)

    await martMaintenanceService.refreshProject('dictionary-stability-project')

    const initialDictionaryRows = await database.queryJson(\`
      SELECT CAST(answer_id AS INTEGER) AS answerId, answer_value AS answerValue
      FROM app.review_answer_dictionary
      WHERE project_id = 'dictionary-stability-project'
        AND prompt_id = 'dictionary-stability-prompt'
      ORDER BY answer_id ASC
    \`)

    await database.run(\`
      UPDATE app.judgment
      SET answered_original = 'aaa',
          answered_original_as_array = ['aaa'],
          updated_at = TIMESTAMPTZ '2026-04-02T00:00:00.000Z'
      WHERE id = 'dictionary-stability-judgment'
    \`)

    await martMaintenanceService.refreshProject('dictionary-stability-project')

    const dictionaryRows = await database.queryJson(\`
      SELECT CAST(answer_id AS INTEGER) AS answerId, answer_value AS answerValue
      FROM app.review_answer_dictionary
      WHERE project_id = 'dictionary-stability-project'
        AND prompt_id = 'dictionary-stability-prompt'
      ORDER BY answer_id ASC
    \`)
    const factRows = await database.queryJson(\`
      SELECT project_id AS projectId, snapshot_project_id AS snapshotProjectId
      FROM mart.judgment_fact
      WHERE judgment_id = 'dictionary-stability-judgment'
    \`)
    const activeDetailRows = await database.queryJson(\`
      SELECT detail.judgment_project_id AS judgmentProjectId, detail.snapshot_project_id AS snapshotProjectId
      FROM mart.review_article_serving_detail detail
      INNER JOIN app.project_review_serving_generation generation
        ON generation.project_id = detail.project_id
       AND generation.active_generation = detail.generation
      WHERE detail.project_id = 'dictionary-stability-project'
        AND detail.judgment_id = 'dictionary-stability-judgment'
    \`)

    console.log(JSON.stringify({activeDetailRows, dictionaryRows, factRows, initialDictionaryRows}))
    await database.close()
  `)

  expect(result.initialDictionaryRows).toEqual([{answerId: 1, answerValue: 'yes'}])
  expect(result.dictionaryRows).toEqual([
    {answerId: 1, answerValue: 'yes'},
    {answerId: 2, answerValue: 'aaa'},
  ])
  expect(result.factRows).toEqual([{projectId: null, snapshotProjectId: null}])
  expect(result.activeDetailRows).toEqual([
    {judgmentProjectId: 'dictionary-stability-project', snapshotProjectId: 'dictionary-stability-project'},
  ])
})

test('archived cleanup deletes dictionary rows with project-scoped metadata', () => {
  const result = runScript<{
    dictionaryRows: Array<{answerId: number; answerValue: string; projectId: string}>
    projectRows: number
  }>(`
    await database.run(\`
      INSERT INTO app.project (id, name, model_id, archived, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
      VALUES ('dictionary-archived-project', 'Dictionary Archived Project', 'dictionary-stability-model', TRUE, TRUE, TRUE, FALSE, FALSE);

      INSERT INTO app.archived_project_delete_tombstone (project_id)
      VALUES ('dictionary-archived-project');

      INSERT INTO app.prompt (id, original_text, content_hash)
      VALUES ('dictionary-archived-prompt', 'Dictionary archived prompt', 'dictionary-archived-prompt-hash');

      INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
      VALUES ('dictionary-archived-project-prompt', 'dictionary-archived-project', 'dictionary-archived-prompt', 1, TRUE);

      INSERT INTO app.review_answer_dictionary (project_id, prompt_id, answer_id, answer_value, numeric_answer_value)
      VALUES ('dictionary-archived-project', 'dictionary-archived-prompt', 3, 'archived-answer', NULL);
    \`)

    await runArchivedProjectBoundedCleanup({batchSize: 10, maxBatches: 20})

    const [projectSnapshot] = await database.queryJson(\`
      SELECT COUNT(*)::INTEGER AS projectRows
      FROM app.project
      WHERE id = 'dictionary-archived-project'
    \`)
    const dictionaryRows = await database.queryJson(\`
      SELECT project_id AS projectId, CAST(answer_id AS INTEGER) AS answerId, answer_value AS answerValue
      FROM app.review_answer_dictionary
      WHERE project_id = 'dictionary-archived-project'
      ORDER BY prompt_id ASC, answer_id ASC
    \`)

    console.log(JSON.stringify({dictionaryRows, projectRows: Number(projectSnapshot?.projectRows ?? 0)}))
    await database.close()
  `)

  expect(result.projectRows).toBe(0)
  expect(result.dictionaryRows).toEqual([])
})

test('dictionary pruning deletes only rows with no serving generation or filter references', () => {
  const result = runScript<{
    pruneResult: {deletedRowCount: number}
    rows: Array<{answerId: number; projectId: string}>
  }>(`
    await database.run(\`
      INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
      VALUES
        ('dictionary-prune-active-project', 'Dictionary Prune Active Project', 'dictionary-stability-model', TRUE, TRUE, FALSE, FALSE),
        ('dictionary-prune-target-project', 'Dictionary Prune Target Project', 'dictionary-stability-model', TRUE, TRUE, FALSE, FALSE),
        ('dictionary-prune-orphan-project', 'Dictionary Prune Orphan Project', 'dictionary-stability-model', TRUE, TRUE, FALSE, FALSE);

      INSERT INTO app.review_answer_dictionary (project_id, prompt_id, answer_id, answer_value, numeric_answer_value)
      VALUES
        ('dictionary-prune-active-project', 'dictionary-prune-prompt', 1, 'active', NULL),
        ('dictionary-prune-active-project', 'dictionary-prune-prompt', 2, 'active-unmembered', NULL),
        ('dictionary-prune-target-project', 'dictionary-prune-prompt', 1, 'target', NULL),
        ('dictionary-prune-orphan-project', 'dictionary-prune-prompt', 1, 'orphan', NULL);

      INSERT INTO app.project_review_serving_generation (project_id, active_generation)
      VALUES ('dictionary-prune-active-project', 4);

      INSERT INTO mart.review_article_serving (
        project_id,
        generation,
        article_id,
        article_title,
        has_all_llm_judgments,
        llm_judged_prompt_count,
        enabled_prompt_count,
        human_answered_prompt_count,
        has_all_human_answers,
        review_opened,
        review_sections_completed
      )
      VALUES ('dictionary-prune-active-project', 4, 'dictionary-prune-article', 'Dictionary Prune Article', TRUE, 1, 1, 0, FALSE, FALSE, 0);

      INSERT INTO mart.review_article_filter_member (project_id, generation, prompt_id, answer_id, article_id)
      VALUES ('dictionary-prune-active-project', 3, 'dictionary-prune-prompt', 1, 'dictionary-prune-article');

      INSERT INTO mart.review_article_serving_detail (
        project_id,
        generation,
        article_id,
        prompt_id,
        judgment_id,
        created_at,
        model_id
      )
      VALUES ('dictionary-prune-active-project', 4, 'dictionary-prune-article', 'dictionary-prune-prompt', 'dictionary-prune-judgment', TIMESTAMPTZ '2026-04-01T00:00:00.000Z', 'dictionary-stability-model');

      INSERT INTO app.project_mart_large_rebuild_state (
        project_id,
        refresh_token,
        rebuild_phase,
        refresh_status,
        target_generation
      )
      VALUES ('dictionary-prune-target-project', 9, 'review_article_filter_member', 'running', 5);
    \`)

    const pruneResult = await dictionaryStabilityService.pruneUnreferencedReviewAnswerDictionaryBatch({batchSize: 10})
    const rows = await database.queryJson(\`
      SELECT project_id AS projectId, CAST(answer_id AS INTEGER) AS answerId
      FROM app.review_answer_dictionary
      ORDER BY project_id ASC, answer_id ASC
    \`)

    console.log(JSON.stringify({pruneResult, rows}))
    await database.close()
  `)

  expect(result.pruneResult).toEqual({deletedRowCount: 1})
  expect(result.rows).toEqual([
    {answerId: 1, projectId: 'dictionary-prune-active-project'},
    {answerId: 2, projectId: 'dictionary-prune-active-project'},
    {answerId: 1, projectId: 'dictionary-prune-target-project'},
  ])
})
