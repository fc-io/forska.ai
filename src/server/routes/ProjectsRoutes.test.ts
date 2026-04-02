import {rmSync} from 'node:fs'

import {afterAll, beforeAll, expect, test} from 'bun:test'
import {Elysia} from 'elysia'

const tempDbPath = `/tmp/f1-projects-routes-${process.pid}-${Date.now()}.duckdb`

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempDbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

let app: {handle: (request: Request) => Promise<Response>} | null = null
let closeDatabase: (() => Promise<void>) | null = null
let flushMartRefreshes: (() => Promise<void>) | null = null
let queryDatabase: (<T>(statement: string) => Promise<T[]>) | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null

const getSqlLiteral = (value: string | null) => {
  return value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`
}

const insertProjectFixture = async ({
  archived = false,
  connectionId,
  modelId,
  projectId,
}: {
  archived?: boolean
  connectionId: string
  modelId: string
  projectId: string
}) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none')
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'Qwen/Qwen3.5-122B-A10B', 'Qwen/Qwen3.5-122B-A10B', 'Qwen 122B', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images, archived)
    VALUES ('${projectId}', 'Archive Regression Project', '${modelId}', TRUE, TRUE, FALSE, FALSE, ${archived ? 'TRUE' : 'FALSE'})
  `)
}

const insertProjectPromptFixture = async ({
  archived = false,
  contentHash,
  enabled = true,
  order = 0,
  originProjectId,
  originalText,
  projectId,
  projectPromptId,
  promptArchived = false,
  promptHeading = null,
  promptId,
  transformedText = null,
  type = null,
}: {
  archived?: boolean
  contentHash: string
  enabled?: boolean
  order?: number
  originProjectId: string | null
  originalText: string
  projectId: string
  projectPromptId: string
  promptArchived?: boolean
  promptHeading?: string | null
  promptId: string
  transformedText?: string | null
  type?: string | null
}) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, transformed_text, prompt_heading, type, content_hash, archived)
    VALUES (
      '${promptId}',
      ${getSqlLiteral(originalText)},
      ${getSqlLiteral(transformedText)},
      ${getSqlLiteral(promptHeading)},
      ${getSqlLiteral(type)},
      '${contentHash}',
      ${promptArchived ? 'TRUE' : 'FALSE'}
    )
  `)
  await runDatabase(`
    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, archived, enabled, origin_project_id)
    VALUES (
      '${projectPromptId}',
      '${projectId}',
      '${promptId}',
      ${order},
      ${archived ? 'TRUE' : 'FALSE'},
      ${enabled ? 'TRUE' : 'FALSE'},
      ${originProjectId === null ? 'NULL' : `'${originProjectId}'`}
    )
  `)
}

const rebuildMartRefreshQueueWithoutGeneration = async () => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  await runDatabase(`
    DROP TABLE app.mart_refresh_queue;
    CREATE TABLE app.mart_refresh_queue (
      id VARCHAR PRIMARY KEY,
      refresh_scope VARCHAR NOT NULL,
      project_id VARCHAR,
      article_id VARCHAR,
      project_key VARCHAR NOT NULL DEFAULT '',
      article_key VARCHAR NOT NULL DEFAULT '',
      reason VARCHAR,
      created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
      UNIQUE(refresh_scope, project_key, article_key)
    );
    CREATE INDEX IF NOT EXISTS idx_app_mart_refresh_queue_created_at ON app.mart_refresh_queue(created_at);
  `)
}

const insertReviewArticleServingFixtureRows = async ({
  generation,
  projectId,
  rowCount,
}: {
  generation: number
  projectId: string
  rowCount: number
}) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  const valuesSql = Array.from({length: rowCount}, (_unused, index) => {
    const articleNumber = String(index + 1).padStart(3, '0')
    return `(
      '${projectId}',
      ${generation},
      'archive-serving-article-${articleNumber}',
      TIMESTAMPTZ '2025-09-09 00:00:00+00',
      NULL,
      'Archive Serving Article ${articleNumber}',
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      FALSE,
      0,
      NULL,
      0,
      0,
      NULL,
      FALSE,
      FALSE,
      0,
      NULL,
      NULL,
      NULL,
      current_timestamp
    )`
  }).join(', ')

  await runDatabase(`
    INSERT INTO mart.review_article_serving (
      project_id,
      generation,
      article_id,
      article_created_at,
      article_updated_at,
      article_title,
      article_external_id,
      journal_title,
      url,
      full_text_pdf,
      full_text_fetched_at,
      full_text_conversion_status,
      source_metadata,
      has_all_llm_judgments,
      llm_judged_prompt_count,
      llm_judged_prompt_ids,
      enabled_prompt_count,
      human_answered_prompt_count,
      human_answered_prompt_ids,
      has_all_human_answers,
      review_opened,
      review_sections_completed,
      latest_llm_created_at,
      latest_human_updated_at,
      latest_review_updated_at,
      serving_updated_at
    ) VALUES ${valuesSql}
  `)
}

beforeAll(async () => {
  const [
    {migrateDuckdb},
    {getAppDatabaseService},
    {resetDuckdbServiceForTests},
    {resetServerRuntimeRoleForTests},
    {getDuckdbMartRefreshService},
    {projectsRoutes},
  ] = await Promise.all([
    import('../../db/migrateDuckdb.ts'),
    import('../services/appDatabaseService.ts'),
    import('../utils/duckdbService.ts'),
    import('../utils/serverRuntimeRole.ts'),
    import('../services/getDuckdbMartRefreshService.ts'),
    import('./ProjectsRoutes.ts'),
  ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()

  await migrateDuckdb()

  const database = getAppDatabaseService()

  closeDatabase = () => {
    return database.close()
  }
  flushMartRefreshes = () => {
    return getDuckdbMartRefreshService().flush()
  }
  queryDatabase = (statement: string) => {
    return database.queryJson(statement)
  }
  runDatabase = (statement: string) => {
    return database.run(statement)
  }
  app = new Elysia().use(projectsRoutes)
})

afterAll(async () => {
  await flushMartRefreshes?.()
  await closeDatabase?.()
  rmSync(tempDbPath, {force: true})
})

test('archive route marks the archived project dirty without depending on the legacy queue', async () => {
  if (!app || !queryDatabase || !runDatabase || !flushMartRefreshes) {
    throw new Error('Test app not initialized')
  }

  const projectId = 'archive-project-regression'

  await insertProjectFixture({
    connectionId: 'archive-connection-regression',
    modelId: 'archive-model-regression',
    projectId,
  })
  await rebuildMartRefreshQueueWithoutGeneration()

  const response = await app.handle(new Request(`http://localhost/api/projects/${projectId}`, {method: 'DELETE'}))

  expect(response.status).toBe(200)

  const [storedProject] = await queryDatabase<{archived: boolean}>(`
    SELECT archived
    FROM app.project
    WHERE id = '${projectId}'
    LIMIT 1
  `)
  const [refreshState] = await queryDatabase<{dirtyToken: number; projectId: string; reason: string | null}>(`
    SELECT
      project_id AS projectId,
      CAST(dirty_token AS INTEGER) AS dirtyToken,
      last_request_reason AS reason
    FROM app.project_mart_refresh_state
    WHERE project_id = '${projectId}'
    LIMIT 1
  `)

  expect(storedProject?.archived).toBe(true)
  expect(refreshState).toEqual({dirtyToken: 1, projectId, reason: 'ProjectsRoutes.archive'})

  await flushMartRefreshes()
})

test('archive route leaves downstream serving rows for refresh workers and records dirty state', async () => {
  if (!app || !queryDatabase || !runDatabase || !flushMartRefreshes) {
    throw new Error('Test app not initialized')
  }

  const projectId = 'archive-project-serving-purge'

  await insertProjectFixture({connectionId: 'archive-serving-connection', modelId: 'archive-serving-model', projectId})
  await insertReviewArticleServingFixtureRows({generation: 2, projectId, rowCount: 398})
  await runDatabase(`
    INSERT INTO app.project_review_serving_generation (project_id, active_generation)
    VALUES ('${projectId}', 1)
  `)

  const response = await app.handle(new Request(`http://localhost/api/projects/${projectId}`, {method: 'DELETE'}))

  expect(response.status).toBe(200)

  const [servingRowCount] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM mart.review_article_serving
    WHERE project_id = '${projectId}'
  `)
  const [generationRowCount] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.project_review_serving_generation
    WHERE project_id = '${projectId}'
  `)
  const [refreshState] = await queryDatabase<{dirtyToken: number; projectId: string; reason: string | null}>(`
    SELECT
      project_id AS projectId,
      CAST(dirty_token AS INTEGER) AS dirtyToken,
      last_request_reason AS reason
    FROM app.project_mart_refresh_state
    WHERE project_id = '${projectId}'
    LIMIT 1
  `)

  expect(Number(servingRowCount?.count ?? 0)).toBe(398)
  expect(Number(generationRowCount?.count ?? 0)).toBe(1)
  expect(refreshState).toEqual({dirtyToken: 1, projectId, reason: 'ProjectsRoutes.archive'})

  await flushMartRefreshes()
})

test('delete archived route rejects active projects', async () => {
  if (!app || !queryDatabase || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const projectId = 'delete-archived-active-project'

  await insertProjectFixture({
    connectionId: 'delete-archived-active-connection',
    modelId: 'delete-archived-active-model',
    projectId,
  })

  const response = await app.handle(
    new Request('http://localhost/api/projects/delete-archived', {
      body: JSON.stringify({projectIds: [projectId]}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const bodyText = await response.text()

  expect(response.status).toBe(500)
  expect(bodyText).toContain('Only archived projects can be deleted')

  const [projectRow] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.project
    WHERE id = '${projectId}'
  `)

  expect(Number(projectRow?.count ?? 0)).toBe(1)
})

test('delete archived route rejects projects with non-terminal judgment jobs', async () => {
  if (!app || !queryDatabase || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const projectId = 'delete-archived-running-job-project'

  await insertProjectFixture({
    archived: true,
    connectionId: 'delete-archived-running-job-connection',
    modelId: 'delete-archived-running-job-model',
    projectId,
  })
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('delete-archived-running-job', '${projectId}', 'running')
  `)

  const response = await app.handle(
    new Request('http://localhost/api/projects/delete-archived', {
      body: JSON.stringify({projectIds: [projectId]}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const bodyText = await response.text()

  expect(response.status).toBe(500)
  expect(bodyText).toContain('Archived project delete requires terminal judgment jobs')

  const [projectRow] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.project
    WHERE id = '${projectId}'
  `)

  expect(Number(projectRow?.count ?? 0)).toBe(1)
})

test('archived project cleanup FK inventory matches the live project FK graph', async () => {
  const [{getAppDatabaseService}, {assertArchivedProjectCleanupProjectForeignKeysTx}] = await Promise.all([
    import('../services/appDatabaseService.ts'),
    import('./projectsRoutes/projectsRoutesPostDeleteArchivedProjectForeignKeys.ts'),
  ])

  await getAppDatabaseService().transaction(async (tx) => {
    await assertArchivedProjectCleanupProjectForeignKeysTx(tx)
  })
})

test('archived project cleanup FK inventory rejects schema drift before delete runs', async () => {
  const [{assertArchivedProjectCleanupProjectForeignKeysTx, archivedProjectCleanupHandledProjectForeignKeys}] =
    await Promise.all([import('./projectsRoutes/projectsRoutesPostDeleteArchivedProjectForeignKeys.ts')])

  const tx = {
    queryJson: async <T>() => {
      return [
        ...archivedProjectCleanupHandledProjectForeignKeys,
        {columnName: 'project_id', schemaName: 'app', tableName: 'future_project_child'},
      ] as T[]
    },
  }

  const inventoryError = await assertArchivedProjectCleanupProjectForeignKeysTx(tx).catch((error) => {
    return error as Error
  })

  expect(inventoryError).toBeInstanceOf(Error)
  expect((inventoryError as Error).message).toContain('Archived project delete FK inventory drift')
})

test('delete archived route removes archived project rows and keeps cross-project references detached', async () => {
  if (!app || !queryDatabase || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const sourceProjectId = 'delete-archived-source-project'
  const survivorProjectId = 'delete-archived-survivor-project'
  const importRouteId = 'delete-archived-import-route'
  const articleId = 'delete-archived-article'
  const promptId = 'delete-archived-prompt'

  await insertProjectFixture({
    archived: true,
    connectionId: 'delete-archived-source-connection',
    modelId: 'delete-archived-source-model',
    projectId: sourceProjectId,
  })
  await insertProjectFixture({
    connectionId: 'delete-archived-survivor-connection',
    modelId: 'delete-archived-survivor-model',
    projectId: survivorProjectId,
  })
  await runDatabase(`
    INSERT INTO app.import_route (id, route, name)
    VALUES ('${importRouteId}', '/delete-archived-route', 'manual')
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('${articleId}', 'Delete archived article')
  `)
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('${promptId}', 'Delete archived prompt', 'delete-archived-prompt-hash')
  `)
  await runDatabase(`
    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, origin_project_id)
    VALUES
      ('delete-archived-project-prompt-owned', '${sourceProjectId}', '${promptId}', 0, '${sourceProjectId}'),
      ('delete-archived-project-prompt-survivor', '${survivorProjectId}', '${promptId}', 0, '${sourceProjectId}')
  `)
  await runDatabase(`
    INSERT INTO app.project_import_route (id, project_id, import_route_id)
    VALUES ('delete-archived-project-import-route', '${sourceProjectId}', '${importRouteId}')
  `)
  await runDatabase(`
    INSERT INTO app.project_article (id, project_id, article_id, imported_from_project_id)
    VALUES
      ('delete-archived-project-article-owned', '${sourceProjectId}', '${articleId}', NULL),
      ('delete-archived-project-article-survivor', '${survivorProjectId}', '${articleId}', '${sourceProjectId}')
  `)
  await runDatabase(`
    INSERT INTO app.review (id, project_id, article_id, opened)
    VALUES ('delete-archived-review', '${sourceProjectId}', '${articleId}', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('delete-archived-job', '${sourceProjectId}', 'completed')
  `)
  await runDatabase(`
    INSERT INTO app.token_use (
      id,
      judgment_job_id,
      requests,
      total_prompt_tokens,
      total_completion_tokens,
      total_tokens
    )
    VALUES ('delete-archived-token-use', 'delete-archived-job', 1, 2, 3, 5)
  `)
  await runDatabase(`
    INSERT INTO app.judgment (
      id,
      article_id,
      prompt_id,
      model_id,
      project_id,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images,
      delete_generation
    )
    VALUES (
      'delete-archived-judgment',
      '${articleId}',
      '${promptId}',
      'delete-archived-source-model',
      '${sourceProjectId}',
      TRUE,
      TRUE,
      FALSE,
      FALSE,
      0
    )
  `)
  await runDatabase(`
    INSERT INTO app.judgment_human (id, project_id, article_id, prompt_id, is_answered)
    VALUES ('delete-archived-judgment-human', '${sourceProjectId}', '${articleId}', '${promptId}', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.review_answer_dictionary (
      project_id,
      prompt_id,
      answer_id,
      answer_value,
      numeric_answer_value
    ) VALUES (
      '${sourceProjectId}',
      '${promptId}',
      1,
      'yes',
      1
    )
  `)
  await runDatabase(`
    INSERT INTO app.project_review_serving_generation (project_id, active_generation)
    VALUES ('${sourceProjectId}', 3)
  `)
  await runDatabase(`
    INSERT INTO app.project_mart_refresh_state (
      project_id,
      dirty_token,
      active_refresh_token,
      last_completed_refresh_token,
      refresh_status,
      last_request_reason
    ) VALUES (
      '${sourceProjectId}',
      7,
      0,
      5,
      'stale',
      'delete-archived-test'
    )
  `)
  await runDatabase(`
    INSERT INTO app.project_mart_refresh_article_state (
      project_id,
      article_id,
      first_dirty_token,
      last_dirty_token
    ) VALUES (
      '${sourceProjectId}',
      '${articleId}',
      6,
      7
    )
  `)
  await runDatabase(`
    INSERT INTO mart.project_scope_article (
      project_id,
      article_id,
      in_curated_scope,
      in_route_scope,
      article_created_at,
      article_updated_at
    ) VALUES (
      '${sourceProjectId}',
      '${articleId}',
      TRUE,
      TRUE,
      TIMESTAMPTZ '2025-09-09 00:00:00+00',
      NULL
    )
  `)
  await runDatabase(`
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
      '${sourceProjectId}',
      '${articleId}',
      '${promptId}',
      'delete-archived-judgment',
      'delete-archived-source-model',
      'yes',
      'yes',
      TIMESTAMPTZ '2025-09-09 00:00:00+00',
      NULL,
      current_timestamp
    )
  `)
  await runDatabase(`
    INSERT INTO mart.review_article_rollup (
      project_id,
      article_id,
      article_created_at,
      article_updated_at,
      enabled_prompt_count,
      llm_judged_prompt_count,
      human_answered_prompt_count,
      llm_judged_prompt_ids,
      human_answered_prompt_ids,
      has_all_llm_judgments,
      has_all_human_answers,
      in_curated_scope,
      in_route_scope,
      review_opened,
      review_sections_completed,
      latest_llm_created_at,
      latest_human_updated_at,
      latest_review_updated_at,
      rollup_updated_at
    ) VALUES (
      '${sourceProjectId}',
      '${articleId}',
      TIMESTAMPTZ '2025-09-09 00:00:00+00',
      NULL,
      1,
      1,
      1,
      ['${promptId}'],
      ['${promptId}'],
      TRUE,
      TRUE,
      TRUE,
      TRUE,
      TRUE,
      7,
      current_timestamp,
      current_timestamp,
      current_timestamp,
      current_timestamp
    )
  `)
  await runDatabase(`
    INSERT INTO mart.review_article_filter_row (
      project_id,
      article_id,
      prompt_id,
      answer_value,
      numeric_answer_value
    ) VALUES (
      '${sourceProjectId}',
      '${articleId}',
      '${promptId}',
      'yes',
      1
    )
  `)
  await runDatabase(`
    INSERT INTO mart.review_article_serving (
      project_id,
      generation,
      article_id,
      article_created_at,
      article_updated_at,
      article_title,
      article_external_id,
      journal_title,
      url,
      full_text_pdf,
      full_text_fetched_at,
      full_text_conversion_status,
      source_metadata,
      has_all_llm_judgments,
      llm_judged_prompt_count,
      llm_judged_prompt_ids,
      enabled_prompt_count,
      human_answered_prompt_count,
      human_answered_prompt_ids,
      has_all_human_answers,
      review_opened,
      review_sections_completed,
      latest_llm_created_at,
      latest_human_updated_at,
      latest_review_updated_at,
      serving_updated_at
    ) VALUES (
      '${sourceProjectId}',
      3,
      '${articleId}',
      TIMESTAMPTZ '2025-09-09 00:00:00+00',
      NULL,
      'Delete archived article',
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      TRUE,
      1,
      ['${promptId}'],
      1,
      1,
      ['${promptId}'],
      TRUE,
      TRUE,
      7,
      NULL,
      NULL,
      NULL,
      current_timestamp
    )
  `)
  await runDatabase(`
    INSERT INTO mart.review_article_filter_member (
      project_id,
      generation,
      prompt_id,
      answer_id,
      article_id,
      article_created_at,
      numeric_answer_value
    ) VALUES (
      '${sourceProjectId}',
      3,
      '${promptId}',
      1,
      '${articleId}',
      TIMESTAMPTZ '2025-09-09 00:00:00+00',
      1
    )
  `)
  await runDatabase(`
    INSERT INTO mart.review_article_serving_detail (
      project_id,
      generation,
      article_id,
      prompt_id,
      prompt_order,
      judgment_id,
      created_at,
      article_created_at,
      article_updated_at,
      model_id,
      answered_original,
      answered_original_as_array,
      detail_updated_at
    ) VALUES (
      '${sourceProjectId}',
      3,
      '${articleId}',
      '${promptId}',
      0,
      'delete-archived-judgment',
      current_timestamp,
      TIMESTAMPTZ '2025-09-09 00:00:00+00',
      NULL,
      'delete-archived-source-model',
      'yes',
      ['yes'],
      current_timestamp
    )
  `)

  const response = await app.handle(
    new Request('http://localhost/api/projects/delete-archived', {
      body: JSON.stringify({projectIds: [sourceProjectId]}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const bodyText = await response.text()

  if (response.status !== 200) {
    throw new Error(bodyText)
  }

  expect(response.status).toBe(200)
  const body = JSON.parse(bodyText) as {success: boolean}
  expect(body.success).toBe(true)

  const [projectRow] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.project
    WHERE id = '${sourceProjectId}'
  `)
  const [projectPromptRowCount] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.project_prompt
    WHERE project_id = '${sourceProjectId}'
  `)
  const [projectImportRouteRowCount] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.project_import_route
    WHERE project_id = '${sourceProjectId}'
  `)
  const [projectArticleRowCount] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.project_article
    WHERE project_id = '${sourceProjectId}'
  `)
  const [reviewRowCount] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.review
    WHERE project_id = '${sourceProjectId}'
  `)
  const [judgmentJobRowCount] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.judgment_job
    WHERE project_id = '${sourceProjectId}'
  `)
  const [tokenUseRowCount] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.token_use
    WHERE judgment_job_id = 'delete-archived-job'
  `)
  const [projectRefreshStateRowCount] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.project_mart_refresh_state
    WHERE project_id = '${sourceProjectId}'
  `)
  const [projectRefreshArticleStateRowCount] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.project_mart_refresh_article_state
    WHERE project_id = '${sourceProjectId}'
  `)
  const [reviewAnswerDictionaryRowCount] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.review_answer_dictionary
    WHERE project_id = '${sourceProjectId}'
  `)
  const [servingGenerationRowCount] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.project_review_serving_generation
    WHERE project_id = '${sourceProjectId}'
  `)
  const [projectScopeArticleRowCount] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM mart.project_scope_article
    WHERE project_id = '${sourceProjectId}'
  `)
  const [promptAnswerFactRowCount] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM mart.prompt_answer_fact
    WHERE project_id = '${sourceProjectId}'
  `)
  const [rollupRowCount] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM mart.review_article_rollup
    WHERE project_id = '${sourceProjectId}'
  `)
  const [filterRowRowCount] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM mart.review_article_filter_row
    WHERE project_id = '${sourceProjectId}'
  `)
  const [servingRowCount] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM mart.review_article_serving
    WHERE project_id = '${sourceProjectId}'
  `)
  const [filterMemberRowCount] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM mart.review_article_filter_member
    WHERE project_id = '${sourceProjectId}'
  `)
  const [servingDetailRowCount] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM mart.review_article_serving_detail
    WHERE project_id = '${sourceProjectId}'
  `)
  const [survivorPromptOrigin] = await queryDatabase<{originProjectId: string | null}>(`
    SELECT origin_project_id AS originProjectId
    FROM app.project_prompt
    WHERE id = 'delete-archived-project-prompt-survivor'
    LIMIT 1
  `)
  const [survivorArticleOrigin] = await queryDatabase<{importedFromProjectId: string | null}>(`
    SELECT imported_from_project_id AS importedFromProjectId
    FROM app.project_article
    WHERE id = 'delete-archived-project-article-survivor'
    LIMIT 1
  `)
  const [judgmentProjectId] = await queryDatabase<{projectId: string | null}>(`
    SELECT project_id AS projectId
    FROM app.judgment
    WHERE id = 'delete-archived-judgment'
    LIMIT 1
  `)
  const [judgmentHumanProjectId] = await queryDatabase<{projectId: string | null}>(`
    SELECT project_id AS projectId
    FROM app.judgment_human
    WHERE id = 'delete-archived-judgment-human'
    LIMIT 1
  `)

  expect(Number(projectRow?.count ?? 0)).toBe(0)
  expect(Number(projectPromptRowCount?.count ?? 0)).toBe(0)
  expect(Number(projectImportRouteRowCount?.count ?? 0)).toBe(0)
  expect(Number(projectArticleRowCount?.count ?? 0)).toBe(0)
  expect(Number(reviewRowCount?.count ?? 0)).toBe(0)
  expect(Number(judgmentJobRowCount?.count ?? 0)).toBe(0)
  expect(Number(tokenUseRowCount?.count ?? 0)).toBe(0)
  expect(Number(projectRefreshStateRowCount?.count ?? 0)).toBe(0)
  expect(Number(projectRefreshArticleStateRowCount?.count ?? 0)).toBe(0)
  expect(Number(reviewAnswerDictionaryRowCount?.count ?? 0)).toBe(0)
  expect(Number(servingGenerationRowCount?.count ?? 0)).toBe(0)
  expect(Number(projectScopeArticleRowCount?.count ?? 0)).toBe(0)
  expect(Number(promptAnswerFactRowCount?.count ?? 0)).toBe(0)
  expect(Number(rollupRowCount?.count ?? 0)).toBe(0)
  expect(Number(filterRowRowCount?.count ?? 0)).toBe(0)
  expect(Number(servingRowCount?.count ?? 0)).toBe(0)
  expect(Number(filterMemberRowCount?.count ?? 0)).toBe(0)
  expect(Number(servingDetailRowCount?.count ?? 0)).toBe(0)
  expect(survivorPromptOrigin?.originProjectId).toBe(null)
  expect(survivorArticleOrigin?.importedFromProjectId).toBe(null)
  expect(judgmentProjectId?.projectId).toBe(null)
  expect(judgmentHumanProjectId?.projectId).toBe(null)
})

test('edit route accepts full client payload when the model is unchanged', async () => {
  if (!app || !queryDatabase || !runDatabase || !flushMartRefreshes) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'edit-same-model-connection'
  const modelId = 'edit-same-model'
  const projectId = 'edit-same-model-project'

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('edit-same-model-article', 'Edit same model article')
  `)
  await runDatabase(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES ('edit-same-model-project-article', '${projectId}', 'edit-same-model-article')
  `)

  const response = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}/edit`, {
      body: JSON.stringify({
        name: 'Updated project name',
        description: null,
        prompts: [],
        dateFrom: null,
        dateTo: null,
        modelId,
        importRoutes: [],
        useTitle: true,
        useAbstract: true,
        useFulltext: false,
        useFulltextNoImages: false,
      }),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const body = (await response.json()) as {data: {project: {modelId: string; name: string}}}

  expect(response.status).toBe(200)
  expect(body.data.project.modelId).toBe(modelId)
  expect(body.data.project.name).toBe('Updated project name')

  const [storedProjectArticle] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.project_article
    WHERE project_id = '${projectId}'
  `)
  const [refreshState] = await queryDatabase<{dirtyToken: number; projectId: string}>(`
    SELECT project_id AS projectId, CAST(dirty_token AS INTEGER) AS dirtyToken
    FROM app.project_mart_refresh_state
    WHERE project_id = '${projectId}'
    LIMIT 1
  `)
  const [refreshArticleState] = await queryDatabase<{
    articleId: string
    firstDirtyToken: number
    lastDirtyToken: number
    projectId: string
  }>(`
    SELECT
      project_id AS projectId,
      article_id AS articleId,
      CAST(first_dirty_token AS INTEGER) AS firstDirtyToken,
      CAST(last_dirty_token AS INTEGER) AS lastDirtyToken
    FROM app.project_mart_refresh_article_state
    WHERE project_id = '${projectId}'
      AND article_id = 'edit-same-model-article'
    LIMIT 1
  `)

  expect(Number(storedProjectArticle?.count ?? 0)).toBe(1)
  expect(refreshState).toEqual({dirtyToken: 1, projectId})
  expect(refreshArticleState).toEqual({
    articleId: 'edit-same-model-article',
    firstDirtyToken: 1,
    lastDirtyToken: 1,
    projectId,
  })

  await flushMartRefreshes()
})

test('edit route can change the model for a populated project', async () => {
  if (!app || !queryDatabase || !runDatabase || !flushMartRefreshes) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'edit-switch-model-connection'
  const initialModelId = 'edit-switch-model-initial'
  const nextModelId = 'edit-switch-model-next'
  const projectId = 'edit-switch-model-project'

  await insertProjectFixture({connectionId, modelId: initialModelId, projectId})
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${nextModelId}', '${connectionId}', 'Qwen/Qwen3.5-32B', 'Qwen/Qwen3.5-32B', 'Qwen 32B', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('edit-switch-model-article', 'Edit switch model article')
  `)
  await runDatabase(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES ('edit-switch-model-project-article', '${projectId}', 'edit-switch-model-article')
  `)

  const response = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}/edit`, {
      body: JSON.stringify({
        name: 'Project with switched model',
        description: null,
        prompts: [],
        dateFrom: null,
        dateTo: null,
        modelId: nextModelId,
        importRoutes: [],
        useTitle: true,
        useAbstract: true,
        useFulltext: false,
        useFulltextNoImages: false,
      }),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const body = (await response.json()) as {data: {project: {modelId: string; name: string}}}

  expect(response.status).toBe(200)
  expect(body.data.project.modelId).toBe(nextModelId)
  expect(body.data.project.name).toBe('Project with switched model')

  const [storedProject] = await queryDatabase<{modelId: string}>(`
    SELECT model_id AS modelId
    FROM app.project
    WHERE id = '${projectId}'
    LIMIT 1
  `)
  const [storedProjectArticle] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.project_article
    WHERE project_id = '${projectId}'
  `)

  expect(storedProject?.modelId).toBe(nextModelId)
  expect(Number(storedProjectArticle?.count ?? 0)).toBe(1)

  await flushMartRefreshes()
})

test('clone route detaches prompt ids and hides duplicate importable prompts', async () => {
  if (!app || !queryDatabase || !runDatabase || !flushMartRefreshes) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'clone-detach-connection'
  const modelId = 'clone-detach-model'
  const projectId = 'clone-detach-project'

  await insertProjectFixture({connectionId, modelId, projectId})
  await insertProjectPromptFixture({
    contentHash: 'clone-detach-hash-ai',
    order: 0,
    originProjectId: projectId,
    originalText: 'Is this about AI?',
    projectId,
    projectPromptId: 'clone-detach-project-prompt-ai',
    promptHeading: 'ai',
    promptId: 'clone-detach-prompt-ai',
    type: 'string',
  })
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, prompt_heading, type, content_hash)
    VALUES ('clone-detach-prompt-unrelated', 'Unrelated prompt', 'other', 'string', 'clone-detach-hash-unrelated')
  `)

  const cloneResponse = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}/clone`, {method: 'POST'}),
  )
  const cloneBody = (await cloneResponse.json()) as {data: {id: string}}
  const clonedProjectId = cloneBody.data.id

  expect(cloneResponse.status).toBe(200)

  const sourcePromptRows = await queryDatabase<{
    contentHash: string | null
    originalText: string
    originProjectId: string | null
    promptHeading: string | null
    promptId: string
  }>(`
    SELECT
      p.id AS promptId,
      p.original_text AS originalText,
      p.prompt_heading AS promptHeading,
      p.content_hash AS contentHash,
      pp.origin_project_id AS originProjectId
    FROM app.project_prompt pp
    INNER JOIN app.prompt p ON p.id = pp.prompt_id
    WHERE pp.project_id = '${projectId}'
  `)
  const clonedPromptRows = await queryDatabase<{
    contentHash: string | null
    originalText: string
    originProjectId: string | null
    promptHeading: string | null
    promptId: string
  }>(`
    SELECT
      p.id AS promptId,
      p.original_text AS originalText,
      p.prompt_heading AS promptHeading,
      p.content_hash AS contentHash,
      pp.origin_project_id AS originProjectId
    FROM app.project_prompt pp
    INNER JOIN app.prompt p ON p.id = pp.prompt_id
    WHERE pp.project_id = '${clonedProjectId}'
  `)

  expect(sourcePromptRows.length).toBe(1)
  expect(clonedPromptRows.length).toBe(1)
  expect(clonedPromptRows[0]?.promptId).not.toBe(sourcePromptRows[0]?.promptId)
  expect(clonedPromptRows[0]?.originalText).toBe(sourcePromptRows[0]?.originalText)
  expect(clonedPromptRows[0]?.promptHeading).toBe(sourcePromptRows[0]?.promptHeading)
  expect(clonedPromptRows[0]?.contentHash).toBe(null)
  expect(clonedPromptRows[0]?.originProjectId).toBe(clonedProjectId)

  const detailsResponse = await app.handle(new Request(`http://localhost/api/projects/${clonedProjectId}`))
  const detailsBody = (await detailsResponse.json()) as {
    data: {prompts: Array<{id: string; originalText: string; originProjectId: string | null}>}
  }
  const matchingPrompts = detailsBody.data.prompts.filter((prompt) => {
    return prompt.originalText === 'Is this about AI?'
  })
  const unrelatedPrompts = detailsBody.data.prompts.filter((prompt) => {
    return prompt.originalText === 'Unrelated prompt'
  })

  expect(detailsResponse.status).toBe(200)
  expect(matchingPrompts.length).toBe(1)
  expect(matchingPrompts[0]?.originProjectId).toBe(clonedProjectId)
  expect(unrelatedPrompts.length).toBe(1)
  expect(unrelatedPrompts[0]?.originProjectId).toBe(null)

  await flushMartRefreshes()
})

test('editing a cloned project model leaves the source project model unchanged', async () => {
  if (!app || !queryDatabase || !runDatabase || !flushMartRefreshes) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'clone-edit-model-connection'
  const initialModelId = 'clone-edit-model-initial'
  const nextModelId = 'clone-edit-model-next'
  const projectId = 'clone-edit-model-project'

  await insertProjectFixture({connectionId, modelId: initialModelId, projectId})
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${nextModelId}', '${connectionId}', 'Qwen/Qwen3.5-32B', 'Qwen/Qwen3.5-32B', 'Qwen 32B', 'manual', TRUE)
  `)

  const cloneResponse = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}/clone`, {method: 'POST'}),
  )
  const cloneBody = (await cloneResponse.json()) as {data: {id: string}}
  const clonedProjectId = cloneBody.data.id

  expect(cloneResponse.status).toBe(200)

  const editResponse = await app.handle(
    new Request(`http://localhost/api/projects/${clonedProjectId}/edit`, {
      body: JSON.stringify({
        name: 'Detached clone with new model',
        description: null,
        prompts: [],
        dateFrom: null,
        dateTo: null,
        modelId: nextModelId,
        importRoutes: [],
        useTitle: true,
        useAbstract: true,
        useFulltext: false,
        useFulltextNoImages: false,
      }),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )

  expect(editResponse.status).toBe(200)

  const storedProjects = await queryDatabase<{id: string; modelId: string}>(`
    SELECT id, model_id AS modelId
    FROM app.project
    WHERE id IN ('${projectId}', '${clonedProjectId}')
    ORDER BY id
  `)
  const sourceProject = storedProjects.find((project) => {
    return project.id === projectId
  })
  const clonedProject = storedProjects.find((project) => {
    return project.id === clonedProjectId
  })

  expect(sourceProject?.modelId).toBe(initialModelId)
  expect(clonedProject?.modelId).toBe(nextModelId)

  await flushMartRefreshes()
})

test('create route detaches owned prompts from existing global prompt ids', async () => {
  if (!app || !queryDatabase || !runDatabase || !flushMartRefreshes) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'create-detach-connection'
  const modelId = 'create-detach-model'

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none')
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'Qwen/Qwen3.5-122B-A10B', 'Qwen/Qwen3.5-122B-A10B', 'Qwen 122B', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, prompt_heading, type, content_hash)
    VALUES ('create-detach-existing-prompt', 'Shared prompt text', 'shared', 'string', 'create-detach-shared-hash')
  `)

  const response = await app.handle(
    new Request('http://localhost/api/projects', {
      body: JSON.stringify({name: 'Detached create project', modelId, prompts: ['Shared prompt text']}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const body = (await response.json()) as {data: {id: string}}
  const projectId = body.data.id

  expect(response.status).toBe(200)

  const [promptRow] = await queryDatabase<{
    contentHash: string | null
    originProjectId: string | null
    promptId: string
  }>(`
    SELECT p.id AS promptId, p.content_hash AS contentHash, pp.origin_project_id AS originProjectId
    FROM app.project_prompt pp
    INNER JOIN app.prompt p ON p.id = pp.prompt_id
    WHERE pp.project_id = '${projectId}'
    LIMIT 1
  `)

  expect(promptRow?.promptId).not.toBe('create-detach-existing-prompt')
  expect(promptRow?.contentHash).toBe(null)
  expect(promptRow?.originProjectId).toBe(projectId)

  await flushMartRefreshes()
})

test('edit route detaches changed owned prompts from matching global prompt ids', async () => {
  if (!app || !queryDatabase || !runDatabase || !flushMartRefreshes) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'edit-detach-connection'
  const modelId = 'edit-detach-model'
  const projectId = 'edit-detach-project'

  await insertProjectFixture({connectionId, modelId, projectId})
  await insertProjectPromptFixture({
    contentHash: 'edit-detach-original-hash',
    originProjectId: projectId,
    originalText: 'Original owned prompt',
    projectId,
    projectPromptId: 'edit-detach-project-prompt',
    promptId: 'edit-detach-owned-prompt',
  })
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, prompt_heading, type, content_hash)
    VALUES ('edit-detach-existing-prompt', 'Shared prompt text', 'shared', 'string', 'edit-detach-shared-hash')
  `)

  const response = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}/edit`, {
      body: JSON.stringify({
        name: 'Edited detached project',
        description: null,
        prompts: [
          {
            originalId: 'edit-detach-owned-prompt',
            originalText: 'Shared prompt text',
            promptHeading: 'shared',
            type: 'string',
            order: 0,
            enabled: true,
          },
        ],
        dateFrom: null,
        dateTo: null,
        modelId,
        importRoutes: [],
        useTitle: true,
        useAbstract: true,
        useFulltext: false,
        useFulltextNoImages: false,
      }),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )

  expect(response.status).toBe(200)

  const [promptRow] = await queryDatabase<{
    contentHash: string | null
    originProjectId: string | null
    promptId: string
  }>(`
    SELECT p.id AS promptId, p.content_hash AS contentHash, pp.origin_project_id AS originProjectId
    FROM app.project_prompt pp
    INNER JOIN app.prompt p ON p.id = pp.prompt_id
    WHERE pp.project_id = '${projectId}'
    LIMIT 1
  `)

  expect(promptRow?.promptId).not.toBe('edit-detach-owned-prompt')
  expect(promptRow?.promptId).not.toBe('edit-detach-existing-prompt')
  expect(promptRow?.contentHash).toBe(null)
  expect(promptRow?.originProjectId).toBe(projectId)

  await flushMartRefreshes()
})
