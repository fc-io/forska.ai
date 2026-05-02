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
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
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

test('project scope reset and batch rebuild populate bounded scope rows', () => {
  const result = runScript<{rows: Array<{articleId: string; inCuratedScope: boolean; inRouteScope: boolean}>}>(`
    const batch = await executor.getProjectScopeSourceBatch({batchSize: 2, projectId: 'large-rebuild-executor-project'})

    await executor.resetProjectScope('large-rebuild-executor-project')
    await executor.rebuildProjectScopeBatch('large-rebuild-executor-project', batch)

    const rows = await database.queryJson(\`
      SELECT
        article_id AS articleId,
        in_curated_scope AS inCuratedScope,
        in_route_scope AS inRouteScope
      FROM mart.project_scope_article
      WHERE project_id = 'large-rebuild-executor-project'
      ORDER BY article_created_at ASC NULLS FIRST, article_id ASC
    \`)

    console.log(JSON.stringify({rows}))
    await database.close()
  `)

  expect(result.rows).toEqual([
    {articleId: 'article-4', inCuratedScope: false, inRouteScope: true},
    {articleId: 'article-1', inCuratedScope: true, inRouteScope: false},
  ])
})

test('project scope mart batch reads frozen scope rows instead of live scope', () => {
  const result = runScript<{rows: Array<{articleId: string; inCuratedScope: boolean; inRouteScope: boolean}>}>(`
    const batch = await executor.getProjectScopeSourceBatch({batchSize: 2, projectId: 'large-rebuild-executor-project'})

    await executor.resetProjectScope('large-rebuild-executor-project')
    await executor.rebuildProjectScopeBatch('large-rebuild-executor-project', batch)

    const rows = await executor.getProjectScopeMartBatch({batchSize: 10, projectId: 'large-rebuild-executor-project'})

    console.log(JSON.stringify({
      rows: rows.map((row) => ({articleId: row.articleId, inCuratedScope: row.inCuratedScope, inRouteScope: row.inRouteScope})),
    }))
    await database.close()
  `)

  expect(result.rows).toEqual([
    {articleId: 'article-4', inCuratedScope: false, inRouteScope: true},
    {articleId: 'article-1', inCuratedScope: true, inRouteScope: false},
  ])
})

test('project scope and judgment fact batch rebuilds are replay safe', () => {
  const result = runScript<{
    judgmentRows: Array<{articleId: string; judgmentId: string}>
    scopeRows: Array<{articleId: string}>
  }>(`
    await database.run(\`
      INSERT INTO app.prompt (id, original_text, content_hash)
      VALUES ('prompt-replay-safe', 'Prompt replay safe', 'hash-replay-safe')
    \`)
    await database.run(\`
      INSERT INTO app.judgment (
        id,
        article_id,
        prompt_id,
        model_id,
        project_id,
        snapshot_project_id,
        use_title,
        use_abstract,
        use_fulltext,
        use_fulltext_no_images,
        is_answered,
        answered_original,
        answered_original_as_array,
        confidence_original
      ) VALUES (
        'judgment-replay-safe',
        'article-1',
        'prompt-replay-safe',
        'large-rebuild-executor-model',
        'large-rebuild-executor-project',
        'large-rebuild-executor-project',
        TRUE,
        TRUE,
        FALSE,
        FALSE,
        TRUE,
        'yes',
        ['yes'],
        90
      )
    \`)

    const batch = await executor.getProjectScopeSourceBatch({batchSize: 2, projectId: 'large-rebuild-executor-project'})

    await executor.resetProjectScope('large-rebuild-executor-project')
    await executor.resetProjectJudgmentFact('large-rebuild-executor-project')
    await executor.rebuildProjectScopeBatch('large-rebuild-executor-project', batch)
    await executor.rebuildProjectScopeBatch('large-rebuild-executor-project', batch)
    await executor.rebuildProjectJudgmentFactBatch('large-rebuild-executor-project', ['article-1'])
    await executor.rebuildProjectJudgmentFactBatch('large-rebuild-executor-project', ['article-1'])

    const scopeRows = await database.queryJson(\`
      SELECT article_id AS articleId
      FROM mart.project_scope_article
      WHERE project_id = 'large-rebuild-executor-project'
      ORDER BY article_id ASC
    \`)
    const judgmentRows = await database.queryJson(\`
      SELECT judgment_id AS judgmentId, article_id AS articleId
      FROM mart.judgment_fact
      WHERE project_id = 'large-rebuild-executor-project'
      ORDER BY judgment_id ASC
    \`)

    console.log(JSON.stringify({judgmentRows, scopeRows}))
    await database.close()
  `)

  expect(result.scopeRows).toEqual([{articleId: 'article-1'}, {articleId: 'article-4'}])
  expect(result.judgmentRows).toEqual([{articleId: 'article-1', judgmentId: 'judgment-replay-safe'}])
})

test('project judgment fact reset and batch rebuild populate bounded project judgments', () => {
  const result = runScript<{rows: Array<{answer: string | null; articleId: string; judgmentId: string}>}>(`
    await database.run(\`
      INSERT INTO app.prompt (id, original_text, content_hash)
      VALUES ('prompt-judgment-fact', 'Prompt judgment fact', 'hash-judgment-fact')
    \`)
    await database.run(\`
      INSERT INTO app.judgment (
        id,
        article_id,
        prompt_id,
        model_id,
        project_id,
        snapshot_project_id,
        use_title,
        use_abstract,
        use_fulltext,
        use_fulltext_no_images,
        is_answered,
        answered_original,
        answered_original_as_array,
        confidence_original
      ) VALUES
        ('judgment-fact-1', 'article-1', 'prompt-judgment-fact', 'large-rebuild-executor-model', 'large-rebuild-executor-project', 'large-rebuild-executor-project', TRUE, TRUE, FALSE, FALSE, TRUE, ' yes ', NULL, 90),
        ('judgment-fact-2', 'article-2', 'prompt-judgment-fact', 'large-rebuild-executor-model', 'large-rebuild-executor-project', 'large-rebuild-executor-project', TRUE, TRUE, FALSE, FALSE, TRUE, 'no', ['no'], 80)
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
      ) VALUES (
        'stale-judgment-fact',
        'article-3',
        'prompt-judgment-fact',
        'large-rebuild-executor-model',
        'large-rebuild-executor-project',
        'large-rebuild-executor-project',
        NULL,
        TRUE,
        TRUE,
        FALSE,
        FALSE,
        NULL,
        TRUE,
        'stale',
        ['stale'],
        ['stale'],
        1,
        NULL,
        NULL,
        'Article 3',
        TIMESTAMPTZ '2026-04-02T00:00:00.000Z',
        TIMESTAMPTZ '2026-04-02T01:00:00.000Z',
        NULL,
        NULL,
        TIMESTAMPTZ '2026-04-03T00:00:00.000Z',
        TIMESTAMPTZ '2026-04-03T00:00:00.000Z'
      )
    \`)

    await executor.resetProjectJudgmentFact('large-rebuild-executor-project')
    await executor.rebuildProjectJudgmentFactBatch('large-rebuild-executor-project', ['article-1'])

    const rows = await database.queryJson(\`
      SELECT
        judgment_id AS judgmentId,
        article_id AS articleId,
        answered_original AS answer
      FROM mart.judgment_fact
      WHERE project_id = 'large-rebuild-executor-project'
      ORDER BY judgment_id ASC
    \`)

    console.log(JSON.stringify({rows}))
    await database.close()
  `)

  expect(result.rows).toEqual([{answer: 'yes', articleId: 'article-1', judgmentId: 'judgment-fact-1'}])
})

test('project judgment fact batch rebuild repairs shared facts for scoped articles', () => {
  const result = runScript<{
    factRows: Array<{judgmentId: string; projectId: string}>
    promptAnswerRows: Array<{answerValue: string; judgmentId: string; projectId: string}>
  }>(`
    await database.run(
      "INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images) VALUES ('large-rebuild-shared-source', 'Large Rebuild Shared Source', 'large-rebuild-executor-model', TRUE, TRUE, FALSE, FALSE), ('large-rebuild-shared-target', 'Large Rebuild Shared Target', 'large-rebuild-executor-model', TRUE, TRUE, FALSE, FALSE)"
    )
    await database.run(
      "INSERT INTO app.prompt (id, original_text, content_hash) VALUES ('large-rebuild-shared-prompt', 'Large rebuild shared prompt', 'large-rebuild-shared-prompt-hash')"
    )
    await database.run(
      "INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled) VALUES ('large-rebuild-shared-source-prompt', 'large-rebuild-shared-source', 'large-rebuild-shared-prompt', 1, TRUE), ('large-rebuild-shared-target-prompt', 'large-rebuild-shared-target', 'large-rebuild-shared-prompt', 1, TRUE)"
    )
    await database.run(
      "INSERT INTO app.judgment (id, article_id, prompt_id, model_id, project_id, snapshot_project_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images, is_answered, answered_original, answered_original_as_array, confidence_original) VALUES ('large-rebuild-shared-source-judgment', 'article-1', 'large-rebuild-shared-prompt', 'large-rebuild-executor-model', 'large-rebuild-shared-source', 'large-rebuild-shared-source', TRUE, TRUE, FALSE, FALSE, TRUE, 'yes', ['yes'], 90)"
    )
    await database.run(
      "INSERT INTO mart.project_scope_article (project_id, article_id, in_curated_scope, in_route_scope, article_created_at, article_updated_at) VALUES ('large-rebuild-shared-target', 'article-1', TRUE, FALSE, TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T01:00:00.000Z')"
    )

    await executor.resetProjectJudgmentFact('large-rebuild-shared-target')
    await executor.rebuildProjectJudgmentFactBatch('large-rebuild-shared-target', ['article-1'])
    await executor.resetProjectPromptAnswerFact('large-rebuild-shared-target')
    await executor.rebuildProjectPromptAnswerFactBatch('large-rebuild-shared-target', ['article-1'])

    const factRows = await database.queryJson(\`
      SELECT judgment_id AS judgmentId, project_id AS projectId
      FROM mart.judgment_fact
      WHERE judgment_id = 'large-rebuild-shared-source-judgment'
      ORDER BY judgment_id ASC
    \`)
    const promptAnswerRows = await database.queryJson(\`
      SELECT answer_value AS answerValue, judgment_id AS judgmentId, project_id AS projectId
      FROM mart.prompt_answer_fact
      WHERE project_id = 'large-rebuild-shared-target'
      ORDER BY judgment_id ASC
    \`)

    console.log(JSON.stringify({factRows, promptAnswerRows}))
    await database.close()
  `)

  expect(result.factRows).toEqual([
    {judgmentId: 'large-rebuild-shared-source-judgment', projectId: 'large-rebuild-shared-source'},
  ])
  expect(result.promptAnswerRows).toEqual([
    {answerValue: 'yes', judgmentId: 'large-rebuild-shared-source-judgment', projectId: 'large-rebuild-shared-target'},
  ])
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
    await executor.rebuildProjectPromptAnswerFactBatch('large-rebuild-executor-project', ['article-1'])

    const batchRows = await database.queryJson(\`
      SELECT article_id AS articleId, prompt_id AS promptId, answer_value AS answerValue
      FROM mart.prompt_answer_fact
      WHERE project_id = 'large-rebuild-executor-project'
      ORDER BY article_id ASC, answer_value ASC
    \`)

    await executor.rebuildProjectPromptAnswerFactBatch('large-rebuild-executor-project', ['article-2'])
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

test('large rebuild and incremental refresh agree on shared clone judgment reuse eligibility', () => {
  const result = runScript<{
    rows: Array<{
      detailCount: number
      llmJudgedPromptCount: number
      promptAnswerCount: number
      projectId: string
      reusedJudgmentCount: number
    }>
  }>(`
    const {getDuckdbMartRefreshService} = await import('./src/server/services/getDuckdbMartRefreshService.ts')

    await database.run(\`
      INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
      VALUES
        ('shared-reuse-source-project', 'Shared Reuse Source Project', 'large-rebuild-executor-model', TRUE, TRUE, FALSE, FALSE),
        ('shared-reuse-incremental-project', 'Shared Reuse Incremental Project', 'large-rebuild-executor-model', TRUE, TRUE, FALSE, FALSE),
        ('shared-changed-incremental-project', 'Shared Changed Incremental Project', 'large-rebuild-executor-model', TRUE, TRUE, TRUE, FALSE),
        ('shared-reuse-large-project', 'Shared Reuse Large Project', 'large-rebuild-executor-model', TRUE, TRUE, FALSE, FALSE),
        ('shared-changed-large-project', 'Shared Changed Large Project', 'large-rebuild-executor-model', TRUE, TRUE, TRUE, FALSE)
    \`)
    await database.run(\`
      INSERT INTO app.prompt (id, original_text, content_hash)
      VALUES ('shared-reuse-prompt', 'Shared reuse prompt', 'shared-reuse-prompt-hash')
    \`)
    await database.run(\`
      INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
      VALUES
        ('shared-reuse-source-prompt', 'shared-reuse-source-project', 'shared-reuse-prompt', 1, TRUE),
        ('shared-reuse-incremental-prompt', 'shared-reuse-incremental-project', 'shared-reuse-prompt', 1, TRUE),
        ('shared-changed-incremental-prompt', 'shared-changed-incremental-project', 'shared-reuse-prompt', 1, TRUE),
        ('shared-reuse-large-prompt', 'shared-reuse-large-project', 'shared-reuse-prompt', 1, TRUE),
        ('shared-changed-large-prompt', 'shared-changed-large-project', 'shared-reuse-prompt', 1, TRUE)
    \`)
    await database.run(\`
      INSERT INTO app.article (id, article_title, article_created_at, article_updated_at, article_id)
      VALUES (
        'shared-reuse-article',
        'Shared Reuse Article',
        TIMESTAMPTZ '2026-04-04T00:00:00.000Z',
        TIMESTAMPTZ '2026-04-04T01:00:00.000Z',
        'shared-reuse-external'
      )
    \`)
    await database.run(\`
      INSERT INTO app.project_article (id, project_id, article_id)
      VALUES
        ('shared-reuse-source-article', 'shared-reuse-source-project', 'shared-reuse-article'),
        ('shared-reuse-incremental-article', 'shared-reuse-incremental-project', 'shared-reuse-article'),
        ('shared-changed-incremental-article', 'shared-changed-incremental-project', 'shared-reuse-article'),
        ('shared-reuse-large-article', 'shared-reuse-large-project', 'shared-reuse-article'),
        ('shared-changed-large-article', 'shared-changed-large-project', 'shared-reuse-article')
    \`)
    await database.run(\`
      INSERT INTO app.judgment (
        id,
        article_id,
        prompt_id,
        model_id,
        project_id,
        snapshot_project_id,
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
        'shared-reuse-source-judgment',
        'shared-reuse-article',
        'shared-reuse-prompt',
        'large-rebuild-executor-model',
        'shared-reuse-source-project',
        'shared-reuse-source-project',
        TRUE,
        TRUE,
        FALSE,
        FALSE,
        TRUE,
        'yes',
        ['yes'],
        90
      )
    \`)

    const martRefreshService = getDuckdbMartRefreshService()
    await martRefreshService.queueJudgmentArticleRefresh('shared-reuse-article', 'shared-reuse-source-judgment')
    await martRefreshService.flush()
    await martRefreshService.queueProjectRefresh('shared-reuse-incremental-project', 'shared-reuse-incremental')
    await martRefreshService.queueProjectRefresh('shared-changed-incremental-project', 'shared-changed-incremental')
    await martRefreshService.flush()

    await database.run(\`
      DELETE FROM mart.project_scope_article
      WHERE project_id IN ('shared-reuse-large-project', 'shared-changed-large-project');
      INSERT INTO mart.project_scope_article (
        project_id,
        article_id,
        in_curated_scope,
        in_route_scope,
        article_created_at,
        article_updated_at
      ) VALUES
        ('shared-reuse-large-project', 'shared-reuse-article', TRUE, FALSE, TIMESTAMPTZ '2026-04-04T00:00:00.000Z', TIMESTAMPTZ '2026-04-04T01:00:00.000Z'),
        ('shared-changed-large-project', 'shared-reuse-article', TRUE, FALSE, TIMESTAMPTZ '2026-04-04T00:00:00.000Z', TIMESTAMPTZ '2026-04-04T01:00:00.000Z')
    \`)

    const rebuildLargeProject = async (projectId) => {
      const targetGeneration = 1

      await executor.resetProjectPromptAnswerFact(projectId)
      await executor.rebuildProjectPromptAnswerFactBatch(projectId, ['shared-reuse-article'])
      await executor.resetProjectReviewAnswerDictionary(projectId)
      await executor.rebuildProjectReviewAnswerDictionary(projectId)
      await executor.setupProjectReviewServingStaging(projectId, targetGeneration)
      await executor.rebuildProjectReviewArticleFilterMemberBatch(projectId, ['shared-reuse-article'], targetGeneration)
      await executor.resetProjectReviewArticleRollup(projectId)
      await executor.rebuildProjectReviewArticleRollupBatch(projectId, ['shared-reuse-article'])
      await executor.rebuildProjectReviewServingBatch(projectId, ['shared-reuse-article'], targetGeneration)
      await executor.finalizeProjectReviewServing(projectId, targetGeneration)
    }

    await rebuildLargeProject('shared-reuse-large-project')
    await rebuildLargeProject('shared-changed-large-project')

    const rows = await database.queryJson(\`
      SELECT
        project.id AS projectId,
        (SELECT COUNT(*) FROM mart.prompt_answer_fact fact WHERE fact.project_id = project.id) AS promptAnswerCount,
        (
          SELECT COUNT(*)
          FROM mart.prompt_answer_fact fact
          WHERE fact.project_id = project.id
            AND fact.judgment_id = 'shared-reuse-source-judgment'
        ) AS reusedJudgmentCount,
        (
          SELECT COALESCE(MAX(serving.llm_judged_prompt_count), 0)
          FROM mart.review_article_serving serving
          INNER JOIN app.project_review_serving_generation generation
            ON generation.project_id = serving.project_id
           AND generation.active_generation = serving.generation
          WHERE serving.project_id = project.id
            AND serving.article_id = 'shared-reuse-article'
        ) AS llmJudgedPromptCount,
        (
          SELECT COUNT(*)
          FROM mart.review_article_serving_detail detail
          INNER JOIN app.project_review_serving_generation generation
            ON generation.project_id = detail.project_id
           AND generation.active_generation = detail.generation
          WHERE detail.project_id = project.id
            AND detail.article_id = 'shared-reuse-article'
        ) AS detailCount
      FROM app.project project
      WHERE project.id IN (
        'shared-reuse-incremental-project',
        'shared-changed-incremental-project',
        'shared-reuse-large-project',
        'shared-changed-large-project'
      )
      ORDER BY project.id ASC
    \`)

    console.log(JSON.stringify({
      rows: rows.map((row) => ({
        detailCount: Number(row.detailCount ?? 0),
        llmJudgedPromptCount: Number(row.llmJudgedPromptCount ?? 0),
        promptAnswerCount: Number(row.promptAnswerCount ?? 0),
        projectId: row.projectId,
        reusedJudgmentCount: Number(row.reusedJudgmentCount ?? 0),
      })),
    }))
    await database.close()
  `)

  expect(result.rows).toEqual([
    {
      detailCount: 0,
      llmJudgedPromptCount: 0,
      projectId: 'shared-changed-incremental-project',
      promptAnswerCount: 0,
      reusedJudgmentCount: 0,
    },
    {
      detailCount: 0,
      llmJudgedPromptCount: 0,
      projectId: 'shared-changed-large-project',
      promptAnswerCount: 0,
      reusedJudgmentCount: 0,
    },
    {
      detailCount: 1,
      llmJudgedPromptCount: 1,
      projectId: 'shared-reuse-incremental-project',
      promptAnswerCount: 1,
      reusedJudgmentCount: 1,
    },
    {
      detailCount: 1,
      llmJudgedPromptCount: 1,
      projectId: 'shared-reuse-large-project',
      promptAnswerCount: 1,
      reusedJudgmentCount: 1,
    },
  ])
})

test('large rebuild drops reused source judgments after a cloned project repoints to a new prompt id', () => {
  const result = runScript<{
    afterEditSourceDetailRows: Array<{articleId: string; judgmentId: string; promptId: string}>
    afterEditTargetDetailRows: Array<{articleId: string; judgmentId: string; promptId: string}>
    afterEditTargetPromptAnswerRows: Array<{articleId: string; judgmentId: string; promptId: string}>
    afterRerunSourceDetailRows: Array<{articleId: string; judgmentId: string; promptId: string}>
    afterRerunTargetDetailRows: Array<{articleId: string; judgmentId: string; promptId: string}>
    afterRerunTargetPromptAnswerRows: Array<{articleId: string; judgmentId: string; promptId: string}>
    beforeEditSourceDetailRows: Array<{articleId: string; judgmentId: string; promptId: string}>
    beforeEditTargetDetailRows: Array<{articleId: string; judgmentId: string; promptId: string}>
    beforeEditTargetPromptAnswerRows: Array<{articleId: string; judgmentId: string; promptId: string}>
  }>(`
    const {getDuckdbMartRefreshService} = await import('./src/server/services/getDuckdbMartRefreshService.ts')

    const martRefreshService = getDuckdbMartRefreshService()
    const targetGenerationByProject = {}

    const getNextTargetGeneration = (projectId) => {
      const targetGeneration = (targetGenerationByProject[projectId] ?? 0) + 1
      targetGenerationByProject[projectId] = targetGeneration

      return targetGeneration
    }

    const rebuildLargeProject = async (projectId) => {
      const targetGeneration = getNextTargetGeneration(projectId)

      await executor.resetProjectPromptAnswerFact(projectId)
      await executor.rebuildProjectPromptAnswerFactBatch(projectId, ['prompt-edit-large-article'])
      await executor.resetProjectReviewAnswerDictionary(projectId)
      await executor.rebuildProjectReviewAnswerDictionary(projectId)
      await executor.setupProjectReviewServingStaging(projectId, targetGeneration)
      await executor.rebuildProjectReviewArticleFilterMemberBatch(projectId, ['prompt-edit-large-article'], targetGeneration)
      await executor.resetProjectReviewArticleRollup(projectId)
      await executor.rebuildProjectReviewArticleRollupBatch(projectId, ['prompt-edit-large-article'])
      await executor.rebuildProjectReviewServingBatch(projectId, ['prompt-edit-large-article'], targetGeneration)
      await executor.finalizeProjectReviewServing(projectId, targetGeneration)
    }

    const getActiveDetailRows = async (projectId) => {
      return database.queryJson(\`
        SELECT detail.article_id AS articleId, detail.judgment_id AS judgmentId, detail.prompt_id AS promptId
        FROM mart.review_article_serving_detail detail
        INNER JOIN app.project_review_serving_generation generation
          ON generation.project_id = detail.project_id
         AND generation.active_generation = detail.generation
        WHERE detail.project_id = '\${projectId}'
        ORDER BY detail.prompt_id ASC, detail.article_id ASC
      \`)
    }

    const getPromptAnswerRows = async (projectId) => {
      return database.queryJson(\`
        SELECT article_id AS articleId, judgment_id AS judgmentId, prompt_id AS promptId
        FROM mart.prompt_answer_fact
        WHERE project_id = '\${projectId}'
        ORDER BY prompt_id ASC, article_id ASC
      \`)
    }

    await database.run(\`
      INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
      VALUES
        ('prompt-edit-large-source-project', 'Prompt Edit Large Source Project', 'large-rebuild-executor-model', TRUE, TRUE, FALSE, FALSE),
        ('prompt-edit-large-target-project', 'Prompt Edit Large Target Project', 'large-rebuild-executor-model', TRUE, TRUE, FALSE, FALSE)
    \`)
    await database.run(\`
      INSERT INTO app.prompt (id, original_text, content_hash)
      VALUES
        ('prompt-edit-large-shared-prompt', 'Prompt edit shared body', 'prompt-edit-large-shared-hash'),
        ('prompt-edit-large-edited-prompt', 'Prompt edit edited body', 'prompt-edit-large-edited-hash')
    \`)
    await database.run(\`
      INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
      VALUES
        ('prompt-edit-large-source-project-prompt', 'prompt-edit-large-source-project', 'prompt-edit-large-shared-prompt', 1, TRUE),
        ('prompt-edit-large-target-project-prompt', 'prompt-edit-large-target-project', 'prompt-edit-large-shared-prompt', 1, TRUE)
    \`)
    await database.run(\`
      INSERT INTO app.article (id, article_title, article_created_at, article_updated_at, article_id)
      VALUES (
        'prompt-edit-large-article',
        'Prompt Edit Large Article',
        TIMESTAMPTZ '2026-04-04T00:00:00.000Z',
        TIMESTAMPTZ '2026-04-04T01:00:00.000Z',
        'prompt-edit-large-external'
      )
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
        ('prompt-edit-large-source-project', 'prompt-edit-large-article', TRUE, FALSE, TIMESTAMPTZ '2026-04-04T00:00:00.000Z', TIMESTAMPTZ '2026-04-04T01:00:00.000Z'),
        ('prompt-edit-large-target-project', 'prompt-edit-large-article', TRUE, FALSE, TIMESTAMPTZ '2026-04-04T00:00:00.000Z', TIMESTAMPTZ '2026-04-04T01:00:00.000Z')
    \`)
    await database.run(\`
      INSERT INTO app.judgment (
        id,
        article_id,
        prompt_id,
        model_id,
        project_id,
        snapshot_project_id,
        use_title,
        use_abstract,
        use_fulltext,
        use_fulltext_no_images,
        is_answered,
        answered_original,
        answered_original_as_array,
        confidence_original
      ) VALUES (
        'prompt-edit-large-source-judgment',
        'prompt-edit-large-article',
        'prompt-edit-large-shared-prompt',
        'large-rebuild-executor-model',
        'prompt-edit-large-source-project',
        'prompt-edit-large-source-project',
        TRUE,
        TRUE,
        FALSE,
        FALSE,
        TRUE,
        'yes',
        ['yes'],
        90
      )
    \`)

    await martRefreshService.queueJudgmentArticleRefresh('prompt-edit-large-article', 'prompt-edit-large-source-judgment')
    await martRefreshService.flush()

    await rebuildLargeProject('prompt-edit-large-source-project')
    await rebuildLargeProject('prompt-edit-large-target-project')

    const beforeEditSourceDetailRows = await getActiveDetailRows('prompt-edit-large-source-project')
    const beforeEditTargetDetailRows = await getActiveDetailRows('prompt-edit-large-target-project')
    const beforeEditTargetPromptAnswerRows = await getPromptAnswerRows('prompt-edit-large-target-project')

    await database.run(\`
      UPDATE app.project_prompt
      SET prompt_id = 'prompt-edit-large-edited-prompt'
      WHERE project_id = 'prompt-edit-large-target-project'
    \`)

    await rebuildLargeProject('prompt-edit-large-target-project')

    const afterEditSourceDetailRows = await getActiveDetailRows('prompt-edit-large-source-project')
    const afterEditTargetDetailRows = await getActiveDetailRows('prompt-edit-large-target-project')
    const afterEditTargetPromptAnswerRows = await getPromptAnswerRows('prompt-edit-large-target-project')

    await database.run(\`
      INSERT INTO app.judgment (
        id,
        article_id,
        prompt_id,
        model_id,
        project_id,
        snapshot_project_id,
        use_title,
        use_abstract,
        use_fulltext,
        use_fulltext_no_images,
        is_answered,
        answered_original,
        answered_original_as_array,
        confidence_original
      ) VALUES (
        'prompt-edit-large-target-judgment',
        'prompt-edit-large-article',
        'prompt-edit-large-edited-prompt',
        'large-rebuild-executor-model',
        'prompt-edit-large-target-project',
        'prompt-edit-large-target-project',
        TRUE,
        TRUE,
        FALSE,
        FALSE,
        TRUE,
        'no',
        ['no'],
        89
      )
    \`)

    await martRefreshService.queueJudgmentArticleRefresh('prompt-edit-large-article', 'prompt-edit-large-target-judgment')
    await martRefreshService.flush()

    await rebuildLargeProject('prompt-edit-large-target-project')

    const afterRerunSourceDetailRows = await getActiveDetailRows('prompt-edit-large-source-project')
    const afterRerunTargetDetailRows = await getActiveDetailRows('prompt-edit-large-target-project')
    const afterRerunTargetPromptAnswerRows = await getPromptAnswerRows('prompt-edit-large-target-project')

    console.log(JSON.stringify({
      afterEditSourceDetailRows,
      afterEditTargetDetailRows,
      afterEditTargetPromptAnswerRows,
      afterRerunSourceDetailRows,
      afterRerunTargetDetailRows,
      afterRerunTargetPromptAnswerRows,
      beforeEditSourceDetailRows,
      beforeEditTargetDetailRows,
      beforeEditTargetPromptAnswerRows,
    }))
    await database.close()
  `)

  expect(result.beforeEditSourceDetailRows).toEqual([
    {
      articleId: 'prompt-edit-large-article',
      judgmentId: 'prompt-edit-large-source-judgment',
      promptId: 'prompt-edit-large-shared-prompt',
    },
  ])
  expect(result.beforeEditTargetDetailRows).toEqual([
    {
      articleId: 'prompt-edit-large-article',
      judgmentId: 'prompt-edit-large-source-judgment',
      promptId: 'prompt-edit-large-shared-prompt',
    },
  ])
  expect(result.beforeEditTargetPromptAnswerRows).toEqual([
    {
      articleId: 'prompt-edit-large-article',
      judgmentId: 'prompt-edit-large-source-judgment',
      promptId: 'prompt-edit-large-shared-prompt',
    },
  ])
  expect(result.afterEditSourceDetailRows).toEqual([
    {
      articleId: 'prompt-edit-large-article',
      judgmentId: 'prompt-edit-large-source-judgment',
      promptId: 'prompt-edit-large-shared-prompt',
    },
  ])
  expect(result.afterEditTargetDetailRows).toEqual([])
  expect(result.afterEditTargetPromptAnswerRows).toEqual([])
  expect(result.afterRerunSourceDetailRows).toEqual([
    {
      articleId: 'prompt-edit-large-article',
      judgmentId: 'prompt-edit-large-source-judgment',
      promptId: 'prompt-edit-large-shared-prompt',
    },
  ])
  expect(result.afterRerunTargetDetailRows).toEqual([
    {
      articleId: 'prompt-edit-large-article',
      judgmentId: 'prompt-edit-large-target-judgment',
      promptId: 'prompt-edit-large-edited-prompt',
    },
  ])
  expect(result.afterRerunTargetPromptAnswerRows).toEqual([
    {
      articleId: 'prompt-edit-large-article',
      judgmentId: 'prompt-edit-large-target-judgment',
      promptId: 'prompt-edit-large-edited-prompt',
    },
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

test('filter member rollup and serving staging rebuild replay safely on bounded article sets', () => {
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

    await database.run(\`
      INSERT INTO app.project_review_serving_generation (project_id, active_generation)
      VALUES ('large-rebuild-executor-project', 5)
    \`)
    const targetGeneration = 9

    await executor.resetProjectReviewAnswerDictionary('large-rebuild-executor-project')
    await executor.rebuildProjectReviewAnswerDictionary('large-rebuild-executor-project')
    await executor.setupProjectReviewServingStaging('large-rebuild-executor-project', targetGeneration)
    await executor.rebuildProjectReviewArticleFilterMemberBatch('large-rebuild-executor-project', ['article-1', 'article-2'], targetGeneration)
    await executor.rebuildProjectReviewArticleFilterMemberBatch('large-rebuild-executor-project', ['article-1', 'article-2'], targetGeneration)
    await executor.resetProjectReviewArticleRollup('large-rebuild-executor-project')
    await executor.rebuildProjectReviewArticleRollupBatch('large-rebuild-executor-project', ['article-1', 'article-2'])
    await executor.rebuildProjectReviewArticleRollupBatch('large-rebuild-executor-project', ['article-1', 'article-2'])
    await executor.rebuildProjectReviewServingBatch('large-rebuild-executor-project', ['article-1', 'article-2'], targetGeneration)
    await executor.rebuildProjectReviewServingBatch('large-rebuild-executor-project', ['article-1', 'article-2'], targetGeneration)
    await executor.finalizeProjectReviewServing('large-rebuild-executor-project', targetGeneration)

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
    {promptId: 'prompt-1', answerId: 2, articleId: 'article-1', generation: '9'},
    {promptId: 'prompt-1', answerId: 1, articleId: 'article-2', generation: '9'},
  ])
  expect(result.rollupRows).toEqual([
    {articleId: 'article-1', enabledPromptCount: 1, hasAllLlmJudgments: true},
    {articleId: 'article-2', enabledPromptCount: 1, hasAllLlmJudgments: true},
  ])
  expect(result.servingGeneration).toEqual([{activeGeneration: '9'}])
  expect(result.servingRows).toEqual([
    {articleId: 'article-1', generation: '9'},
    {articleId: 'article-2', generation: '9'},
  ])
})

test('review serving finalize deletes stale generations without over-promoting', () => {
  const result = runScript<{
    activeGeneration: Array<{activeGeneration: string}>
    generationRows: Array<{generation: string; rowCount: string; tableName: string}>
    otherGenerationRows: Array<{generation: string; rowCount: string; tableName: string}>
  }>(`
    await database.run("INSERT INTO app.project_review_serving_generation (project_id, active_generation) VALUES ('large-rebuild-executor-project', 2)")
    await database.run("INSERT INTO app.project_review_serving_generation (project_id, active_generation) VALUES ('other-project', 3)")
    await database.run("INSERT INTO mart.review_article_serving (project_id, generation, article_id, article_created_at, article_updated_at, article_title, has_all_llm_judgments, llm_judged_prompt_count, enabled_prompt_count, human_answered_prompt_count, has_all_human_answers, review_opened, review_sections_completed) VALUES ('large-rebuild-executor-project', 1, 'article-1', TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T01:00:00.000Z', 'Article 1', TRUE, 1, 1, 0, FALSE, FALSE, 0), ('large-rebuild-executor-project', 2, 'article-1', TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T01:00:00.000Z', 'Article 1', TRUE, 1, 1, 0, FALSE, FALSE, 0), ('large-rebuild-executor-project', 3, 'article-1', TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T01:00:00.000Z', 'Article 1', TRUE, 1, 1, 0, FALSE, FALSE, 0)")
    await database.run("INSERT INTO mart.review_article_serving (project_id, generation, article_id, article_created_at, article_updated_at, article_title, has_all_llm_judgments, llm_judged_prompt_count, enabled_prompt_count, human_answered_prompt_count, has_all_human_answers, review_opened, review_sections_completed) VALUES ('other-project', 1, 'article-1', TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T01:00:00.000Z', 'Article 1', TRUE, 1, 1, 0, FALSE, FALSE, 0)")
    await database.run("INSERT INTO mart.review_article_filter_member (project_id, generation, prompt_id, answer_id, article_id) VALUES ('large-rebuild-executor-project', 1, 'prompt-1', 1, 'article-1'), ('large-rebuild-executor-project', 2, 'prompt-1', 1, 'article-1'), ('large-rebuild-executor-project', 3, 'prompt-1', 1, 'article-1')")
    await database.run("INSERT INTO mart.review_article_filter_member (project_id, generation, prompt_id, answer_id, article_id) VALUES ('other-project', 1, 'prompt-1', 1, 'article-1')")
    await database.run("INSERT INTO mart.review_article_serving_detail (project_id, generation, article_id, prompt_id, judgment_id, created_at, model_id) VALUES ('large-rebuild-executor-project', 1, 'article-1', 'prompt-1', 'judgment-old', TIMESTAMPTZ '2026-04-01T00:00:00.000Z', 'large-rebuild-executor-model'), ('large-rebuild-executor-project', 2, 'article-1', 'prompt-1', 'judgment-current', TIMESTAMPTZ '2026-04-01T00:00:00.000Z', 'large-rebuild-executor-model'), ('large-rebuild-executor-project', 3, 'article-1', 'prompt-1', 'judgment-next', TIMESTAMPTZ '2026-04-01T00:00:00.000Z', 'large-rebuild-executor-model')")
    await database.run("INSERT INTO mart.review_article_serving_detail (project_id, generation, article_id, prompt_id, judgment_id, created_at, model_id) VALUES ('other-project', 1, 'article-1', 'prompt-1', 'judgment-other', TIMESTAMPTZ '2026-04-01T00:00:00.000Z', 'large-rebuild-executor-model')")

    await executor.finalizeProjectReviewServing('large-rebuild-executor-project', 3)
    await executor.finalizeProjectReviewServing('large-rebuild-executor-project', 3)

    const activeGeneration = await database.queryJson("SELECT CAST(active_generation AS VARCHAR) AS activeGeneration FROM app.project_review_serving_generation WHERE project_id = 'large-rebuild-executor-project'")
    const generationRows = await database.queryJson("SELECT 'filter_member' AS tableName, CAST(generation AS VARCHAR) AS generation, CAST(COUNT(*) AS VARCHAR) AS rowCount FROM mart.review_article_filter_member WHERE project_id = 'large-rebuild-executor-project' GROUP BY generation UNION ALL SELECT 'serving' AS tableName, CAST(generation AS VARCHAR) AS generation, CAST(COUNT(*) AS VARCHAR) AS rowCount FROM mart.review_article_serving WHERE project_id = 'large-rebuild-executor-project' GROUP BY generation UNION ALL SELECT 'serving_detail' AS tableName, CAST(generation AS VARCHAR) AS generation, CAST(COUNT(*) AS VARCHAR) AS rowCount FROM mart.review_article_serving_detail WHERE project_id = 'large-rebuild-executor-project' GROUP BY generation ORDER BY tableName ASC, generation ASC")
    const otherGenerationRows = await database.queryJson("SELECT 'filter_member' AS tableName, CAST(generation AS VARCHAR) AS generation, CAST(COUNT(*) AS VARCHAR) AS rowCount FROM mart.review_article_filter_member WHERE project_id = 'other-project' GROUP BY generation UNION ALL SELECT 'serving' AS tableName, CAST(generation AS VARCHAR) AS generation, CAST(COUNT(*) AS VARCHAR) AS rowCount FROM mart.review_article_serving WHERE project_id = 'other-project' GROUP BY generation UNION ALL SELECT 'serving_detail' AS tableName, CAST(generation AS VARCHAR) AS generation, CAST(COUNT(*) AS VARCHAR) AS rowCount FROM mart.review_article_serving_detail WHERE project_id = 'other-project' GROUP BY generation ORDER BY tableName ASC, generation ASC")

    console.log(JSON.stringify({activeGeneration, generationRows, otherGenerationRows}))
    await database.close()
  `)

  expect(result.activeGeneration).toEqual([{activeGeneration: '3'}])
  expect(result.generationRows).toEqual([
    {generation: '2', rowCount: '1', tableName: 'filter_member'},
    {generation: '3', rowCount: '1', tableName: 'filter_member'},
    {generation: '2', rowCount: '1', tableName: 'serving'},
    {generation: '3', rowCount: '1', tableName: 'serving'},
    {generation: '2', rowCount: '1', tableName: 'serving_detail'},
    {generation: '3', rowCount: '1', tableName: 'serving_detail'},
  ])
  expect(result.otherGenerationRows).toEqual([
    {generation: '1', rowCount: '1', tableName: 'filter_member'},
    {generation: '1', rowCount: '1', tableName: 'serving'},
    {generation: '1', rowCount: '1', tableName: 'serving_detail'},
  ])
})
