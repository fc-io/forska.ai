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

  const [lastLine = ''] = lines.slice(-1)
  return lastLine
}

const getScript = (body: string) => {
  return `
    const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
    const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
    const {getProjectMartLargeRebuildExecutor} = await import('./src/server/services/projectMartLargeRebuildExecutor.ts')

    await migrateDuckdb()

    const database = getAppDatabaseService()
    const executor = getProjectMartLargeRebuildExecutor()

    await database.run(\`
      INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
      VALUES ('large-rebuild-executor-connection', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
    \`)
    await database.run(\`
      INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
      VALUES ('large-rebuild-executor-model', 'large-rebuild-executor-connection', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
    \`)
    await database.run(\`
      INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
      VALUES ('large-rebuild-executor-project', 'Large Rebuild Executor Project', 'large-rebuild-executor-model', TRUE, TRUE, FALSE, FALSE)
    \`)
    await database.run(\`
      INSERT INTO app.article (id, article_title, article_created_at, article_updated_at)
      VALUES
        ('article-1', 'Article 1', TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T01:00:00.000Z'),
        ('article-2', 'Article 2', TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T02:00:00.000Z'),
        ('article-3', 'Article 3', TIMESTAMPTZ '2026-04-02T00:00:00.000Z', TIMESTAMPTZ '2026-04-02T01:00:00.000Z'),
        ('article-4', 'Article 4', NULL, TIMESTAMPTZ '2026-04-03T01:00:00.000Z')
    \`)
    await database.run(\`
      INSERT INTO app.project_article (id, project_id, article_id)
      VALUES
        ('project-article-1', 'large-rebuild-executor-project', 'article-1'),
        ('project-article-2', 'large-rebuild-executor-project', 'article-2')
    \`)
    await database.run(\`
      INSERT INTO app.import_route (id, route, active)
      VALUES ('import-route-1', 'route-1', TRUE)
    \`)
    await database.run(\`
      INSERT INTO app.project_import_route (id, project_id, import_route_id)
      VALUES ('project-import-route-1', 'large-rebuild-executor-project', 'import-route-1')
    \`)
    await database.run(\`
      INSERT INTO app.article_import_route (id, article_id, import_route_id)
      VALUES
        ('article-import-route-2', 'article-2', 'import-route-1'),
        ('article-import-route-3', 'article-3', 'import-route-1'),
        ('article-import-route-4', 'article-4', 'import-route-1')
    \`)

    ${body}
  `
}

const runScript = <T>(body: string) => {
  const duckdbPath = `/tmp/f1-project-mart-large-rebuild-executor-${Date.now()}-${Math.random().toString(16).slice(2)}.duckdb`
  const runResult = globalThis.Bun.spawnSync(['bun', '-e', getScript(body)], {
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
    if (runResult.exitCode !== 0) {
      throw new Error(
        runResult.stderr.toString() || runResult.stdout.toString() || 'Large rebuild executor test failed',
      )
    }

    return JSON.parse(getLastJsonLine(runResult.stdout.toString())) as T
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.writer.lock`)
    removeFileIfExists(`${duckdbPath}.writer.history.json`)
    removeFileIfExists('/tmp/duckdb-temp')
  }
}

test('project scope source batch paginates deterministically by created_at and article_id', () => {
  const result = runScript<{
    batch1: Array<{articleId: string; inCuratedScope: boolean; inRouteScope: boolean}>
    batch2: Array<{articleId: string; inCuratedScope: boolean; inRouteScope: boolean}>
    nextCursor: {articleCreatedAt: string | null; articleId: string} | null
  }>(`
    const batch1 = await executor.getProjectScopeSourceBatch({batchSize: 2, projectId: 'large-rebuild-executor-project'})
    const nextCursor = executor.getNextBatchCursor(batch1)
    const batch2 = await executor.getProjectScopeSourceBatch({batchSize: 2, cursor: nextCursor, projectId: 'large-rebuild-executor-project'})

    console.log(JSON.stringify({
      batch1: batch1.map((row) => ({articleId: row.articleId, inCuratedScope: row.inCuratedScope, inRouteScope: row.inRouteScope})),
      batch2: batch2.map((row) => ({articleId: row.articleId, inCuratedScope: row.inCuratedScope, inRouteScope: row.inRouteScope})),
      nextCursor,
    }))
    await database.close()
  `)

  expect(result.batch1).toEqual([
    {articleId: 'article-4', inCuratedScope: false, inRouteScope: true},
    {articleId: 'article-1', inCuratedScope: true, inRouteScope: false},
  ])
  expect(result.batch2).toEqual([
    {articleId: 'article-2', inCuratedScope: true, inRouteScope: true},
    {articleId: 'article-3', inCuratedScope: false, inRouteScope: true},
  ])
  expect(result.nextCursor?.articleId).toBe('article-1')
  expect(String(result.nextCursor?.articleCreatedAt ?? '')).toContain('2026-04-01')
})

test('project scope source batch resumes from a cursor without repeating rows', () => {
  const result = runScript<{resumedBatch: Array<{articleId: string}>}>(`
    const resumedBatch = await executor.getProjectScopeSourceBatch({
      batchSize: 10,
      cursor: {articleCreatedAt: '2026-04-01T00:00:00.000Z', articleId: 'article-2'},
      projectId: 'large-rebuild-executor-project',
    })

    console.log(JSON.stringify({resumedBatch: resumedBatch.map((row) => ({articleId: row.articleId}))}))
    await database.close()
  `)

  expect(result.resumedBatch).toEqual([{articleId: 'article-3'}])
})

test('large rebuild executor defaults to the background DuckDB queue', () => {
  const result = runScript<{
    afterRead: {background: {tasksStarted: number}; main: {tasksStarted: number}}
    afterWrite: {background: {tasksStarted: number}; main: {tasksStarted: number}}
    before: {background: {tasksStarted: number}; main: {tasksStarted: number}}
  }>(`
    const {getDuckdbQueueRuntimeMetricsSnapshot} = await import('./src/server/utils/duckdbService.ts')

    const before = getDuckdbQueueRuntimeMetricsSnapshot()
    await executor.getProjectScopeSourceBatch({batchSize: 2, projectId: 'large-rebuild-executor-project'})
    const afterRead = getDuckdbQueueRuntimeMetricsSnapshot()
    await executor.resetProjectPromptAnswerFact('large-rebuild-executor-project')
    const afterWrite = getDuckdbQueueRuntimeMetricsSnapshot()

    console.log(JSON.stringify({afterRead, afterWrite, before}))
    await database.close()
  `)

  expect(result.afterRead.background.tasksStarted).toBeGreaterThan(result.before.background.tasksStarted)
  expect(result.afterRead.main.tasksStarted).toBe(result.before.main.tasksStarted)
  expect(result.afterWrite.background.tasksStarted).toBeGreaterThan(result.afterRead.background.tasksStarted)
  expect(result.afterWrite.main.tasksStarted).toBe(result.afterRead.main.tasksStarted)
})

test('prompt answer fact reset and batch rebuild operate on bounded article sets', () => {
  const result = runScript<{
    batchRows: Array<{answerValue: string; articleId: string; promptId: string}>
    remainingRows: Array<{answerValue: string; articleId: string; promptId: string}>
  }>(`
    await database.run(\`
      INSERT INTO app.prompt (id, original_text, content_hash)
      VALUES ('prompt-1', 'Prompt 1', 'hash-1')
    \`)
    await database.run(\`
      INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
      VALUES ('project-prompt-1', 'large-rebuild-executor-project', 'prompt-1', 1, TRUE)
    \`)
    await database.run(\`
      INSERT INTO mart.project_scope_article (
        project_id,
        article_id,
        in_curated_scope,
        in_route_scope,
        article_created_at,
        article_updated_at
      ) VALUES
        ('large-rebuild-executor-project', 'article-1', TRUE, FALSE, TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T01:00:00.000Z'),
        ('large-rebuild-executor-project', 'article-2', TRUE, TRUE, TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T02:00:00.000Z')
    \`)
    await database.run(\`
      INSERT INTO mart.judgment_fact (
        judgment_id,
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
        chunking_strategy,
        is_answered,
        answered_original,
        answered_original_as_array,
        normalized_answers,
        confidence_original,
        explanation,
        quotes,
        article_title,
        article_created_at,
        article_updated_at,
        article_import_route,
        article_publication_status,
        created_at,
        updated_at
      ) VALUES
        (
          'judgment-1', 'article-1', 'prompt-1', 'large-rebuild-executor-model', 'large-rebuild-executor-project', 'large-rebuild-executor-project', 'Large Rebuild Executor Project',
          TRUE, TRUE, FALSE, FALSE, NULL, TRUE, 'yes', ['yes'], ['yes'], 1, NULL, NULL, 'Article 1',
          TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T01:00:00.000Z', NULL, NULL,
          TIMESTAMPTZ '2026-04-03T00:00:00.000Z', TIMESTAMPTZ '2026-04-03T00:00:00.000Z'
        ),
        (
          'judgment-2', 'article-2', 'prompt-1', 'large-rebuild-executor-model', 'large-rebuild-executor-project', 'large-rebuild-executor-project', 'Large Rebuild Executor Project',
          TRUE, TRUE, FALSE, FALSE, NULL, TRUE, 'no', ['no'], ['no'], 1, NULL, NULL, 'Article 2',
          TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T02:00:00.000Z', NULL, NULL,
          TIMESTAMPTZ '2026-04-03T00:00:00.000Z', TIMESTAMPTZ '2026-04-03T00:00:00.000Z'
        )
    \`)
    await database.run(\`
      INSERT INTO mart.prompt_answer_fact (
        project_id,
        article_id,
        prompt_id,
        judgment_id,
        model_id,
        answer_value,
        answered_original,
        article_created_at,
        article_updated_at,
        judgment_created_at
      ) VALUES (
        'large-rebuild-executor-project', 'article-999', 'prompt-1', 'old-judgment', 'large-rebuild-executor-model', 'old', 'old',
        TIMESTAMPTZ '2026-03-01T00:00:00.000Z', TIMESTAMPTZ '2026-03-01T00:00:00.000Z', TIMESTAMPTZ '2026-03-01T00:00:00.000Z'
      )
    \`)

    await executor.resetProjectPromptAnswerFact('large-rebuild-executor-project')
    await executor.rebuildProjectPromptAnswerFactBatch('large-rebuild-executor-project', ['article-1'])

    const batchRows = await database.queryJson(\`
      SELECT article_id AS articleId, prompt_id AS promptId, answer_value AS answerValue
      FROM mart.prompt_answer_fact
      WHERE project_id = 'large-rebuild-executor-project'
      ORDER BY article_id ASC, answer_value ASC
    \`)

    await executor.rebuildProjectPromptAnswerFactBatch('large-rebuild-executor-project', ['article-2'])

    const remainingRows = await database.queryJson(\`
      SELECT article_id AS articleId, prompt_id AS promptId, answer_value AS answerValue
      FROM mart.prompt_answer_fact
      WHERE project_id = 'large-rebuild-executor-project'
      ORDER BY article_id ASC, answer_value ASC
    \`)

    console.log(JSON.stringify({batchRows, remainingRows}))
    await database.close()
  `)

  expect(result.batchRows).toEqual([{articleId: 'article-1', promptId: 'prompt-1', answerValue: 'yes'}])
  expect(result.remainingRows).toEqual([
    {articleId: 'article-1', promptId: 'prompt-1', answerValue: 'yes'},
    {articleId: 'article-2', promptId: 'prompt-1', answerValue: 'no'},
  ])
})

test('review answer dictionary reset and rebuild derive prompt answer ids from prompt_answer_fact', () => {
  const result = runScript<{rows: Array<{answerId: number; answerValue: string; promptId: string}>}>(`
    await database.run(\`
      INSERT INTO app.review_answer_dictionary (
        project_id,
        prompt_id,
        answer_id,
        answer_value,
        numeric_answer_value,
        dictionary_updated_at
      ) VALUES (
        'large-rebuild-executor-project',
        'prompt-old',
        1,
        'stale',
        NULL,
        TIMESTAMPTZ '2026-03-01T00:00:00.000Z'
      )
    \`)
    await database.run(\`
      INSERT INTO mart.prompt_answer_fact (
        project_id,
        article_id,
        prompt_id,
        judgment_id,
        model_id,
        answer_value,
        answered_original,
        article_created_at,
        article_updated_at,
        judgment_created_at
      ) VALUES
        ('large-rebuild-executor-project', 'article-1', 'prompt-1', 'judgment-1', 'large-rebuild-executor-model', 'yes', 'yes', TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T01:00:00.000Z', TIMESTAMPTZ '2026-04-03T00:00:00.000Z'),
        ('large-rebuild-executor-project', 'article-2', 'prompt-1', 'judgment-2', 'large-rebuild-executor-model', 'no', 'no', TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T02:00:00.000Z', TIMESTAMPTZ '2026-04-03T00:00:00.000Z'),
        ('large-rebuild-executor-project', 'article-3', 'prompt-2', 'judgment-3', 'large-rebuild-executor-model', '3', '3', TIMESTAMPTZ '2026-04-02T00:00:00.000Z', TIMESTAMPTZ '2026-04-02T01:00:00.000Z', TIMESTAMPTZ '2026-04-03T00:00:00.000Z')
    \`)

    await executor.resetProjectReviewAnswerDictionary('large-rebuild-executor-project')
    await executor.rebuildProjectReviewAnswerDictionary('large-rebuild-executor-project')

    const rows = await database.queryJson(\`
      SELECT prompt_id AS promptId, answer_id AS answerId, answer_value AS answerValue
      FROM app.review_answer_dictionary
      WHERE project_id = 'large-rebuild-executor-project'
      ORDER BY prompt_id ASC, answer_id ASC
    \`)

    console.log(JSON.stringify({rows}))
    await database.close()
  `)

  expect(result.rows).toEqual([
    {promptId: 'prompt-1', answerId: 1, answerValue: 'no'},
    {promptId: 'prompt-1', answerId: 2, answerValue: 'yes'},
    {promptId: 'prompt-2', answerId: 1, answerValue: '3'},
  ])
})

test('filter member rollup and serving staging rebuild end to end on bounded article sets', () => {
  const result = runScript<{
    filterRows: Array<{answerId: number; articleId: string; generation: string; promptId: string}>
    rollupRows: Array<{articleId: string; enabledPromptCount: number; hasAllLlmJudgments: boolean}>
    servingGeneration: Array<{activeGeneration: string}>
    servingRows: Array<{articleId: string; generation: string}>
  }>(`
    await database.run(\`
      INSERT INTO app.prompt (id, original_text, content_hash)
      VALUES ('prompt-1', 'Prompt 1', 'hash-1')
    \`)
    await database.run(\`
      INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
      VALUES ('project-prompt-1', 'large-rebuild-executor-project', 'prompt-1', 1, TRUE)
    \`)
    await database.run(\`
      INSERT INTO mart.project_scope_article (
        project_id,
        article_id,
        in_curated_scope,
        in_route_scope,
        article_created_at,
        article_updated_at
      ) VALUES
        ('large-rebuild-executor-project', 'article-1', TRUE, FALSE, TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T01:00:00.000Z'),
        ('large-rebuild-executor-project', 'article-2', TRUE, TRUE, TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T02:00:00.000Z')
    \`)
    await database.run(\`
      INSERT INTO mart.prompt_answer_fact (
        project_id,
        article_id,
        prompt_id,
        judgment_id,
        model_id,
        answer_value,
        answered_original,
        article_created_at,
        article_updated_at,
        judgment_created_at
      ) VALUES
        ('large-rebuild-executor-project', 'article-1', 'prompt-1', 'judgment-1', 'large-rebuild-executor-model', 'yes', 'yes', TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T01:00:00.000Z', TIMESTAMPTZ '2026-04-03T00:00:00.000Z'),
        ('large-rebuild-executor-project', 'article-2', 'prompt-1', 'judgment-2', 'large-rebuild-executor-model', 'no', 'no', TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T02:00:00.000Z', TIMESTAMPTZ '2026-04-03T00:00:00.000Z')
    \`)
    await database.run(\`
      INSERT INTO mart.judgment_fact (
        judgment_id,
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
        chunking_strategy,
        is_answered,
        answered_original,
        answered_original_as_array,
        normalized_answers,
        confidence_original,
        explanation,
        quotes,
        article_title,
        article_created_at,
        article_updated_at,
        article_import_route,
        article_publication_status,
        created_at,
        updated_at
      ) VALUES
        ('judgment-1', 'article-1', 'prompt-1', 'large-rebuild-executor-model', 'large-rebuild-executor-project', 'large-rebuild-executor-project', 'Project', TRUE, TRUE, FALSE, FALSE, NULL, TRUE, 'yes', ['yes'], ['yes'], 1, NULL, NULL, 'Article 1', TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T01:00:00.000Z', NULL, NULL, TIMESTAMPTZ '2026-04-03T00:00:00.000Z', TIMESTAMPTZ '2026-04-03T00:00:00.000Z'),
        ('judgment-2', 'article-2', 'prompt-1', 'large-rebuild-executor-model', 'large-rebuild-executor-project', 'large-rebuild-executor-project', 'Project', TRUE, TRUE, FALSE, FALSE, NULL, TRUE, 'no', ['no'], ['no'], 1, NULL, NULL, 'Article 2', TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T02:00:00.000Z', NULL, NULL, TIMESTAMPTZ '2026-04-03T00:00:00.000Z', TIMESTAMPTZ '2026-04-03T00:00:00.000Z')
    \`)

    await executor.resetProjectReviewAnswerDictionary('large-rebuild-executor-project')
    await executor.rebuildProjectReviewAnswerDictionary('large-rebuild-executor-project')
    await executor.setupProjectReviewServingStaging('large-rebuild-executor-project')
    await executor.rebuildProjectReviewArticleFilterMemberBatch('large-rebuild-executor-project', ['article-1', 'article-2'])
    await executor.resetProjectReviewArticleRollup('large-rebuild-executor-project')
    await executor.rebuildProjectReviewArticleRollupBatch('large-rebuild-executor-project', ['article-1', 'article-2'])
    await executor.rebuildProjectReviewServingBatch('large-rebuild-executor-project', ['article-1', 'article-2'])
    await executor.finalizeProjectReviewServing('large-rebuild-executor-project')

    const filterRows = await database.queryJson(\`
      SELECT prompt_id AS promptId, answer_id AS answerId, article_id AS articleId, generation AS generation
      FROM mart.review_article_filter_member
      WHERE project_id = 'large-rebuild-executor-project'
      ORDER BY article_id ASC
    \`)
    const rollupRows = await database.queryJson(\`
      SELECT article_id AS articleId, enabled_prompt_count AS enabledPromptCount, has_all_llm_judgments AS hasAllLlmJudgments
      FROM mart.review_article_rollup
      WHERE project_id = 'large-rebuild-executor-project'
      ORDER BY article_id ASC
    \`)
    const servingGeneration = await database.queryJson(\`
      SELECT active_generation AS activeGeneration
      FROM app.project_review_serving_generation
      WHERE project_id = 'large-rebuild-executor-project'
    \`)
    const servingRows = await database.queryJson(\`
      SELECT article_id AS articleId, generation AS generation
      FROM mart.review_article_serving
      WHERE project_id = 'large-rebuild-executor-project'
      ORDER BY article_id ASC
    \`)

    console.log(JSON.stringify({filterRows, rollupRows, servingGeneration, servingRows}))
    await database.close()
  `)

  expect(result.filterRows).toEqual([
    {promptId: 'prompt-1', answerId: 2, articleId: 'article-1', generation: '1'},
    {promptId: 'prompt-1', answerId: 1, articleId: 'article-2', generation: '1'},
  ])
  expect(result.rollupRows).toEqual([
    {articleId: 'article-1', enabledPromptCount: 1, hasAllLlmJudgments: true},
    {articleId: 'article-2', enabledPromptCount: 1, hasAllLlmJudgments: true},
  ])
  expect(result.servingGeneration).toEqual([{activeGeneration: '1'}])
  expect(result.servingRows).toEqual([
    {articleId: 'article-1', generation: '1'},
    {articleId: 'article-2', generation: '1'},
  ])
})
