import {afterAll, beforeAll, expect, test} from 'bun:test'
import {Elysia} from 'elysia'

import {getCurrentReviewConfigHash} from '../services/reviewServingProjectConfigIdentity.ts'
import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'
import {computePromptContentHash} from '../utils/computePromptContentHash.ts'

const tempRuntimeRoot = createTempRuntimeRoot('f1-projects-routes')
const tempDbPath = tempRuntimeRoot.duckdbPath

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempDbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

let app: {handle: (request: Request) => Promise<Response>} | null = null
let closeDatabase: (() => Promise<void>) | null = null
let flushMartRefreshes: (() => Promise<void>) | null = null
let cleanupArchivedProjectMartDataBatch: ((projectId: string) => Promise<{deletedRowCount: number}>) | null = null
let markArticleProjectsDirty: ((articleId: string, reason: string) => Promise<void>) | null = null
let refreshProject: ((projectId: string) => Promise<void>) | null = null
let queryDatabase: (<T>(statement: string) => Promise<T[]>) | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null

const getSqlLiteral = (value: string | null) => {
  return value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`
}

const insertProjectFixture = async ({
  archived = false,
  connectionId,
  humanJudgmentMode = 'prompt',
  modelId,
  projectId,
}: {
  archived?: boolean
  connectionId: string
  humanJudgmentMode?: 'prompt' | 'summary'
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
    INSERT INTO app.project (
      id,
      name,
      model_id,
      human_judgment_mode,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images,
      archived
    )
    VALUES (
      '${projectId}',
      'Archive Regression Project',
      '${modelId}',
      '${humanJudgmentMode}',
      TRUE,
      TRUE,
      FALSE,
      FALSE,
      ${archived ? 'TRUE' : 'FALSE'}
    )
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
  criteriaDisposition = null,
  criteriaSectionKey = null,
  criteriaSectionLabel = null,
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
  criteriaDisposition?: 'include' | 'exclude' | 'combined' | null
  criteriaSectionKey?: string | null
  criteriaSectionLabel?: string | null
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
    INSERT INTO app.project_prompt (
      id,
      project_id,
      prompt_id,
      prompt_order,
      archived,
      enabled,
      origin_project_id,
      criteria_disposition,
      criteria_section_key,
      criteria_section_label
    )
    VALUES (
      '${projectPromptId}',
      '${projectId}',
      '${promptId}',
      ${order},
      ${archived ? 'TRUE' : 'FALSE'},
      ${enabled ? 'TRUE' : 'FALSE'},
      ${originProjectId === null ? 'NULL' : `'${originProjectId}'`},
      ${getSqlLiteral(criteriaDisposition)},
      ${getSqlLiteral(criteriaSectionKey)},
      ${getSqlLiteral(criteriaSectionLabel)}
    )
  `)
}

const insertProjectArticleFixture = async ({
  articleId,
  articleSeq,
  projectArticleId,
  projectId,
  summary = null,
  title,
}: {
  articleId: string
  articleSeq: number
  projectArticleId: string
  projectId: string
  summary?: string | null
  title: string
}) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  await runDatabase(`
    INSERT INTO app.article (id, article_title, article_summary)
    VALUES ('${articleId}', ${getSqlLiteral(title)}, ${getSqlLiteral(summary)})
  `)
  await runDatabase(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES ('${projectArticleId}', '${projectId}', '${articleId}')
  `)
  await runDatabase(`
    INSERT INTO app.project_article_ordinal (project_id, article_id, article_seq)
    VALUES ('${projectId}', '${articleId}', ${articleSeq})
  `)
}

const insertJudgmentJobSqliteHealthProjectionFixture = async ({
  claimedOutboxCount = 0,
  jobId,
  orphanedJudgedRowCount = 0,
  outboxRowCount = 0,
  pendingCompletionAckCount = 0,
  promptClaimedCount = 0,
  promptReadyCount = 0,
  promptRunningCount = 0,
}: {
  claimedOutboxCount?: number
  jobId: string
  orphanedJudgedRowCount?: number
  outboxRowCount?: number
  pendingCompletionAckCount?: number
  promptClaimedCount?: number
  promptReadyCount?: number
  promptRunningCount?: number
}) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  const retainedRowCount = promptReadyCount + promptClaimedCount + promptRunningCount

  await runDatabase(`
    INSERT INTO app.judgment_job_sqlite_health_projection (
      job_id,
      projection_source,
      projected_at,
      fresh_until_at,
      has_outbox_rows,
      has_queue_rows,
      outbox_row_count,
      claimed_outbox_count,
      orphaned_judged_row_count,
      retained_row_count,
      pending_completion_ack_count,
      has_pending_completion_ack,
      prompt_ready_count,
      prompt_claimed_count,
      prompt_running_count
    ) VALUES (
      '${jobId}',
      'test',
      current_timestamp,
      TIMESTAMPTZ '2999-01-01T00:00:00.000Z',
      ${outboxRowCount > 0 ? 'TRUE' : 'FALSE'},
      ${retainedRowCount > 0 ? 'TRUE' : 'FALSE'},
      ${outboxRowCount},
      ${claimedOutboxCount},
      ${orphanedJudgedRowCount},
      ${retainedRowCount},
      ${pendingCompletionAckCount},
      ${pendingCompletionAckCount > 0 ? 'TRUE' : 'FALSE'},
      ${promptReadyCount},
      ${promptClaimedCount},
      ${promptRunningCount}
    )
  `)
}

type CloneRerunProjectConfig = {
  modelId: string
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}

type CloneRerunScenario = {key: string; nextConfig: CloneRerunProjectConfig}

type ProjectReviewJudgmentSummary = {answeredOriginal: string | null; id: string; promptId: string}

const baseCloneRerunConfig = (modelId: string): CloneRerunProjectConfig => {
  return {modelId, useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true}
}

const insertCloneRerunJudgmentFixture = async ({
  answer,
  articleId,
  config,
  createdAt,
  judgmentId,
  projectId,
  promptId,
}: {
  answer: 'no' | 'yes'
  articleId: string
  config: CloneRerunProjectConfig
  createdAt: string
  judgmentId: string
  projectId: string
  promptId: string
}) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  await runDatabase(`
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
      confidence_original,
      created_at
    )
    VALUES (
      '${judgmentId}',
      '${articleId}',
      '${promptId}',
      '${config.modelId}',
      '${projectId}',
      '${projectId}',
      ${config.useTitle ? 'TRUE' : 'FALSE'},
      ${config.useAbstract ? 'TRUE' : 'FALSE'},
      ${config.useFulltext ? 'TRUE' : 'FALSE'},
      ${config.useFulltextNoImages ? 'TRUE' : 'FALSE'},
      TRUE,
      '${answer}',
      ['${answer}'],
      90,
      TIMESTAMPTZ '${createdAt}'
    )
  `)
}

const getProjectReviewDetails = async (params: {articleId: string; projectId: string}) => {
  if (!app) {
    throw new Error('Test app not initialized')
  }

  const response = await app.handle(
    new Request('http://localhost/api/projectsreview', {
      body: JSON.stringify(params),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const body = (await response.json()) as {
    allJudgments: ProjectReviewJudgmentSummary[]
    judgments: ProjectReviewJudgmentSummary[]
    prompts: Array<{id: string; originalText: string}>
  }

  expect(response.status).toBe(200)

  return body
}

const getJudgmentSummaries = (judgments: ProjectReviewJudgmentSummary[]) => {
  return judgments.map((judgment) => {
    return {answeredOriginal: judgment.answeredOriginal, id: judgment.id, promptId: judgment.promptId}
  })
}

const assertSourceCloneRerunState = async ({
  articleId,
  promptId,
  sourceJudgmentId,
  sourceProjectId,
}: {
  articleId: string
  promptId: string
  sourceJudgmentId: string
  sourceProjectId: string
}) => {
  if (!queryDatabase) {
    throw new Error('Database not initialized')
  }

  const sourcePromptRows = await queryDatabase<{promptId: string}>(`
    SELECT prompt_id AS promptId
    FROM app.project_prompt
    WHERE project_id = '${sourceProjectId}'
    ORDER BY prompt_order ASC
  `)
  const sourceDetails = await getProjectReviewDetails({articleId, projectId: sourceProjectId})

  expect(sourcePromptRows).toEqual([{promptId}])
  expect(
    sourceDetails.prompts.map((prompt) => {
      return {id: prompt.id, originalText: prompt.originalText}
    }),
  ).toEqual([{id: promptId, originalText: 'Clone rerun prompt'}])
  expect(getJudgmentSummaries(sourceDetails.judgments)).toEqual([
    {answeredOriginal: 'yes', id: sourceJudgmentId, promptId},
  ])
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
    {getDuckdbMartMaintenanceService},
    {getProjectMartDirtyRefreshStateService},
    {projectsRoutes},
  ] = await Promise.all([
    import('../../db/migrateDuckdb.ts'),
    import('../services/appDatabaseService.ts'),
    import('../utils/duckdbService.ts'),
    import('../utils/serverRuntimeRole.ts'),
    import('../services/getDuckdbMartMaintenanceService.ts'),
    import('../services/projectMartDirtyRefreshStateService.ts'),
    import('./ProjectsRoutes.ts'),
  ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()

  await migrateDuckdb()

  const database = getAppDatabaseService()

  closeDatabase = () => {
    return database.close()
  }
  flushMartRefreshes = async () => {}
  cleanupArchivedProjectMartDataBatch = (projectId: string) => {
    return getDuckdbMartMaintenanceService().cleanupArchivedProjectMartDataBatch(projectId)
  }
  markArticleProjectsDirty = async (articleId: string, reason: string) => {
    await getProjectMartDirtyRefreshStateService().markArticleProjectsDirtyAtomically({articleIds: [articleId], reason})
  }
  refreshProject = (projectId: string) => {
    return getDuckdbMartMaintenanceService().refreshProject(projectId)
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
  tempRuntimeRoot.cleanup()
})

test('project prompt preview uses the first project article and shared prompt builders', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const projectId = 'project-preview-route'
  const promptId = 'prompt-preview-route'

  await insertProjectFixture({connectionId: 'preview-connection-route', modelId: 'preview-model-route', projectId})
  await insertProjectPromptFixture({
    contentHash: computePromptContentHash('Is this study about healthcare?', null, `'yes' | 'no' | 'unsure'`),
    originalText: 'Is this study about healthcare?',
    originProjectId: projectId,
    projectId,
    projectPromptId: 'project-prompt-preview-route',
    promptHeading: 'Healthcare',
    promptId,
    type: `'yes' | 'no' | 'unsure'`,
  })
  await insertProjectArticleFixture({
    articleId: 'preview-article-second',
    articleSeq: 2,
    projectArticleId: 'project-article-preview-second',
    projectId,
    summary: 'Second article summary',
    title: 'Second article title',
  })
  await insertProjectArticleFixture({
    articleId: 'preview-article-first',
    articleSeq: 1,
    projectArticleId: 'project-article-preview-first',
    projectId,
    summary: 'First article summary',
    title: 'First article title',
  })
  await runDatabase(`
    INSERT INTO mart.project_scope_article (
      project_id,
      article_id,
      in_curated_scope,
      in_route_scope,
      article_created_at,
      article_updated_at
    ) VALUES
      (
        '${projectId}',
        'preview-article-second',
        TRUE,
        TRUE,
        TIMESTAMPTZ '2026-01-01T00:00:00.000Z',
        NULL
      ),
      (
        '${projectId}',
        'preview-article-first',
        TRUE,
        TRUE,
        TIMESTAMPTZ '2026-02-01T00:00:00.000Z',
        NULL
      )
  `)
  const reviewConfigHash = await getCurrentReviewConfigHash(projectId)
  const required = ['judgmentInputContent', 'projectScope', 'selectedImport', 'payload'].map((component) => {
    return {baseGeneration: '1', component, patchWatermark: '0', projectionIdentity: `${component}:preview-identity`}
  })
  const displayState = {
    baseGeneration: '1',
    component: 'display',
    patchWatermark: '0',
    projectionIdentity: 'display:preview-identity',
  }
  await runDatabase(`
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
      activated_at,
      updated_at
    ) VALUES (
      '${projectId}',
      'snapshot-preview-route',
      'active',
      ${getSqlLiteral(reviewConfigHash)},
      '{}'::JSON,
      '${JSON.stringify({optional: [displayState], required}).replaceAll("'", "''")}'::JSON,
      '${JSON.stringify(required).replaceAll("'", "''")}'::JSON,
      '[]'::JSON,
      '{}'::JSON,
      TIMESTAMPTZ '2026-02-02T00:00:00.000Z',
      TIMESTAMPTZ '2026-02-02T00:00:00.000Z'
    )
  `)
  await runDatabase(`
    INSERT INTO mart.review_article_serving_payload_v4 (
      project_id,
      display_identity,
      payload_identity,
      snapshot_id,
      article_id,
      article_created_at,
      source_metadata,
      abstract_text,
      full_text_preview,
      payload_bytes
    ) VALUES (
      '${projectId}',
      'display:preview-identity',
      'payload:preview-identity',
      'snapshot-preview-route',
      'preview-article-second',
      TIMESTAMPTZ '2026-01-01T00:00:00.000Z',
      '{}'::JSON,
      'Second article summary',
      NULL,
      128
    )
  `)

  const response = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}/prompts/${promptId}/preview`),
  )
  const payload = (await response.json()) as {
    data: {
      articleId: string | null
      previewText: string | null
      status: 'ready' | 'unavailable'
      systemPrompt: string | null
      userPrompt: string | null
    }
  }

  expect(response.status).toBe(200)
  expect(payload.data.status).toBe('ready')
  expect(payload.data.articleId).toBe('preview-article-second')
  expect(payload.data.systemPrompt).toContain('You are a helpful deep research assistant.')
  expect(payload.data.userPrompt).toContain('Second article title')
  expect(payload.data.userPrompt).toContain('Second article summary')
  expect(payload.data.userPrompt).toContain('Is this study about healthcare?')
  expect(payload.data.userPrompt).not.toContain('First article title')
  expect(payload.data.previewText).toContain('## System Prompt')
  expect(payload.data.previewText).toContain('## User Prompt')
})

test('archive route clears refresh state for archived projects without depending on the legacy queue', async () => {
  if (!app || !queryDatabase || !runDatabase || !flushMartRefreshes) {
    throw new Error('Test app not initialized')
  }

  const projectId = 'archive-project-regression'

  await insertProjectFixture({
    connectionId: 'archive-connection-regression',
    modelId: 'archive-model-regression',
    projectId,
  })
  const response = await app.handle(new Request(`http://localhost/api/projects/${projectId}`, {method: 'DELETE'}))

  expect(response.status).toBe(200)

  const [storedProject] = await queryDatabase<{archived: boolean}>(`
    SELECT archived
    FROM app.project
    WHERE id = '${projectId}'
    LIMIT 1
  `)
  const [refreshState] = await queryDatabase<{
    dirtyToken: number
    lastCompletedDirtyToken: number
    projectId: string
    refreshStatus: string
  }>(`
    SELECT
      project_id AS projectId,
      CAST(dirty_token AS INTEGER) AS dirtyToken,
      CAST(last_completed_dirty_token AS INTEGER) AS lastCompletedDirtyToken,
      refresh_status AS refreshStatus
    FROM app.project_mart_refresh_state
    WHERE project_id = '${projectId}'
    LIMIT 1
  `)

  expect(storedProject?.archived).toBe(true)
  expect(refreshState).toBeUndefined()

  await flushMartRefreshes()
})

test('archive route leaves archived mart cleanup to bounded maintenance batches while clearing refresh state', async () => {
  if (!app || !queryDatabase || !runDatabase || !flushMartRefreshes || !cleanupArchivedProjectMartDataBatch) {
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
  expect(refreshState).toBeUndefined()

  const cleanupBatch = await cleanupArchivedProjectMartDataBatch(projectId)
  const [servingRowCountAfterBatch] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM mart.review_article_serving
    WHERE project_id = '${projectId}'
  `)

  expect(cleanupBatch.deletedRowCount).toBe(10)
  expect(Number(servingRowCountAfterBatch?.count ?? 0)).toBe(388)

  await flushMartRefreshes()
})

test('unarchive route rebuilds dirty articles from current date-bounded app scope', async () => {
  if (!app || !queryDatabase || !runDatabase || !flushMartRefreshes) {
    throw new Error('Test app not initialized')
  }

  const projectId = 'unarchive-current-scope-project'
  const routeId = 'unarchive-current-scope-route'

  await insertProjectFixture({
    archived: true,
    connectionId: 'unarchive-current-scope-connection',
    modelId: 'unarchive-current-scope-model',
    projectId,
  })
  await runDatabase(`
    UPDATE app.project
    SET
      date_from = TIMESTAMPTZ '2025-01-01T00:00:00.000Z',
      date_to = TIMESTAMPTZ '2025-12-31T23:59:59.000Z'
    WHERE id = '${projectId}'
  `)
  await runDatabase(`
    INSERT INTO app.import_route (id, route, name)
    VALUES ('${routeId}', '/unarchive-current-scope-route', 'manual')
  `)
  await runDatabase(`
    INSERT INTO app.project_import_route (id, project_id, import_route_id)
    VALUES ('unarchive-current-scope-project-route', '${projectId}', '${routeId}')
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_title, article_created_at)
    VALUES
      ('unarchive-direct-in-range', 'Unarchive direct in range', TIMESTAMPTZ '2025-04-01T00:00:00.000Z'),
      ('unarchive-route-in-range', 'Unarchive route in range', TIMESTAMPTZ '2025-05-01T00:00:00.000Z'),
      ('unarchive-direct-out-of-range', 'Unarchive direct out of range', TIMESTAMPTZ '2026-01-01T00:00:00.000Z'),
      ('unarchive-route-out-of-range', 'Unarchive route out of range', TIMESTAMPTZ '2026-02-01T00:00:00.000Z')
  `)
  await runDatabase(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES
      ('unarchive-direct-in-range-link', '${projectId}', 'unarchive-direct-in-range'),
      ('unarchive-direct-out-of-range-link', '${projectId}', 'unarchive-direct-out-of-range')
  `)
  await runDatabase(`
    INSERT INTO app.article_import_route (id, article_id, import_route_id)
    VALUES
      ('unarchive-route-in-range-link', 'unarchive-route-in-range', '${routeId}'),
      ('unarchive-route-out-of-range-link', 'unarchive-route-out-of-range', '${routeId}')
  `)

  const response = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}/unarchive`, {method: 'POST'}),
  )

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
  const dirtyArticleRows = await queryDatabase<{articleId: string; firstDirtyToken: number; lastDirtyToken: number}>(`
    SELECT
      article_id AS articleId,
      CAST(first_dirty_token AS INTEGER) AS firstDirtyToken,
      CAST(last_dirty_token AS INTEGER) AS lastDirtyToken
    FROM app.project_mart_refresh_article_state
    WHERE project_id = '${projectId}'
    ORDER BY article_id ASC
  `)
  const [materializationCount] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*)::INTEGER AS count
    FROM app.project_mart_dirty_materialization_state
    WHERE project_id = '${projectId}'
  `)

  expect(storedProject?.archived).toBe(false)
  expect(refreshState).toEqual({dirtyToken: 1, projectId, reason: 'ProjectsRoutes.unarchive'})
  expect(dirtyArticleRows).toEqual([
    {articleId: 'unarchive-direct-in-range', firstDirtyToken: 1, lastDirtyToken: 1},
    {articleId: 'unarchive-route-in-range', firstDirtyToken: 1, lastDirtyToken: 1},
  ])
  expect(Number(materializationCount?.count ?? 0)).toBe(0)

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

test('delete archived route tombstones projects with non-terminal judgment jobs', async () => {
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

  expect(response.status).toBe(200)

  const [projectRow] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.project
    WHERE id = '${projectId}'
  `)
  const [jobRow] = await queryDatabase<{status: string; storageState: string}>(`
    SELECT status, storage_state AS storageState
    FROM app.judgment_job
    WHERE id = 'delete-archived-running-job'
    LIMIT 1
  `)
  const [tombstoneRow] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.archived_project_delete_tombstone
    WHERE project_id = '${projectId}'
  `)

  expect(Number(projectRow?.count ?? 0)).toBe(1)
  expect(jobRow).toEqual({status: 'project_removed', storageState: 'draining'})
  expect(Number(tombstoneRow?.count ?? 0)).toBe(1)
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
  const survivorComparisonProjectId = 'delete-archived-survivor-comparison-project'
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
    UPDATE app.project
    SET model_id = 'delete-archived-source-model'
    WHERE id = '${survivorProjectId}'
  `)
  await runDatabase(`
    INSERT INTO app.comparison_project (
      id,
      name,
      compare_with_humans,
      human_judgment_mode,
      summary_source_project_id
    ) VALUES (
      '${survivorComparisonProjectId}',
      'Delete archived survivor comparison',
      TRUE,
      'summary',
      '${sourceProjectId}'
    )
  `)
  await runDatabase(`
    INSERT INTO app.comparison_project_source_project (id, comparison_project_id, source_project_id)
    VALUES ('delete-archived-comparison-source-link', '${survivorComparisonProjectId}', '${sourceProjectId}')
  `)
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
    INSERT INTO app.comparison_project_conflict_resolution (
      id,
      comparison_project_id,
      article_id,
      prompt_id,
      answer_value
    ) VALUES (
      'delete-archived-comparison-conflict-resolution',
      '${survivorComparisonProjectId}',
      '${articleId}',
      '${promptId}',
      'yes'
    )
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
      active_dirty_token,
      last_completed_dirty_token,
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
      'delete-archived-judgment',
      '${articleId}',
      '${promptId}',
      'delete-archived-source-model',
      '${sourceProjectId}',
      '${sourceProjectId}',
      'Delete archived source',
      TRUE,
      TRUE,
      FALSE,
      FALSE,
      NULL,
      TRUE,
      'yes',
      ['yes'],
      ['yes'],
      90,
      NULL,
      NULL,
      'Delete archived article',
      TIMESTAMPTZ '2025-09-09 00:00:00+00',
      NULL,
      NULL,
      NULL,
      current_timestamp,
      current_timestamp
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
    ) VALUES
      (
        '${sourceProjectId}',
        '${articleId}',
        TRUE,
        TRUE,
        TIMESTAMPTZ '2025-09-09 00:00:00+00',
        NULL
      ),
      (
        '${survivorProjectId}',
        '${articleId}',
        TRUE,
        FALSE,
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

  const {getArchivedProjectCleanupService} = await import('../services/archivedProjectCleanupService.ts')
  const cleanupResult = await getArchivedProjectCleanupService().runArchivedProjectBoundedCleanup({
    batchSize: 1000,
    maxBatches: 100,
  })

  expect(cleanupResult.status).toBe('completed')

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
  const [judgmentFactProjectId] = await queryDatabase<{projectId: string | null; rowCount: number}>(`
    SELECT COUNT(*) AS rowCount, MAX(project_id) AS projectId
    FROM mart.judgment_fact
    WHERE judgment_id = 'delete-archived-judgment'
  `)
  const [survivorVisibleJudgmentFact] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM mart.project_scope_article scope_article
    INNER JOIN app.project project
      ON project.id = scope_article.project_id
    INNER JOIN app.project_prompt project_prompt
      ON project_prompt.project_id = scope_article.project_id
     AND project_prompt.enabled = TRUE
    INNER JOIN mart.judgment_fact judgment_fact
      ON judgment_fact.article_id = scope_article.article_id
     AND judgment_fact.prompt_id = project_prompt.prompt_id
     AND judgment_fact.model_id = project.model_id
     AND judgment_fact.use_title = project.use_title
     AND judgment_fact.use_abstract = project.use_abstract
     AND judgment_fact.use_fulltext = project.use_fulltext
     AND judgment_fact.use_fulltext_no_images = project.use_fulltext_no_images
    WHERE scope_article.project_id = '${survivorProjectId}'
      AND judgment_fact.judgment_id = 'delete-archived-judgment'
  `)
  const [judgmentHumanProjectId] = await queryDatabase<{projectId: string | null}>(`
    SELECT project_id AS projectId
    FROM app.judgment_human
    WHERE id = 'delete-archived-judgment-human'
    LIMIT 1
  `)
  const [comparisonProjectRow] = await queryDatabase<{count: number; summarySourceProjectId: string | null}>(`
    SELECT COUNT(*) AS count, summary_source_project_id AS summarySourceProjectId
    FROM app.comparison_project
    WHERE id = '${survivorComparisonProjectId}'
    GROUP BY summary_source_project_id
  `)
  const [comparisonProjectSourceLinkRowCount] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.comparison_project_source_project
    WHERE comparison_project_id = '${survivorComparisonProjectId}'
  `)
  const [comparisonProjectConflictResolutionRow] = await queryDatabase<{answerValue: string | null; count: number}>(`
      SELECT COUNT(*) AS count, MAX(answer_value) AS answerValue
      FROM app.comparison_project_conflict_resolution
      WHERE comparison_project_id = '${survivorComparisonProjectId}'
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
  expect(Number(servingRowCount?.count ?? 0)).toBe(0)
  expect(Number(filterMemberRowCount?.count ?? 0)).toBe(0)
  expect(Number(servingDetailRowCount?.count ?? 0)).toBe(0)
  expect(survivorPromptOrigin?.originProjectId).toBe(null)
  expect(survivorArticleOrigin?.importedFromProjectId).toBe(null)
  expect(Number(comparisonProjectRow?.count ?? 0)).toBe(1)
  expect(comparisonProjectRow?.summarySourceProjectId).toBe(null)
  expect(Number(comparisonProjectSourceLinkRowCount?.count ?? 0)).toBe(0)
  expect(Number(comparisonProjectConflictResolutionRow?.count ?? 0)).toBe(1)
  expect(comparisonProjectConflictResolutionRow?.answerValue).toBe('yes')
  expect(judgmentProjectId?.projectId).toBe(null)
  expect(Number(judgmentFactProjectId?.rowCount ?? 0)).toBe(1)
  expect(judgmentFactProjectId?.projectId).toBe(null)
  expect(Number(survivorVisibleJudgmentFact?.count ?? 0)).toBe(1)
  expect(judgmentHumanProjectId?.projectId).toBe(null)
})

test('simple patch route allows name and description edits when a judgment job exists', async () => {
  if (!app || !queryDatabase || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'patch-job-metadata-connection'
  const modelId = 'patch-job-metadata-model'
  const projectId = 'patch-job-metadata-project'

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('patch-job-metadata-job', '${projectId}', 'completed')
  `)

  const response = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}`, {
      body: JSON.stringify({name: 'Updated job metadata project', description: 'Updated job metadata description'}),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const body = (await response.json()) as {data: {description: string | null; name: string}}

  expect(response.status).toBe(200)
  expect(body.data.name).toBe('Updated job metadata project')
  expect(body.data.description).toBe('Updated job metadata description')

  const [jobRow] = await queryDatabase<{status: string}>(`
    SELECT status
    FROM app.judgment_job
    WHERE id = 'patch-job-metadata-job'
    LIMIT 1
  `)

  expect(jobRow?.status).toBe('completed')
})

test('edit patch routes reject archived and delete-pending projects', async () => {
  if (!app || !queryDatabase || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const archivedProjectId = 'edit-guard-archived-project'
  const deletePendingProjectId = 'edit-guard-delete-pending-project'

  await insertProjectFixture({
    archived: true,
    connectionId: 'edit-guard-archived-connection',
    modelId: 'edit-guard-archived-model',
    projectId: archivedProjectId,
  })
  await insertProjectFixture({
    connectionId: 'edit-guard-delete-pending-connection',
    modelId: 'edit-guard-delete-pending-model',
    projectId: deletePendingProjectId,
  })
  await runDatabase(`
    UPDATE app.project
    SET delete_pending_at = current_timestamp
    WHERE id = '${deletePendingProjectId}'
  `)

  const archivedSimpleResponse = await app.handle(
    new Request(`http://localhost/api/projects/${archivedProjectId}`, {
      body: JSON.stringify({name: 'Archived simple patch should fail'}),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const archivedEditResponse = await app.handle(
    new Request(`http://localhost/api/projects/${archivedProjectId}/edit`, {
      body: JSON.stringify({name: 'Archived edit patch should fail'}),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const deletePendingSimpleResponse = await app.handle(
    new Request(`http://localhost/api/projects/${deletePendingProjectId}`, {
      body: JSON.stringify({name: 'Delete-pending simple patch should fail'}),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const deletePendingEditResponse = await app.handle(
    new Request(`http://localhost/api/projects/${deletePendingProjectId}/edit`, {
      body: JSON.stringify({name: 'Delete-pending edit patch should fail'}),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )

  expect(archivedSimpleResponse.status).toBe(500)
  expect(await archivedSimpleResponse.text()).toContain('Archived projects must be unarchived before use')
  expect(archivedEditResponse.status).toBe(500)
  expect(await archivedEditResponse.text()).toContain('Archived projects must be unarchived before use')
  expect(deletePendingSimpleResponse.status).toBe(500)
  expect(await deletePendingSimpleResponse.text()).toContain('Project not found')
  expect(deletePendingEditResponse.status).toBe(500)
  expect(await deletePendingEditResponse.text()).toContain('Project not found')

  const projectRows = await queryDatabase<{id: string; name: string}>(`
    SELECT id, name
    FROM app.project
    WHERE id IN ('${archivedProjectId}', '${deletePendingProjectId}')
    ORDER BY id ASC
  `)

  expect(projectRows).toEqual([
    {id: archivedProjectId, name: 'Archive Regression Project'},
    {id: deletePendingProjectId, name: 'Archive Regression Project'},
  ])
})

test('edit route allows name-only edit when a judgment job exists', async () => {
  if (!app || !queryDatabase || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'edit-job-name-connection'
  const modelId = 'edit-job-name-model'
  const projectId = 'edit-job-name-project'

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('edit-job-name-job', '${projectId}', 'running')
  `)

  const response = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}/edit`, {
      body: JSON.stringify({name: 'Judged project renamed'}),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const body = (await response.json()) as {data: {project: {name: string}}}

  expect(response.status).toBe(200)
  expect(body.data.project.name).toBe('Judged project renamed')
})

test('edit route allows description-only edit when a judgment job exists', async () => {
  if (!app || !queryDatabase || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'edit-job-description-connection'
  const modelId = 'edit-job-description-model'
  const projectId = 'edit-job-description-project'

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('edit-job-description-job', '${projectId}', 'completed')
  `)

  const response = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}/edit`, {
      body: JSON.stringify({description: 'Judged project description changed'}),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const body = (await response.json()) as {data: {project: {description: string | null}}}

  expect(response.status).toBe(200)
  expect(body.data.project.description).toBe('Judged project description changed')
})

test('edit route still supports full config and prompt edits before a judgment job exists', async () => {
  if (!app || !queryDatabase || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'edit-no-job-full-connection'
  const modelId = 'edit-no-job-full-model'
  const nextModelId = 'edit-no-job-full-next-model'
  const projectId = 'edit-no-job-full-project'
  const importRouteId = 'edit-no-job-full-route-id'
  const importRoute = '/edit-no-job-full-route'
  const originalPromptId = 'edit-no-job-full-original-prompt'
  const originalPromptText = 'No job original prompt'

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${nextModelId}', '${connectionId}', 'No Job Next', 'No Job Next', 'No Job Next', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.import_route (id, route, name)
    VALUES ('${importRouteId}', '${importRoute}', 'No job route')
  `)
  await insertProjectPromptFixture({
    contentHash: computePromptContentHash(originalPromptText, null, 'no job original heading', 'string'),
    order: 1,
    originProjectId: null,
    originalText: originalPromptText,
    projectId,
    projectPromptId: 'edit-no-job-full-project-prompt',
    promptHeading: 'no job original heading',
    promptId: originalPromptId,
    type: 'string',
  })

  const response = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}/edit`, {
      body: JSON.stringify({
        dateFrom: '2026-02-03',
        dateTo: '2026-03-04',
        description: 'No job full edit description',
        humanJudgmentMode: 'summary',
        importRoutes: [importRoute],
        modelId: nextModelId,
        name: 'No job full edit renamed',
        prompts: [
          {
            archived: true,
            enabled: false,
            order: 7,
            originalId: originalPromptId,
            originalText: 'No job edited prompt',
            promptHeading: 'no job edited heading',
            type: 'boolean',
          },
        ],
        useAbstract: false,
        useFulltext: false,
        useFulltextNoImages: true,
        useTitle: false,
      }),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const body = (await response.json()) as {data: {project: {modelId: string; name: string}}}

  expect(response.status).toBe(200)
  expect(body.data.project.name).toBe('No job full edit renamed')
  expect(body.data.project.modelId).toBe(nextModelId)

  const [projectRow] = await queryDatabase<{
    dateFrom: string | null
    dateTo: string | null
    description: string | null
    humanJudgmentMode: string
    modelId: string
    name: string
    useAbstract: boolean
    useFulltext: boolean
    useFulltextNoImages: boolean
    useTitle: boolean
  }>(`
    SELECT
      name,
      description,
      model_id AS modelId,
      human_judgment_mode AS humanJudgmentMode,
      CAST(date_from AS VARCHAR) AS dateFrom,
      CAST(date_to AS VARCHAR) AS dateTo,
      use_title AS useTitle,
      use_abstract AS useAbstract,
      use_fulltext AS useFulltext,
      use_fulltext_no_images AS useFulltextNoImages
    FROM app.project
    WHERE id = '${projectId}'
    LIMIT 1
  `)
  const importRouteRows = await queryDatabase<{route: string}>(`
    SELECT ir.route
    FROM app.project_import_route pir
    INNER JOIN app.import_route ir ON ir.id = pir.import_route_id
    WHERE pir.project_id = '${projectId}'
  `)
  const promptRows = await queryDatabase<{
    archived: boolean
    enabled: boolean
    order: number
    originalText: string
    promptHeading: string | null
    promptId: string
    type: string | null
  }>(`
    SELECT
      pp.prompt_id AS promptId,
      pp.prompt_order AS "order",
      pp.archived,
      pp.enabled,
      p.original_text AS originalText,
      p.prompt_heading AS promptHeading,
      p.type
    FROM app.project_prompt pp
    INNER JOIN app.prompt p ON p.id = pp.prompt_id
    WHERE pp.project_id = '${projectId}'
  `)

  expect(projectRow?.name).toBe('No job full edit renamed')
  expect(projectRow?.description).toBe('No job full edit description')
  expect(projectRow?.modelId).toBe(nextModelId)
  expect(projectRow?.humanJudgmentMode).toBe('summary')
  expect(projectRow?.dateFrom).toContain('2026-02-03')
  expect(projectRow?.dateTo).toContain('2026-03-04')
  expect(projectRow?.useTitle).toBe(false)
  expect(projectRow?.useAbstract).toBe(false)
  expect(projectRow?.useFulltext).toBe(false)
  expect(projectRow?.useFulltextNoImages).toBe(true)
  expect(importRouteRows).toEqual([{route: importRoute}])
  expect(promptRows).toHaveLength(1)
  expect(promptRows[0]?.promptId).not.toBe(originalPromptId)
  expect(promptRows[0]?.originalText).toBe('No job edited prompt')
  expect(promptRows[0]?.promptHeading).toBe('no job edited heading')
  expect(promptRows[0]?.type).toBe('boolean')
  expect(promptRows[0]?.order).toBe(7)
  expect(promptRows[0]?.archived).toBe(true)
  expect(promptRows[0]?.enabled).toBe(false)
})

test('edit route rejects protected config changes when a judgment job exists', async () => {
  if (!app || !queryDatabase || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'edit-job-protected-connection'
  const modelId = 'edit-job-protected-model'
  const nextModelId = 'edit-job-protected-next-model'
  const projectId = 'edit-job-protected-project'

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${nextModelId}', '${connectionId}', 'Protected Next', 'Protected Next', 'Protected Next', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('edit-job-protected-job', '${projectId}', 'completed')
  `)

  const response = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}/edit`, {
      body: JSON.stringify({modelId: nextModelId, useTitle: false}),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const body = await response.text()

  expect(response.status).toBe(409)
  expect(body).toContain('modelId')
  expect(body).toContain('useTitle')

  const [projectRow] = await queryDatabase<{modelId: string; useTitle: boolean}>(`
    SELECT model_id AS modelId, use_title AS useTitle
    FROM app.project
    WHERE id = '${projectId}'
    LIMIT 1
  `)

  expect(projectRow).toEqual({modelId, useTitle: true})
})

test('edit route rejects all remaining protected config changes when a judgment job exists', async () => {
  if (!app || !queryDatabase || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'edit-job-protected-rest-connection'
  const modelId = 'edit-job-protected-rest-model'
  const projectId = 'edit-job-protected-rest-project'

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('edit-job-protected-rest-job', '${projectId}', 'completed')
  `)

  const response = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}/edit`, {
      body: JSON.stringify({
        dateFrom: '2026-01-01',
        dateTo: '2026-12-31',
        humanJudgmentMode: 'summary',
        importRoutes: ['locked-route-change'],
        useAbstract: false,
        useFulltext: true,
        useFulltextNoImages: true,
      }),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const body = await response.text()

  expect(response.status).toBe(409)
  expect(body).toContain('useAbstract')
  expect(body).toContain('useFulltext')
  expect(body).toContain('useFulltextNoImages')
  expect(body).toContain('humanJudgmentMode')
  expect(body).toContain('dateFrom')
  expect(body).toContain('dateTo')
  expect(body).toContain('importRoutes')

  const [projectRow] = await queryDatabase<{
    dateFrom: string | null
    dateTo: string | null
    humanJudgmentMode: string
    useAbstract: boolean
    useFulltext: boolean
    useFulltextNoImages: boolean
  }>(`
    SELECT
      CAST(date_from AS VARCHAR) AS dateFrom,
      CAST(date_to AS VARCHAR) AS dateTo,
      human_judgment_mode AS humanJudgmentMode,
      use_abstract AS useAbstract,
      use_fulltext AS useFulltext,
      use_fulltext_no_images AS useFulltextNoImages
    FROM app.project
    WHERE id = '${projectId}'
    LIMIT 1
  `)
  const [importRouteCount] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.project_import_route
    WHERE project_id = '${projectId}'
  `)

  expect(projectRow).toEqual({
    dateFrom: null,
    dateTo: null,
    humanJudgmentMode: 'prompt',
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
  })
  expect(Number(importRouteCount?.count ?? 0)).toBe(0)
})

test('edit route does not validate an unchanged protected model when a judgment job exists', async () => {
  if (!app || !queryDatabase || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'edit-job-unchanged-model-connection'
  const modelId = 'edit-job-unchanged-model'
  const projectId = 'edit-job-unchanged-model-project'

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    UPDATE app.model
    SET enabled = FALSE
    WHERE id = '${modelId}'
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('edit-job-unchanged-model-job', '${projectId}', 'completed')
  `)

  const response = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}/edit`, {
      body: JSON.stringify({modelId, name: 'Judged project with unchanged disabled model'}),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const body = (await response.json()) as {data: {project: {modelId: string; name: string}}}

  expect(response.status).toBe(200)
  expect(body.data.project.modelId).toBe(modelId)
  expect(body.data.project.name).toBe('Judged project with unchanged disabled model')
})

test('edit route returns 409 for prompt changes with unsafe retained SQLite job state', async () => {
  if (!app || !queryDatabase || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'edit-job-prompt-change-connection'
  const modelId = 'edit-job-prompt-change-model'
  const projectId = 'edit-job-prompt-change-project'
  const promptId = 'edit-job-prompt-change-prompt'
  const originalPromptText = 'Prompt change job original text'

  await insertProjectFixture({connectionId, modelId, projectId})
  await insertProjectPromptFixture({
    contentHash: computePromptContentHash(originalPromptText, null, 'Prompt change job heading', 'string'),
    originProjectId: projectId,
    originalText: originalPromptText,
    projectId,
    projectPromptId: 'edit-job-prompt-change-project-prompt',
    promptHeading: 'Prompt change job heading',
    promptId,
    type: 'string',
  })
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('edit-job-prompt-change-job', '${projectId}', 'completed')
  `)
  await insertJudgmentJobSqliteHealthProjectionFixture({jobId: 'edit-job-prompt-change-job', outboxRowCount: 1})

  const response = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}/edit`, {
      body: JSON.stringify({
        prompts: [
          {
            originalId: promptId,
            originalText: 'Prompt change job edited text',
            promptHeading: 'Prompt change job heading',
            type: 'string',
            order: 0,
            enabled: true,
          },
        ],
      }),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const body = await response.text()

  expect(response.status).toBe(409)
  expect(body).toContain('Pause or drain the judgment job before editing prompts.')

  const promptRows = await queryDatabase<{originalText: string; promptId: string}>(`
    SELECT pp.prompt_id AS promptId, p.original_text AS originalText
    FROM app.project_prompt pp
    INNER JOIN app.prompt p ON p.id = pp.prompt_id
    WHERE pp.project_id = '${projectId}'
  `)

  expect(promptRows).toEqual([{originalText: originalPromptText, promptId}])
})

test('edit route allows safe prompt replacement with a drained judgment job and cleans project human answers', async () => {
  if (!app || !queryDatabase || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'edit-job-safe-prompt-connection'
  const modelId = 'edit-job-safe-prompt-model'
  const projectId = 'edit-job-safe-prompt-project'
  const otherProjectId = 'edit-job-safe-prompt-other-project'
  const promptId = 'edit-job-safe-prompt-original-prompt'
  const originalPromptText = 'Safe prompt original text'
  const editedPromptText = 'Safe prompt edited text'
  const promptHeading = 'safe prompt heading'
  const promptType = 'string'
  const editedPromptHash = computePromptContentHash(editedPromptText, null, promptHeading, promptType)

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.project (
      id,
      name,
      model_id,
      human_judgment_mode,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images,
      archived
    )
    VALUES (
      '${otherProjectId}',
      'Other safe prompt project',
      '${modelId}',
      'prompt',
      TRUE,
      TRUE,
      FALSE,
      FALSE,
      FALSE
    )
  `)
  await insertProjectPromptFixture({
    contentHash: computePromptContentHash(originalPromptText, null, promptHeading, promptType),
    originProjectId: projectId,
    originalText: originalPromptText,
    projectId,
    projectPromptId: 'edit-job-safe-prompt-project-prompt',
    promptHeading,
    promptId,
    type: promptType,
  })
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES
      ('edit-job-safe-prompt-article-1', 'Safe prompt article 1'),
      ('edit-job-safe-prompt-article-2', 'Safe prompt article 2')
  `)
  await runDatabase(`
    INSERT INTO app.judgment_human (id, project_id, article_id, prompt_id, is_answered, answer)
    VALUES
      (
        'edit-job-safe-prompt-human-answered',
        '${projectId}',
        'edit-job-safe-prompt-article-1',
        '${promptId}',
        TRUE,
        'yes'
      ),
      (
        'edit-job-safe-prompt-human-pending',
        '${projectId}',
        'edit-job-safe-prompt-article-2',
        '${promptId}',
        FALSE,
        NULL
      ),
      (
        'edit-job-safe-prompt-human-other-project',
        '${otherProjectId}',
        'edit-job-safe-prompt-article-1',
        '${promptId}',
        TRUE,
        'no'
      )
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('edit-job-safe-prompt-job', '${projectId}', 'paused', 'draining')
  `)
  await insertJudgmentJobSqliteHealthProjectionFixture({jobId: 'edit-job-safe-prompt-job'})

  const response = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}/edit`, {
      body: JSON.stringify({
        prompts: [
          {
            originalId: promptId,
            originalText: editedPromptText,
            promptHeading,
            type: promptType,
            order: 0,
            enabled: true,
          },
        ],
      }),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const body = (await response.json()) as {
    data: {
      promptCleanupSummary: {
        changedPromptLinks: Array<{
          newPromptId: string | null
          oldPromptId: string
          projectPromptId: string
          reason: string
        }>
        deletedHumanPromptAnswers: number
      }
      prompts: Array<{id: string; originalText: string}>
    }
  }

  expect(response.status).toBe(200)

  const [projectPromptRow] = await queryDatabase<{contentHash: string | null; originalText: string; promptId: string}>(`
    SELECT p.id AS promptId, p.original_text AS originalText, p.content_hash AS contentHash
    FROM app.project_prompt pp
    INNER JOIN app.prompt p ON p.id = pp.prompt_id
    WHERE pp.project_id = '${projectId}'
    LIMIT 1
  `)
  const [oldPromptRow] = await queryDatabase<{originalText: string}>(`
    SELECT original_text AS originalText
    FROM app.prompt
    WHERE id = '${promptId}'
    LIMIT 1
  `)
  const [editedProjectHumanCount] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.judgment_human
    WHERE project_id = '${projectId}'
      AND prompt_id = '${promptId}'
  `)
  const [otherProjectHumanCount] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.judgment_human
    WHERE project_id = '${otherProjectId}'
      AND prompt_id = '${promptId}'
  `)
  const [jobRow] = await queryDatabase<{status: string; storageState: string}>(`
    SELECT status, storage_state AS storageState
    FROM app.judgment_job
    WHERE id = 'edit-job-safe-prompt-job'
    LIMIT 1
  `)
  const [refreshState] = await queryDatabase<{dirtyToken: number; reason: string | null}>(`
    SELECT CAST(dirty_token AS INTEGER) AS dirtyToken, last_request_reason AS reason
    FROM app.project_mart_refresh_state
    WHERE project_id = '${projectId}'
    LIMIT 1
  `)

  expect(projectPromptRow?.promptId).not.toBe(promptId)
  expect(projectPromptRow).toEqual({
    contentHash: editedPromptHash,
    originalText: editedPromptText,
    promptId: body.data.prompts[0]?.id,
  })
  expect(oldPromptRow).toEqual({originalText: originalPromptText})
  expect(body.data.promptCleanupSummary).toEqual({
    changedPromptLinks: [
      {
        newPromptId: projectPromptRow?.promptId,
        oldPromptId: promptId,
        projectPromptId: 'edit-job-safe-prompt-project-prompt',
        reason: 'replaced',
      },
    ],
    deletedHumanPromptAnswers: 2,
    keptSharedLlmJudgments: 0,
    skippedComparisonPromptReferencedJudgments: 0,
    softDeletedLlmJudgments: 0,
  })
  expect(Number(editedProjectHumanCount?.count ?? 0)).toBe(0)
  expect(Number(otherProjectHumanCount?.count ?? 0)).toBe(1)
  expect(jobRow).toEqual({status: 'paused', storageState: 'draining'})
  expect(refreshState).toEqual({dirtyToken: 1, reason: 'ProjectsRoutes.edit'})
})

test('edit route reuses existing prompt judgments and preserves association metadata during safe replacement', async () => {
  if (!app || !queryDatabase || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'edit-job-reuse-judgment-connection'
  const modelId = 'edit-job-reuse-judgment-model'
  const projectId = 'edit-job-reuse-judgment-project'
  const originalPromptId = 'edit-job-reuse-judgment-original-prompt'
  const targetPromptId = 'edit-job-reuse-judgment-target-prompt'
  const originalPromptText = 'Reuse judgment original prompt text'
  const targetPromptText = 'Reuse judgment target prompt text'
  const targetPromptHeading = 'target heading'
  const targetPromptType = 'boolean'
  const targetPromptHash = computePromptContentHash(targetPromptText, null, targetPromptHeading, targetPromptType)

  await insertProjectFixture({connectionId, modelId, projectId})
  await insertProjectPromptFixture({
    archived: true,
    contentHash: computePromptContentHash(originalPromptText, null, 'original heading', 'string'),
    criteriaDisposition: 'combined',
    criteriaSectionKey: 'eligibility',
    criteriaSectionLabel: 'Eligibility',
    enabled: false,
    order: 0,
    originProjectId: projectId,
    originalText: originalPromptText,
    projectId,
    projectPromptId: 'edit-job-reuse-judgment-project-prompt',
    promptHeading: 'original heading',
    promptId: originalPromptId,
    type: 'string',
  })
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, prompt_heading, type, content_hash)
    VALUES (
      '${targetPromptId}',
      '${targetPromptText}',
      '${targetPromptHeading}',
      '${targetPromptType}',
      '${targetPromptHash}'
    )
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('edit-job-reuse-judgment-article', 'Reuse judgment article')
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
      is_answered,
      answered_original
    )
    VALUES (
      'edit-job-reuse-judgment-active',
      'edit-job-reuse-judgment-article',
      '${targetPromptId}',
      '${modelId}',
      '${projectId}',
      TRUE,
      TRUE,
      FALSE,
      FALSE,
      TRUE,
      'yes'
    )
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('edit-job-reuse-judgment-job', '${projectId}', 'completed', 'draining')
  `)
  await insertJudgmentJobSqliteHealthProjectionFixture({jobId: 'edit-job-reuse-judgment-job'})

  const response = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}/edit`, {
      body: JSON.stringify({
        prompts: [
          {
            originalId: originalPromptId,
            originalText: targetPromptText,
            promptHeading: targetPromptHeading,
            type: targetPromptType,
            order: 7,
          },
        ],
      }),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const body = (await response.json()) as {
    data: {
      promptCleanupSummary: {
        changedPromptLinks: Array<{newPromptId: string | null; oldPromptId: string; projectPromptId: string}>
        deletedHumanPromptAnswers: number
      }
    }
  }

  expect(response.status).toBe(200)

  const [projectPromptRow] = await queryDatabase<{
    archived: boolean
    criteriaDisposition: string | null
    criteriaSectionKey: string | null
    criteriaSectionLabel: string | null
    enabled: boolean
    order: number
    promptHeading: string | null
    promptId: string
    type: string | null
  }>(`
    SELECT
      pp.prompt_id AS promptId,
      pp.prompt_order AS "order",
      pp.archived AS archived,
      pp.enabled AS enabled,
      pp.criteria_disposition AS criteriaDisposition,
      pp.criteria_section_key AS criteriaSectionKey,
      pp.criteria_section_label AS criteriaSectionLabel,
      p.prompt_heading AS promptHeading,
      p.type AS type
    FROM app.project_prompt pp
    INNER JOIN app.prompt p ON p.id = pp.prompt_id
    WHERE pp.project_id = '${projectId}'
    LIMIT 1
  `)
  const [targetPromptHashCount] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.prompt
    WHERE content_hash = '${targetPromptHash}'
  `)
  const [activeJudgmentCount] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.judgment
    WHERE id = 'edit-job-reuse-judgment-active'
      AND prompt_id = '${targetPromptId}'
      AND deleted_at IS NULL
  `)

  expect(projectPromptRow).toEqual({
    archived: true,
    criteriaDisposition: 'combined',
    criteriaSectionKey: 'eligibility',
    criteriaSectionLabel: 'Eligibility',
    enabled: false,
    order: 7,
    promptHeading: targetPromptHeading,
    promptId: targetPromptId,
    type: targetPromptType,
  })
  expect(body.data.promptCleanupSummary).toEqual({
    changedPromptLinks: [
      {
        newPromptId: targetPromptId,
        oldPromptId: originalPromptId,
        projectPromptId: 'edit-job-reuse-judgment-project-prompt',
        reason: 'replaced',
      },
    ],
    deletedHumanPromptAnswers: 0,
    keptSharedLlmJudgments: 0,
    skippedComparisonPromptReferencedJudgments: 0,
    softDeletedLlmJudgments: 0,
  })
  expect(Number(targetPromptHashCount?.count ?? 0)).toBe(1)
  expect(Number(activeJudgmentCount?.count ?? 0)).toBe(1)
})

test('edit route preserves judgments when a removed prompt is reused as a replacement target', async () => {
  if (!app || !queryDatabase || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'edit-job-reuse-removed-target-connection'
  const modelId = 'edit-job-reuse-removed-target-model'
  const projectId = 'edit-job-reuse-removed-target-project'
  const sourcePromptId = 'edit-job-reuse-removed-target-source-prompt'
  const targetPromptId = 'edit-job-reuse-removed-target-target-prompt'
  const sourcePromptText = 'Reuse removed target source prompt text'
  const targetPromptText = 'Reuse removed target target prompt text'

  await insertProjectFixture({connectionId, modelId, projectId})
  await insertProjectPromptFixture({
    contentHash: computePromptContentHash(sourcePromptText, null, 'source', 'string'),
    order: 0,
    originProjectId: projectId,
    originalText: sourcePromptText,
    projectId,
    projectPromptId: 'edit-job-reuse-removed-target-source-project-prompt',
    promptHeading: 'source',
    promptId: sourcePromptId,
    type: 'string',
  })
  await insertProjectPromptFixture({
    contentHash: computePromptContentHash(targetPromptText, null, 'target', 'string'),
    order: 1,
    originProjectId: projectId,
    originalText: targetPromptText,
    projectId,
    projectPromptId: 'edit-job-reuse-removed-target-target-project-prompt',
    promptHeading: 'target',
    promptId: targetPromptId,
    type: 'string',
  })
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('edit-job-reuse-removed-target-article', 'Reuse removed target article')
  `)
  await runDatabase(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES ('edit-job-reuse-removed-target-project-article', '${projectId}', 'edit-job-reuse-removed-target-article')
  `)
  await runDatabase(`
    INSERT INTO app.judgment_human (id, project_id, article_id, prompt_id, is_answered, answer)
    VALUES
      (
        'edit-job-reuse-removed-target-source-human',
        '${projectId}',
        'edit-job-reuse-removed-target-article',
        '${sourcePromptId}',
        TRUE,
        'yes'
      ),
      (
        'edit-job-reuse-removed-target-target-human',
        '${projectId}',
        'edit-job-reuse-removed-target-article',
        '${targetPromptId}',
        TRUE,
        'no'
      )
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
      is_answered,
      answered_original
    )
    VALUES (
      'edit-job-reuse-removed-target-target-judgment',
      'edit-job-reuse-removed-target-article',
      '${targetPromptId}',
      '${modelId}',
      '${projectId}',
      TRUE,
      TRUE,
      FALSE,
      FALSE,
      TRUE,
      'no'
    )
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('edit-job-reuse-removed-target-job', '${projectId}', 'completed', 'draining')
  `)
  await insertJudgmentJobSqliteHealthProjectionFixture({jobId: 'edit-job-reuse-removed-target-job'})

  const response = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}/edit`, {
      body: JSON.stringify({
        prompts: [
          {
            originalId: sourcePromptId,
            originalText: targetPromptText,
            promptHeading: 'target',
            type: 'string',
            order: 0,
          },
        ],
      }),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const body = (await response.json()) as {
    data: {
      promptCleanupSummary: {
        changedPromptLinks: Array<{newPromptId: string | null; oldPromptId: string; projectPromptId: string}>
        deletedHumanPromptAnswers: number
      }
    }
  }

  expect(response.status).toBe(200)
  expect(body.data.promptCleanupSummary).toEqual({
    changedPromptLinks: [
      {
        newPromptId: targetPromptId,
        oldPromptId: sourcePromptId,
        projectPromptId: 'edit-job-reuse-removed-target-source-project-prompt',
        reason: 'replaced',
      },
    ],
    deletedHumanPromptAnswers: 1,
    keptSharedLlmJudgments: 0,
    skippedComparisonPromptReferencedJudgments: 0,
    softDeletedLlmJudgments: 0,
  })

  const projectPromptRows = await queryDatabase<{order: number; promptId: string}>(`
    SELECT prompt_id AS promptId, CAST(prompt_order AS INTEGER) AS "order"
    FROM app.project_prompt
    WHERE project_id = '${projectId}'
    ORDER BY prompt_order ASC
  `)
  const [sourceHumanCount] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.judgment_human
    WHERE id = 'edit-job-reuse-removed-target-source-human'
  `)
  const [targetHumanCount] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.judgment_human
    WHERE id = 'edit-job-reuse-removed-target-target-human'
  `)
  const [targetJudgmentRow] = await queryDatabase<{deletedAt: string | null}>(`
    SELECT CAST(deleted_at AS VARCHAR) AS deletedAt
    FROM app.judgment
    WHERE id = 'edit-job-reuse-removed-target-target-judgment'
    LIMIT 1
  `)

  expect(projectPromptRows).toEqual([{order: 0, promptId: targetPromptId}])
  expect(Number(sourceHumanCount?.count ?? 0)).toBe(0)
  expect(Number(targetHumanCount?.count ?? 0)).toBe(1)
  expect(targetJudgmentRow?.deletedAt).toBe(null)
})

test('edit route keeps replacement targets that are also edited later in the same save', async () => {
  if (!app || !queryDatabase || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'edit-job-edited-target-connection'
  const modelId = 'edit-job-edited-target-model'
  const projectId = 'edit-job-edited-target-project'
  const sourcePromptId = 'edit-job-edited-target-source-prompt'
  const targetPromptId = 'edit-job-edited-target-target-prompt'
  const sourcePromptText = 'Edited target source prompt text'
  const targetPromptText = 'Edited target target prompt text'
  const newTargetPromptText = 'Edited target new prompt text'

  await insertProjectFixture({connectionId, modelId, projectId})
  await insertProjectPromptFixture({
    contentHash: computePromptContentHash(sourcePromptText, null, 'source', 'string'),
    order: 0,
    originProjectId: projectId,
    originalText: sourcePromptText,
    projectId,
    projectPromptId: 'edit-job-edited-target-source-project-prompt',
    promptHeading: 'source',
    promptId: sourcePromptId,
    type: 'string',
  })
  await insertProjectPromptFixture({
    contentHash: computePromptContentHash(targetPromptText, null, 'target', 'string'),
    order: 1,
    originProjectId: projectId,
    originalText: targetPromptText,
    projectId,
    projectPromptId: 'edit-job-edited-target-target-project-prompt',
    promptHeading: 'target',
    promptId: targetPromptId,
    type: 'string',
  })
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('edit-job-edited-target-article', 'Edited target article')
  `)
  await runDatabase(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES ('edit-job-edited-target-project-article', '${projectId}', 'edit-job-edited-target-article')
  `)
  await runDatabase(`
    INSERT INTO app.judgment_human (id, project_id, article_id, prompt_id, is_answered, answer)
    VALUES
      (
        'edit-job-edited-target-source-human',
        '${projectId}',
        'edit-job-edited-target-article',
        '${sourcePromptId}',
        TRUE,
        'yes'
      ),
      (
        'edit-job-edited-target-target-human',
        '${projectId}',
        'edit-job-edited-target-article',
        '${targetPromptId}',
        TRUE,
        'no'
      )
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
      is_answered,
      answered_original
    )
    VALUES (
      'edit-job-edited-target-target-judgment',
      'edit-job-edited-target-article',
      '${targetPromptId}',
      '${modelId}',
      '${projectId}',
      TRUE,
      TRUE,
      FALSE,
      FALSE,
      TRUE,
      'no'
    )
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('edit-job-edited-target-job', '${projectId}', 'completed', 'draining')
  `)
  await insertJudgmentJobSqliteHealthProjectionFixture({jobId: 'edit-job-edited-target-job'})

  const response = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}/edit`, {
      body: JSON.stringify({
        prompts: [
          {
            originalId: sourcePromptId,
            originalText: targetPromptText,
            promptHeading: 'target',
            type: 'string',
            order: 0,
          },
          {
            originalId: targetPromptId,
            originalText: newTargetPromptText,
            promptHeading: 'new target',
            type: 'string',
            order: 1,
          },
        ],
      }),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const body = (await response.json()) as {
    data: {
      promptCleanupSummary: {
        changedPromptLinks: Array<{newPromptId: string | null; oldPromptId: string; projectPromptId: string}>
        deletedHumanPromptAnswers: number
      }
    }
  }

  expect(response.status).toBe(200)
  expect(body.data.promptCleanupSummary).toEqual({
    changedPromptLinks: [
      {
        newPromptId: targetPromptId,
        oldPromptId: sourcePromptId,
        projectPromptId: 'edit-job-edited-target-source-project-prompt',
        reason: 'replaced',
      },
    ],
    deletedHumanPromptAnswers: 1,
    keptSharedLlmJudgments: 0,
    skippedComparisonPromptReferencedJudgments: 0,
    softDeletedLlmJudgments: 0,
  })

  const projectPromptRows = await queryDatabase<{order: number; originalText: string; promptId: string}>(`
    SELECT
      p.id AS promptId,
      p.original_text AS originalText,
      CAST(pp.prompt_order AS INTEGER) AS "order"
    FROM app.project_prompt pp
    INNER JOIN app.prompt p ON p.id = pp.prompt_id
    WHERE pp.project_id = '${projectId}'
    ORDER BY pp.prompt_order ASC
  `)
  const [sourceHumanCount] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.judgment_human
    WHERE id = 'edit-job-edited-target-source-human'
  `)
  const [targetHumanCount] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.judgment_human
    WHERE id = 'edit-job-edited-target-target-human'
  `)
  const [targetJudgmentRow] = await queryDatabase<{deletedAt: string | null}>(`
    SELECT CAST(deleted_at AS VARCHAR) AS deletedAt
    FROM app.judgment
    WHERE id = 'edit-job-edited-target-target-judgment'
    LIMIT 1
  `)

  expect(projectPromptRows[0]).toEqual({order: 0, originalText: targetPromptText, promptId: targetPromptId})
  expect(projectPromptRows[1]?.order).toBe(1)
  expect(projectPromptRows[1]?.originalText).toBe(newTargetPromptText)
  expect(projectPromptRows[1]?.promptId).not.toBe(targetPromptId)
  expect(Number(sourceHumanCount?.count ?? 0)).toBe(0)
  expect(Number(targetHumanCount?.count ?? 0)).toBe(1)
  expect(targetJudgmentRow?.deletedAt).toBe(null)
})

test('edit route removes safe prompt links and cleans only removed prompt human answers', async () => {
  if (!app || !queryDatabase || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'edit-job-remove-prompt-connection'
  const modelId = 'edit-job-remove-prompt-model'
  const projectId = 'edit-job-remove-prompt-project'
  const keptPromptId = 'edit-job-remove-prompt-kept'
  const removedPromptId = 'edit-job-remove-prompt-removed'
  const keptPromptText = 'Prompt removal kept text'
  const removedPromptText = 'Prompt removal removed text'

  await insertProjectFixture({connectionId, modelId, projectId})
  await insertProjectPromptFixture({
    contentHash: computePromptContentHash(keptPromptText, null, 'kept', 'string'),
    order: 0,
    originProjectId: projectId,
    originalText: keptPromptText,
    projectId,
    projectPromptId: 'edit-job-remove-prompt-kept-project-prompt',
    promptHeading: 'kept',
    promptId: keptPromptId,
    type: 'string',
  })
  await insertProjectPromptFixture({
    contentHash: computePromptContentHash(removedPromptText, null, 'removed', 'string'),
    order: 1,
    originProjectId: projectId,
    originalText: removedPromptText,
    projectId,
    projectPromptId: 'edit-job-remove-prompt-removed-project-prompt',
    promptHeading: 'removed',
    promptId: removedPromptId,
    type: 'string',
  })
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('edit-job-remove-prompt-article', 'Prompt removal article')
  `)
  await runDatabase(`
    INSERT INTO app.judgment_human (id, project_id, article_id, prompt_id, is_answered, answer)
    VALUES
      (
        'edit-job-remove-prompt-kept-human',
        '${projectId}',
        'edit-job-remove-prompt-article',
        '${keptPromptId}',
        TRUE,
        'yes'
      ),
      (
        'edit-job-remove-prompt-removed-human',
        '${projectId}',
        'edit-job-remove-prompt-article',
        '${removedPromptId}',
        TRUE,
        'no'
      )
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('edit-job-remove-prompt-job', '${projectId}', 'paused', 'draining')
  `)
  await insertJudgmentJobSqliteHealthProjectionFixture({jobId: 'edit-job-remove-prompt-job'})

  const response = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}/edit`, {
      body: JSON.stringify({
        prompts: [
          {originalId: keptPromptId, originalText: keptPromptText, promptHeading: 'kept', type: 'string', order: 0},
        ],
      }),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const body = (await response.json()) as {
    data: {
      promptCleanupSummary: {
        changedPromptLinks: Array<{
          newPromptId: string | null
          oldPromptId: string
          projectPromptId: string
          reason: string
        }>
        deletedHumanPromptAnswers: number
      }
    }
  }

  expect(response.status).toBe(200)
  expect(body.data.promptCleanupSummary).toEqual({
    changedPromptLinks: [
      {
        newPromptId: null,
        oldPromptId: removedPromptId,
        projectPromptId: 'edit-job-remove-prompt-removed-project-prompt',
        reason: 'removed',
      },
    ],
    deletedHumanPromptAnswers: 1,
    keptSharedLlmJudgments: 0,
    skippedComparisonPromptReferencedJudgments: 0,
    softDeletedLlmJudgments: 0,
  })

  const projectPromptRows = await queryDatabase<{promptId: string}>(`
    SELECT prompt_id AS promptId
    FROM app.project_prompt
    WHERE project_id = '${projectId}'
  `)
  const [keptHumanCount] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.judgment_human
    WHERE id = 'edit-job-remove-prompt-kept-human'
  `)
  const [removedHumanCount] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.judgment_human
    WHERE id = 'edit-job-remove-prompt-removed-human'
  `)

  expect(projectPromptRows).toEqual([{promptId: keptPromptId}])
  expect(Number(keptHumanCount?.count ?? 0)).toBe(1)
  expect(Number(removedHumanCount?.count ?? 0)).toBe(0)
})

test('edit route does not touch human summary judgments during judged prompt edits', async () => {
  if (!app || !queryDatabase || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'edit-job-summary-human-connection'
  const modelId = 'edit-job-summary-human-model'
  const projectId = 'edit-job-summary-human-project'
  const promptId = 'edit-job-summary-human-prompt'
  const articleId = 'edit-job-summary-human-article'
  const originalPromptText = 'Summary human original prompt'

  await insertProjectFixture({connectionId, humanJudgmentMode: 'summary', modelId, projectId})
  await insertProjectPromptFixture({
    contentHash: computePromptContentHash(originalPromptText, null, 'summary', 'string'),
    originProjectId: projectId,
    originalText: originalPromptText,
    projectId,
    projectPromptId: 'edit-job-summary-human-project-prompt',
    promptHeading: 'summary',
    promptId,
    type: 'string',
  })
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('${articleId}', 'Summary human article')
  `)
  await runDatabase(`
    INSERT INTO app.judgment_human_summary (id, project_id, article_id, answer, origin)
    VALUES ('edit-job-summary-human-judgment', '${projectId}', '${articleId}', 'yes', 'manual_override')
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('edit-job-summary-human-job', '${projectId}', 'completed', 'draining')
  `)
  await insertJudgmentJobSqliteHealthProjectionFixture({jobId: 'edit-job-summary-human-job'})

  const response = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}/edit`, {
      body: JSON.stringify({
        prompts: [
          {
            originalId: promptId,
            originalText: 'Summary human edited prompt',
            promptHeading: 'summary edited',
            type: 'string',
            order: 0,
          },
        ],
      }),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )

  expect(response.status).toBe(200)

  const summaryRows = await queryDatabase<{answer: string | null; articleId: string; origin: string}>(`
    SELECT answer, article_id AS articleId, origin
    FROM app.judgment_human_summary
    WHERE project_id = '${projectId}'
  `)

  expect(summaryRows).toEqual([{answer: 'yes', articleId, origin: 'manual_override'}])
})

test('edit route soft-deletes old prompt LLM judgments not used elsewhere and bumps delete generation', async () => {
  if (!app || !queryDatabase || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'edit-job-soft-delete-llm-connection'
  const modelId = 'edit-job-soft-delete-llm-model'
  const projectId = 'edit-job-soft-delete-llm-project'
  const oldPromptId = 'edit-job-soft-delete-llm-old-prompt'
  const oldPromptText = 'Soft delete old prompt text'
  const newPromptText = 'Soft delete new prompt text'

  await insertProjectFixture({connectionId, modelId, projectId})
  await insertProjectPromptFixture({
    contentHash: computePromptContentHash(oldPromptText, null, 'old', 'string'),
    originProjectId: projectId,
    originalText: oldPromptText,
    projectId,
    projectPromptId: 'edit-job-soft-delete-llm-project-prompt',
    promptHeading: 'old',
    promptId: oldPromptId,
    type: 'string',
  })
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('edit-job-soft-delete-llm-article', 'Soft delete LLM article')
  `)
  await runDatabase(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES ('edit-job-soft-delete-llm-project-article', '${projectId}', 'edit-job-soft-delete-llm-article')
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
      is_answered,
      answered_original
    )
    VALUES (
      'edit-job-soft-delete-llm-judgment',
      'edit-job-soft-delete-llm-article',
      '${oldPromptId}',
      '${modelId}',
      '${projectId}',
      TRUE,
      TRUE,
      FALSE,
      FALSE,
      TRUE,
      'yes'
    )
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('edit-job-soft-delete-llm-job', '${projectId}', 'completed', 'draining')
  `)
  await insertJudgmentJobSqliteHealthProjectionFixture({jobId: 'edit-job-soft-delete-llm-job'})

  const response = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}/edit`, {
      body: JSON.stringify({
        prompts: [
          {originalId: oldPromptId, originalText: newPromptText, promptHeading: 'new', type: 'string', order: 0},
        ],
      }),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const body = (await response.json()) as {data: {promptCleanupSummary: {softDeletedLlmJudgments: number}}}

  expect(response.status).toBe(200)
  expect(body.data.promptCleanupSummary.softDeletedLlmJudgments).toBe(1)

  const [judgmentRow] = await queryDatabase<{deleteGeneration: number; deletedAt: string | null}>(`
    SELECT CAST(delete_generation AS INTEGER) AS deleteGeneration, CAST(deleted_at AS VARCHAR) AS deletedAt
    FROM app.judgment
    WHERE id = 'edit-job-soft-delete-llm-judgment'
    LIMIT 1
  `)

  expect(judgmentRow?.deleteGeneration).toBe(1)
  expect(judgmentRow?.deletedAt).not.toBe(null)
})

test('edit route ignores already deleted old prompt LLM judgments during cleanup', async () => {
  if (!app || !queryDatabase || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'edit-job-ignore-deleted-llm-connection'
  const modelId = 'edit-job-ignore-deleted-llm-model'
  const projectId = 'edit-job-ignore-deleted-llm-project'
  const oldPromptId = 'edit-job-ignore-deleted-llm-old-prompt'
  const oldPromptText = 'Ignore deleted old prompt text'
  const newPromptText = 'Ignore deleted new prompt text'

  await insertProjectFixture({connectionId, modelId, projectId})
  await insertProjectPromptFixture({
    contentHash: computePromptContentHash(oldPromptText, null, 'old', 'string'),
    originProjectId: projectId,
    originalText: oldPromptText,
    projectId,
    projectPromptId: 'edit-job-ignore-deleted-llm-project-prompt',
    promptHeading: 'old',
    promptId: oldPromptId,
    type: 'string',
  })
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('edit-job-ignore-deleted-llm-article', 'Ignore deleted LLM article')
  `)
  await runDatabase(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES ('edit-job-ignore-deleted-llm-project-article', '${projectId}', 'edit-job-ignore-deleted-llm-article')
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
      is_answered,
      answered_original,
      deleted_at,
      delete_generation
    )
    VALUES (
      'edit-job-ignore-deleted-llm-judgment',
      'edit-job-ignore-deleted-llm-article',
      '${oldPromptId}',
      '${modelId}',
      '${projectId}',
      TRUE,
      TRUE,
      FALSE,
      FALSE,
      TRUE,
      'yes',
      TIMESTAMPTZ '2026-01-01T00:00:00.000Z',
      9
    )
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('edit-job-ignore-deleted-llm-job', '${projectId}', 'completed', 'draining')
  `)
  await insertJudgmentJobSqliteHealthProjectionFixture({jobId: 'edit-job-ignore-deleted-llm-job'})

  const response = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}/edit`, {
      body: JSON.stringify({
        prompts: [
          {originalId: oldPromptId, originalText: newPromptText, promptHeading: 'new', type: 'string', order: 0},
        ],
      }),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const body = (await response.json()) as {data: {promptCleanupSummary: {softDeletedLlmJudgments: number}}}

  expect(response.status).toBe(200)
  expect(body.data.promptCleanupSummary.softDeletedLlmJudgments).toBe(0)

  const [judgmentRow] = await queryDatabase<{deleteGeneration: number; deletedAt: string | null}>(`
    SELECT CAST(delete_generation AS INTEGER) AS deleteGeneration, CAST(deleted_at AS VARCHAR) AS deletedAt
    FROM app.judgment
    WHERE id = 'edit-job-ignore-deleted-llm-judgment'
    LIMIT 1
  `)

  expect(judgmentRow?.deleteGeneration).toBe(9)
  expect(judgmentRow?.deletedAt).toContain('2026-01-01')
})

test('edit route keeps old prompt LLM judgments used by another active curated project', async () => {
  if (!app || !queryDatabase || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'edit-job-keep-curated-llm-connection'
  const modelId = 'edit-job-keep-curated-llm-model'
  const projectId = 'edit-job-keep-curated-llm-project'
  const otherProjectId = 'edit-job-keep-curated-llm-other-project'
  const oldPromptId = 'edit-job-keep-curated-llm-old-prompt'
  const oldPromptText = 'Keep curated old prompt text'

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.project (
      id,
      name,
      model_id,
      human_judgment_mode,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images,
      archived
    )
    VALUES ('${otherProjectId}', 'Other curated keep project', '${modelId}', 'prompt', TRUE, TRUE, FALSE, FALSE, FALSE)
  `)
  await insertProjectPromptFixture({
    contentHash: computePromptContentHash(oldPromptText, null, 'old', 'string'),
    originProjectId: projectId,
    originalText: oldPromptText,
    projectId,
    projectPromptId: 'edit-job-keep-curated-llm-project-prompt',
    promptHeading: 'old',
    promptId: oldPromptId,
    type: 'string',
  })
  await runDatabase(`
    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, archived, enabled, origin_project_id)
    VALUES ('edit-job-keep-curated-llm-other-project-prompt', '${otherProjectId}', '${oldPromptId}', 0, FALSE, TRUE, NULL)
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('edit-job-keep-curated-llm-article', 'Keep curated LLM article')
  `)
  await runDatabase(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES
      ('edit-job-keep-curated-llm-project-article', '${projectId}', 'edit-job-keep-curated-llm-article'),
      ('edit-job-keep-curated-llm-other-project-article', '${otherProjectId}', 'edit-job-keep-curated-llm-article')
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
      is_answered,
      answered_original
    )
    VALUES (
      'edit-job-keep-curated-llm-judgment',
      'edit-job-keep-curated-llm-article',
      '${oldPromptId}',
      '${modelId}',
      '${projectId}',
      TRUE,
      TRUE,
      FALSE,
      FALSE,
      TRUE,
      'yes'
    )
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('edit-job-keep-curated-llm-job', '${projectId}', 'completed', 'draining')
  `)
  await insertJudgmentJobSqliteHealthProjectionFixture({jobId: 'edit-job-keep-curated-llm-job'})

  const response = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}/edit`, {
      body: JSON.stringify({
        prompts: [
          {
            originalId: oldPromptId,
            originalText: 'Keep curated new prompt text',
            promptHeading: 'new',
            type: 'string',
            order: 0,
          },
        ],
      }),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const body = (await response.json()) as {
    data: {promptCleanupSummary: {keptSharedLlmJudgments: number; softDeletedLlmJudgments: number}}
  }

  expect(response.status).toBe(200)
  expect(body.data.promptCleanupSummary.keptSharedLlmJudgments).toBe(1)
  expect(body.data.promptCleanupSummary.softDeletedLlmJudgments).toBe(0)

  const [judgmentRow] = await queryDatabase<{deletedAt: string | null}>(`
    SELECT CAST(deleted_at AS VARCHAR) AS deletedAt
    FROM app.judgment
    WHERE id = 'edit-job-keep-curated-llm-judgment'
    LIMIT 1
  `)

  expect(judgmentRow?.deletedAt).toBe(null)
})

test('edit route keeps old prompt LLM judgments referenced by an active comparison project', async () => {
  if (!app || !queryDatabase || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'edit-job-keep-comparison-llm-connection'
  const modelId = 'edit-job-keep-comparison-llm-model'
  const projectId = 'edit-job-keep-comparison-llm-project'
  const oldPromptId = 'edit-job-keep-comparison-llm-old-prompt'
  const oldPromptText = 'Keep comparison old prompt text'

  await insertProjectFixture({connectionId, modelId, projectId})
  await insertProjectPromptFixture({
    contentHash: computePromptContentHash(oldPromptText, null, 'old', 'string'),
    originProjectId: projectId,
    originalText: oldPromptText,
    projectId,
    projectPromptId: 'edit-job-keep-comparison-llm-project-prompt',
    promptHeading: 'old',
    promptId: oldPromptId,
    type: 'string',
  })
  await runDatabase(`
    INSERT INTO app.comparison_project (id, name, archived)
    VALUES ('edit-job-keep-comparison-project', 'Keep comparison project', FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.comparison_project_prompt (id, comparison_project_id, prompt_id, prompt_order)
    VALUES ('edit-job-keep-comparison-project-prompt', 'edit-job-keep-comparison-project', '${oldPromptId}', 0)
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('edit-job-keep-comparison-llm-article', 'Keep comparison LLM article')
  `)
  await runDatabase(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES ('edit-job-keep-comparison-llm-project-article', '${projectId}', 'edit-job-keep-comparison-llm-article')
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
      is_answered,
      answered_original
    )
    VALUES (
      'edit-job-keep-comparison-llm-judgment',
      'edit-job-keep-comparison-llm-article',
      '${oldPromptId}',
      '${modelId}',
      '${projectId}',
      TRUE,
      TRUE,
      FALSE,
      FALSE,
      TRUE,
      'yes'
    )
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('edit-job-keep-comparison-llm-job', '${projectId}', 'completed', 'draining')
  `)
  await insertJudgmentJobSqliteHealthProjectionFixture({jobId: 'edit-job-keep-comparison-llm-job'})

  const response = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}/edit`, {
      body: JSON.stringify({
        prompts: [
          {
            originalId: oldPromptId,
            originalText: 'Keep comparison new prompt text',
            promptHeading: 'new',
            type: 'string',
            order: 0,
          },
        ],
      }),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const body = (await response.json()) as {
    data: {promptCleanupSummary: {skippedComparisonPromptReferencedJudgments: number; softDeletedLlmJudgments: number}}
  }

  expect(response.status).toBe(200)
  expect(body.data.promptCleanupSummary.skippedComparisonPromptReferencedJudgments).toBe(1)
  expect(body.data.promptCleanupSummary.softDeletedLlmJudgments).toBe(0)

  const [judgmentRow] = await queryDatabase<{deletedAt: string | null}>(`
    SELECT CAST(deleted_at AS VARCHAR) AS deletedAt
    FROM app.judgment
    WHERE id = 'edit-job-keep-comparison-llm-judgment'
    LIMIT 1
  `)

  expect(judgmentRow?.deletedAt).toBe(null)
})

test('edit route marks active comparison serving stale after project prompt edits', async () => {
  if (!app || !queryDatabase || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'edit-job-comparison-serving-stale-connection'
  const modelId = 'edit-job-comparison-serving-stale-model'
  const projectId = 'edit-job-comparison-serving-stale-project'
  const oldPromptId = 'edit-job-comparison-serving-stale-old-prompt'
  const oldPromptText = 'Comparison serving stale old prompt text'
  const sourceComparisonId = 'edit-job-comparison-serving-stale-source-comparison'
  const summaryComparisonId = 'edit-job-comparison-serving-stale-summary-comparison'
  const archivedComparisonId = 'edit-job-comparison-serving-stale-archived-comparison'

  await insertProjectFixture({connectionId, modelId, projectId})
  await insertProjectPromptFixture({
    contentHash: computePromptContentHash(oldPromptText, null, 'old', 'string'),
    originProjectId: projectId,
    originalText: oldPromptText,
    projectId,
    projectPromptId: 'edit-job-comparison-serving-stale-project-prompt',
    promptHeading: 'old',
    promptId: oldPromptId,
    type: 'string',
  })
  await runDatabase(`
    INSERT INTO app.comparison_project (
      id,
      name,
      model_ids,
      compare_with_humans,
      summary_source_project_id,
      archived
    )
    VALUES
      ('${sourceComparisonId}', 'Source comparison', ['${modelId}'], FALSE, NULL, FALSE),
      ('${summaryComparisonId}', 'Summary comparison', ['${modelId}'], FALSE, '${projectId}', FALSE),
      ('${archivedComparisonId}', 'Archived comparison', ['${modelId}'], FALSE, NULL, TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.comparison_project_source_project (id, comparison_project_id, source_project_id)
    VALUES
      ('edit-job-comparison-serving-stale-source-link', '${sourceComparisonId}', '${projectId}'),
      ('edit-job-comparison-serving-stale-archived-link', '${archivedComparisonId}', '${projectId}')
  `)
  await runDatabase(`
    INSERT INTO app.comparison_project_serving_generation (
      comparison_project_id,
      active_generation,
      serving_status,
      serving_generation,
      serving_completed_at
    )
    VALUES
      ('${sourceComparisonId}', 1, 'ready', 1, current_timestamp),
      ('${summaryComparisonId}', 1, 'ready', 1, current_timestamp),
      ('${archivedComparisonId}', 1, 'ready', 1, current_timestamp)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('edit-job-comparison-serving-stale-job', '${projectId}', 'completed', 'draining')
  `)
  await insertJudgmentJobSqliteHealthProjectionFixture({jobId: 'edit-job-comparison-serving-stale-job'})

  const response = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}/edit`, {
      body: JSON.stringify({
        prompts: [
          {
            originalId: oldPromptId,
            originalText: 'Comparison serving stale new prompt text',
            promptHeading: 'new',
            type: 'string',
            order: 0,
          },
        ],
      }),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )

  expect(response.status).toBe(200)

  const servingRows = await queryDatabase<{
    comparisonProjectId: string
    servingGeneration: number | null
    servingStatus: string | null
  }>(`
    SELECT
      comparison_project_id AS comparisonProjectId,
      CAST(serving_generation AS INTEGER) AS servingGeneration,
      serving_status AS servingStatus
    FROM app.comparison_project_serving_generation
    WHERE comparison_project_id IN ('${sourceComparisonId}', '${summaryComparisonId}', '${archivedComparisonId}')
    ORDER BY comparison_project_id ASC
  `)

  expect(servingRows).toEqual([
    {comparisonProjectId: archivedComparisonId, servingGeneration: 1, servingStatus: 'ready'},
    {comparisonProjectId: sourceComparisonId, servingGeneration: null, servingStatus: 'stale'},
    {comparisonProjectId: summaryComparisonId, servingGeneration: null, servingStatus: 'stale'},
  ])
})

test('edit route keeps old prompt LLM judgments used by another active route-scoped project', async () => {
  if (!app || !queryDatabase || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'edit-job-keep-route-llm-connection'
  const modelId = 'edit-job-keep-route-llm-model'
  const projectId = 'edit-job-keep-route-llm-project'
  const otherProjectId = 'edit-job-keep-route-llm-other-project'
  const oldPromptId = 'edit-job-keep-route-llm-old-prompt'
  const oldPromptText = 'Keep route old prompt text'

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.project (
      id,
      name,
      model_id,
      human_judgment_mode,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images,
      archived
    )
    VALUES ('${otherProjectId}', 'Other route keep project', '${modelId}', 'prompt', TRUE, TRUE, FALSE, FALSE, FALSE)
  `)
  await insertProjectPromptFixture({
    contentHash: computePromptContentHash(oldPromptText, null, 'old', 'string'),
    originProjectId: projectId,
    originalText: oldPromptText,
    projectId,
    projectPromptId: 'edit-job-keep-route-llm-project-prompt',
    promptHeading: 'old',
    promptId: oldPromptId,
    type: 'string',
  })
  await runDatabase(`
    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, archived, enabled, origin_project_id)
    VALUES ('edit-job-keep-route-llm-other-project-prompt', '${otherProjectId}', '${oldPromptId}', 0, FALSE, TRUE, NULL)
  `)
  await runDatabase(`
    INSERT INTO app.import_route (id, route, name)
    VALUES ('edit-job-keep-route-llm-route', 'edit-job-keep-route-llm-route', 'Keep route')
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('edit-job-keep-route-llm-article', 'Keep route LLM article')
  `)
  await runDatabase(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES ('edit-job-keep-route-llm-project-article', '${projectId}', 'edit-job-keep-route-llm-article')
  `)
  await runDatabase(`
    INSERT INTO app.project_import_route (id, project_id, import_route_id)
    VALUES ('edit-job-keep-route-llm-other-project-route', '${otherProjectId}', 'edit-job-keep-route-llm-route')
  `)
  await runDatabase(`
    INSERT INTO app.article_import_route (id, article_id, import_route_id)
    VALUES ('edit-job-keep-route-llm-article-route', 'edit-job-keep-route-llm-article', 'edit-job-keep-route-llm-route')
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
      is_answered,
      answered_original
    )
    VALUES (
      'edit-job-keep-route-llm-judgment',
      'edit-job-keep-route-llm-article',
      '${oldPromptId}',
      '${modelId}',
      '${projectId}',
      TRUE,
      TRUE,
      FALSE,
      FALSE,
      TRUE,
      'yes'
    )
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('edit-job-keep-route-llm-job', '${projectId}', 'completed', 'draining')
  `)
  await insertJudgmentJobSqliteHealthProjectionFixture({jobId: 'edit-job-keep-route-llm-job'})

  const response = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}/edit`, {
      body: JSON.stringify({
        prompts: [
          {
            originalId: oldPromptId,
            originalText: 'Keep route new prompt text',
            promptHeading: 'new',
            type: 'string',
            order: 0,
          },
        ],
      }),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const body = (await response.json()) as {
    data: {promptCleanupSummary: {keptSharedLlmJudgments: number; softDeletedLlmJudgments: number}}
  }

  expect(response.status).toBe(200)
  expect(body.data.promptCleanupSummary.keptSharedLlmJudgments).toBe(1)
  expect(body.data.promptCleanupSummary.softDeletedLlmJudgments).toBe(0)

  const [judgmentRow] = await queryDatabase<{deletedAt: string | null}>(`
    SELECT CAST(deleted_at AS VARCHAR) AS deletedAt
    FROM app.judgment
    WHERE id = 'edit-job-keep-route-llm-judgment'
    LIMIT 1
  `)

  expect(judgmentRow?.deletedAt).toBe(null)
})

test('edit route respects other project date filters when checking shared old LLM usage', async () => {
  if (!app || !queryDatabase || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'edit-job-date-filter-llm-connection'
  const modelId = 'edit-job-date-filter-llm-model'
  const projectId = 'edit-job-date-filter-llm-project'
  const otherProjectId = 'edit-job-date-filter-llm-other-project'
  const oldPromptId = 'edit-job-date-filter-llm-old-prompt'
  const oldPromptText = 'Date filter old prompt text'

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.project (
      id,
      name,
      model_id,
      human_judgment_mode,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images,
      date_from,
      archived
    )
    VALUES (
      '${otherProjectId}',
      'Other date-filter keep project',
      '${modelId}',
      'prompt',
      TRUE,
      TRUE,
      FALSE,
      FALSE,
      TIMESTAMPTZ '2027-01-01T00:00:00.000Z',
      FALSE
    )
  `)
  await insertProjectPromptFixture({
    contentHash: computePromptContentHash(oldPromptText, null, 'old', 'string'),
    originProjectId: projectId,
    originalText: oldPromptText,
    projectId,
    projectPromptId: 'edit-job-date-filter-llm-project-prompt',
    promptHeading: 'old',
    promptId: oldPromptId,
    type: 'string',
  })
  await runDatabase(`
    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, archived, enabled, origin_project_id)
    VALUES ('edit-job-date-filter-llm-other-project-prompt', '${otherProjectId}', '${oldPromptId}', 0, FALSE, TRUE, NULL)
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_title, article_created_at)
    VALUES ('edit-job-date-filter-llm-article', 'Date filter LLM article', TIMESTAMPTZ '2026-01-01T00:00:00.000Z')
  `)
  await runDatabase(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES
      ('edit-job-date-filter-llm-project-article', '${projectId}', 'edit-job-date-filter-llm-article'),
      ('edit-job-date-filter-llm-other-project-article', '${otherProjectId}', 'edit-job-date-filter-llm-article')
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
      is_answered,
      answered_original
    )
    VALUES (
      'edit-job-date-filter-llm-judgment',
      'edit-job-date-filter-llm-article',
      '${oldPromptId}',
      '${modelId}',
      '${projectId}',
      TRUE,
      TRUE,
      FALSE,
      FALSE,
      TRUE,
      'yes'
    )
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('edit-job-date-filter-llm-job', '${projectId}', 'completed', 'draining')
  `)
  await insertJudgmentJobSqliteHealthProjectionFixture({jobId: 'edit-job-date-filter-llm-job'})

  const response = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}/edit`, {
      body: JSON.stringify({
        prompts: [
          {
            originalId: oldPromptId,
            originalText: 'Date filter new prompt text',
            promptHeading: 'new',
            type: 'string',
            order: 0,
          },
        ],
      }),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const body = (await response.json()) as {
    data: {promptCleanupSummary: {keptSharedLlmJudgments: number; softDeletedLlmJudgments: number}}
  }

  expect(response.status).toBe(200)
  expect(body.data.promptCleanupSummary.keptSharedLlmJudgments).toBe(0)
  expect(body.data.promptCleanupSummary.softDeletedLlmJudgments).toBe(1)

  const [judgmentRow] = await queryDatabase<{deletedAt: string | null}>(`
    SELECT CAST(deleted_at AS VARCHAR) AS deletedAt
    FROM app.judgment
    WHERE id = 'edit-job-date-filter-llm-judgment'
    LIMIT 1
  `)

  expect(judgmentRow?.deletedAt).not.toBe(null)
})

test('edit route soft-deletes old prompt LLM judgments used only by archived projects', async () => {
  if (!app || !queryDatabase || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'edit-job-archived-keep-llm-connection'
  const modelId = 'edit-job-archived-keep-llm-model'
  const projectId = 'edit-job-archived-keep-llm-project'
  const archivedProjectId = 'edit-job-archived-keep-llm-archived-project'
  const oldPromptId = 'edit-job-archived-keep-llm-old-prompt'
  const oldPromptText = 'Archived keep old prompt text'

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.project (
      id,
      name,
      model_id,
      human_judgment_mode,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images,
      archived
    )
    VALUES ('${archivedProjectId}', 'Archived old prompt user', '${modelId}', 'prompt', TRUE, TRUE, FALSE, FALSE, TRUE)
  `)
  await insertProjectPromptFixture({
    contentHash: computePromptContentHash(oldPromptText, null, 'old', 'string'),
    originProjectId: projectId,
    originalText: oldPromptText,
    projectId,
    projectPromptId: 'edit-job-archived-keep-llm-project-prompt',
    promptHeading: 'old',
    promptId: oldPromptId,
    type: 'string',
  })
  await runDatabase(`
    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, archived, enabled, origin_project_id)
    VALUES ('edit-job-archived-keep-llm-archived-project-prompt', '${archivedProjectId}', '${oldPromptId}', 0, FALSE, TRUE, NULL)
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('edit-job-archived-keep-llm-article', 'Archived keep LLM article')
  `)
  await runDatabase(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES
      ('edit-job-archived-keep-llm-project-article', '${projectId}', 'edit-job-archived-keep-llm-article'),
      ('edit-job-archived-keep-llm-archived-project-article', '${archivedProjectId}', 'edit-job-archived-keep-llm-article')
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
      is_answered,
      answered_original
    )
    VALUES (
      'edit-job-archived-keep-llm-judgment',
      'edit-job-archived-keep-llm-article',
      '${oldPromptId}',
      '${modelId}',
      '${projectId}',
      TRUE,
      TRUE,
      FALSE,
      FALSE,
      TRUE,
      'yes'
    )
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('edit-job-archived-keep-llm-job', '${projectId}', 'completed', 'draining')
  `)
  await insertJudgmentJobSqliteHealthProjectionFixture({jobId: 'edit-job-archived-keep-llm-job'})

  const response = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}/edit`, {
      body: JSON.stringify({
        prompts: [
          {
            originalId: oldPromptId,
            originalText: 'Archived keep new prompt text',
            promptHeading: 'new',
            type: 'string',
            order: 0,
          },
        ],
      }),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const body = (await response.json()) as {
    data: {promptCleanupSummary: {keptSharedLlmJudgments: number; softDeletedLlmJudgments: number}}
  }

  expect(response.status).toBe(200)
  expect(body.data.promptCleanupSummary.keptSharedLlmJudgments).toBe(0)
  expect(body.data.promptCleanupSummary.softDeletedLlmJudgments).toBe(1)

  const [judgmentRow] = await queryDatabase<{deletedAt: string | null}>(`
    SELECT CAST(deleted_at AS VARCHAR) AS deletedAt
    FROM app.judgment
    WHERE id = 'edit-job-archived-keep-llm-judgment'
    LIMIT 1
  `)

  expect(judgmentRow?.deletedAt).not.toBe(null)
})

test('edit route allows safe prompt reorder without deleting LLM or human judgments', async () => {
  if (!app || !queryDatabase || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'edit-job-reorder-connection'
  const modelId = 'edit-job-reorder-model'
  const projectId = 'edit-job-reorder-project'
  const firstPromptId = 'edit-job-reorder-first-prompt'
  const secondPromptId = 'edit-job-reorder-second-prompt'
  const firstPromptText = 'Reorder first prompt text'
  const secondPromptText = 'Reorder second prompt text'

  await insertProjectFixture({connectionId, modelId, projectId})
  await insertProjectPromptFixture({
    contentHash: computePromptContentHash(firstPromptText, null, 'first', 'string'),
    order: 0,
    originProjectId: projectId,
    originalText: firstPromptText,
    projectId,
    projectPromptId: 'edit-job-reorder-first-project-prompt',
    promptHeading: 'first',
    promptId: firstPromptId,
    type: 'string',
  })
  await insertProjectPromptFixture({
    contentHash: computePromptContentHash(secondPromptText, null, 'second', 'string'),
    order: 1,
    originProjectId: projectId,
    originalText: secondPromptText,
    projectId,
    projectPromptId: 'edit-job-reorder-second-project-prompt',
    promptHeading: 'second',
    promptId: secondPromptId,
    type: 'string',
  })
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('edit-job-reorder-article', 'Reorder article')
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
      is_answered,
      answered_original
    )
    VALUES
      (
        'edit-job-reorder-first-judgment',
        'edit-job-reorder-article',
        '${firstPromptId}',
        '${modelId}',
        '${projectId}',
        TRUE,
        TRUE,
        FALSE,
        FALSE,
        TRUE,
        'yes'
      ),
      (
        'edit-job-reorder-second-judgment',
        'edit-job-reorder-article',
        '${secondPromptId}',
        '${modelId}',
        '${projectId}',
        TRUE,
        TRUE,
        FALSE,
        FALSE,
        TRUE,
        'no'
      )
  `)
  await runDatabase(`
    INSERT INTO app.judgment_human (id, project_id, article_id, prompt_id, is_answered, answer)
    VALUES
      (
        'edit-job-reorder-first-human',
        '${projectId}',
        'edit-job-reorder-article',
        '${firstPromptId}',
        TRUE,
        'yes'
      ),
      (
        'edit-job-reorder-second-human',
        '${projectId}',
        'edit-job-reorder-article',
        '${secondPromptId}',
        TRUE,
        'no'
      )
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('edit-job-reorder-job', '${projectId}', 'paused', 'draining')
  `)
  await insertJudgmentJobSqliteHealthProjectionFixture({jobId: 'edit-job-reorder-job'})

  const response = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}/edit`, {
      body: JSON.stringify({
        prompts: [
          {originalId: firstPromptId, originalText: firstPromptText, promptHeading: 'first', type: 'string', order: 1},
          {
            originalId: secondPromptId,
            originalText: secondPromptText,
            promptHeading: 'second',
            type: 'string',
            order: 0,
          },
        ],
      }),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const body = (await response.json()) as {
    data: {promptCleanupSummary: {changedPromptLinks: unknown[]; deletedHumanPromptAnswers: number}}
  }

  expect(response.status).toBe(200)
  expect(body.data.promptCleanupSummary).toEqual({
    changedPromptLinks: [],
    deletedHumanPromptAnswers: 0,
    keptSharedLlmJudgments: 0,
    skippedComparisonPromptReferencedJudgments: 0,
    softDeletedLlmJudgments: 0,
  })

  const projectPromptRows = await queryDatabase<{order: number; promptId: string}>(`
    SELECT prompt_id AS promptId, prompt_order AS "order"
    FROM app.project_prompt
    WHERE project_id = '${projectId}'
    ORDER BY prompt_order ASC
  `)
  const [judgmentCount] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.judgment
    WHERE id IN ('edit-job-reorder-first-judgment', 'edit-job-reorder-second-judgment')
      AND deleted_at IS NULL
  `)
  const [humanJudgmentCount] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.judgment_human
    WHERE id IN ('edit-job-reorder-first-human', 'edit-job-reorder-second-human')
  `)

  expect(projectPromptRows).toEqual([
    {order: 0, promptId: secondPromptId},
    {order: 1, promptId: firstPromptId},
  ])
  expect(Number(judgmentCount?.count ?? 0)).toBe(2)
  expect(Number(humanJudgmentCount?.count ?? 0)).toBe(2)
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
  const [materializationState] = await queryDatabase<{
    expectedRowCount: number
    materializationStatus: string
    projectId: string
    targetDirtyToken: number
  }>(`
    SELECT
      project_id AS projectId,
      CAST(target_dirty_token AS INTEGER) AS targetDirtyToken,
      materialization_status AS materializationStatus,
      CAST(source_scope_expected_row_count AS INTEGER) AS expectedRowCount
    FROM app.project_mart_dirty_materialization_state
    WHERE project_id = '${projectId}'
    LIMIT 1
  `)

  expect(Number(storedProjectArticle?.count ?? 0)).toBe(1)
  expect(refreshState).toEqual({dirtyToken: 1, projectId})
  expect(materializationState).toEqual({
    expectedRowCount: 1,
    materializationStatus: 'pending',
    projectId,
    targetDirtyToken: 1,
  })

  await flushMartRefreshes()
})

test('edit route rejects duplicate resolved target prompt ids before mutating links', async () => {
  if (!app || !queryDatabase || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'edit-duplicate-target-connection'
  const modelId = 'edit-duplicate-target-model'
  const projectId = 'edit-duplicate-target-project'
  const originalPromptId = 'edit-duplicate-target-original-prompt'
  const existingTargetPromptId = 'edit-duplicate-target-existing-prompt'
  const originalPromptText = 'Original duplicate target prompt text'
  const targetPromptText = 'Shared duplicate target prompt text'
  const targetPromptHeading = 'Shared duplicate target heading'
  const targetPromptType = 'string'

  await insertProjectFixture({connectionId, modelId, projectId})
  await insertProjectPromptFixture({
    contentHash: computePromptContentHash(
      originalPromptText,
      null,
      'Original duplicate target heading',
      targetPromptType,
    ),
    originProjectId: projectId,
    originalText: originalPromptText,
    projectId,
    projectPromptId: 'edit-duplicate-target-original-project-prompt',
    promptHeading: 'Original duplicate target heading',
    promptId: originalPromptId,
    type: targetPromptType,
  })
  await insertProjectPromptFixture({
    contentHash: computePromptContentHash(targetPromptText, null, targetPromptHeading, targetPromptType),
    originProjectId: projectId,
    order: 1,
    originalText: targetPromptText,
    projectId,
    projectPromptId: 'edit-duplicate-target-existing-project-prompt',
    promptHeading: targetPromptHeading,
    promptId: existingTargetPromptId,
    type: targetPromptType,
  })

  const response = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}/edit`, {
      body: JSON.stringify({
        name: 'Duplicate target edit should not persist',
        description: null,
        prompts: [
          {
            originalId: originalPromptId,
            originalText: targetPromptText,
            promptHeading: targetPromptHeading,
            type: targetPromptType,
            order: 0,
            enabled: true,
          },
          {
            originalId: existingTargetPromptId,
            originalText: targetPromptText,
            promptHeading: targetPromptHeading,
            type: targetPromptType,
            order: 1,
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
  expect(response.status).toBe(400)
  expect(await response.text()).toContain('unique prompt content')

  const promptRows = await queryDatabase<{order: number; originalText: string; promptId: string}>(`
    SELECT
      pp.prompt_id AS promptId,
      CAST(pp.prompt_order AS INTEGER) AS "order",
      p.original_text AS originalText
    FROM app.project_prompt pp
    INNER JOIN app.prompt p ON p.id = pp.prompt_id
    WHERE pp.project_id = '${projectId}'
    ORDER BY pp.prompt_order ASC
  `)
  const [projectRow] = await queryDatabase<{name: string}>(`
    SELECT name
    FROM app.project
    WHERE id = '${projectId}'
    LIMIT 1
  `)

  expect(promptRows).toEqual([
    {order: 0, originalText: originalPromptText, promptId: originalPromptId},
    {order: 1, originalText: targetPromptText, promptId: existingTargetPromptId},
  ])
  expect(projectRow?.name).toBe('Archive Regression Project')
})

test('edit route can clear prompt heading and type immutably', async () => {
  if (!app || !queryDatabase || !runDatabase || !flushMartRefreshes) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'edit-clear-prompt-metadata-connection'
  const modelId = 'edit-clear-prompt-metadata-model'
  const projectId = 'edit-clear-prompt-metadata-project'
  const originalPromptId = 'edit-clear-prompt-metadata-original-prompt'
  const originalPromptText = 'Prompt metadata clearing text'
  const originalPromptHeading = 'Prompt metadata heading'
  const originalPromptType = 'string'

  await insertProjectFixture({connectionId, modelId, projectId})
  await insertProjectPromptFixture({
    contentHash: computePromptContentHash(originalPromptText, null, originalPromptHeading, originalPromptType),
    originProjectId: projectId,
    originalText: originalPromptText,
    projectId,
    projectPromptId: 'edit-clear-prompt-metadata-project-prompt',
    promptHeading: originalPromptHeading,
    promptId: originalPromptId,
    type: originalPromptType,
  })

  const response = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}/edit`, {
      body: JSON.stringify({
        name: 'Clear prompt metadata project',
        description: null,
        prompts: [
          {
            originalId: originalPromptId,
            originalText: originalPromptText,
            promptHeading: '',
            type: '',
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

  const [linkedPromptRow] = await queryDatabase<{promptHeading: string | null; promptId: string; type: string | null}>(`
    SELECT
      p.id AS promptId,
      p.prompt_heading AS promptHeading,
      p.type AS type
    FROM app.project_prompt pp
    INNER JOIN app.prompt p ON p.id = pp.prompt_id
    WHERE pp.project_id = '${projectId}'
    LIMIT 1
  `)
  const [originalPromptRow] = await queryDatabase<{promptHeading: string | null; type: string | null}>(`
    SELECT prompt_heading AS promptHeading, type
    FROM app.prompt
    WHERE id = '${originalPromptId}'
    LIMIT 1
  `)

  expect(linkedPromptRow?.promptId).not.toBe(originalPromptId)
  expect(linkedPromptRow?.promptHeading).toBe(null)
  expect(linkedPromptRow?.type).toBe(null)
  expect(originalPromptRow).toEqual({promptHeading: originalPromptHeading, type: originalPromptType})

  await flushMartRefreshes()
})

test('edit route can change human judgment mode', async () => {
  if (!app || !queryDatabase || !flushMartRefreshes || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'edit-human-mode-connection'
  const modelId = 'edit-human-mode-model'
  const projectId = 'edit-human-mode-project'

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('edit-human-mode-article', 'Edit human mode article')
  `)
  await runDatabase(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES ('edit-human-mode-project-article', '${projectId}', 'edit-human-mode-article')
  `)

  const response = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}/edit`, {
      body: JSON.stringify({humanJudgmentMode: 'summary'}),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const body = (await response.json()) as {data: {project: {humanJudgmentMode: string | null}}}

  expect(response.status).toBe(200)
  expect(body.data.project.humanJudgmentMode).toBe('summary')

  const [storedProject] = await queryDatabase<{humanJudgmentMode: string | null}>(`
    SELECT human_judgment_mode AS humanJudgmentMode
    FROM app.project
    WHERE id = '${projectId}'
    LIMIT 1
  `)

  expect(storedProject?.humanJudgmentMode).toBe('summary')

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

test('edit route can change the model when summary judgments and large rebuild state reference the project', async () => {
  if (!app || !queryDatabase || !runDatabase || !flushMartRefreshes) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'edit-switch-model-summary-connection'
  const initialModelId = 'edit-switch-model-summary-initial'
  const nextModelId = 'edit-switch-model-summary-next'
  const projectId = 'edit-switch-model-summary-project'
  const articleId = 'edit-switch-model-summary-article'

  await insertProjectFixture({connectionId, modelId: initialModelId, projectId})
  await runDatabase(`
    UPDATE app.project
    SET human_judgment_mode = 'summary'
    WHERE id = '${projectId}'
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${nextModelId}', '${connectionId}', 'Qwen/Qwen3.5-32B', 'Qwen/Qwen3.5-32B', 'Qwen 32B', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('${articleId}', 'Edit switch model summary article')
  `)
  await runDatabase(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES ('edit-switch-model-summary-project-article', '${projectId}', '${articleId}')
  `)
  await runDatabase(`
    INSERT INTO app.judgment_human_summary (id, project_id, article_id, answer, origin)
    VALUES ('edit-switch-model-summary-judgment', '${projectId}', '${articleId}', 'yes', 'manual_override')
  `)
  await runDatabase(`
    INSERT INTO app.project_mart_large_rebuild_state (project_id)
    VALUES ('${projectId}')
  `)

  const response = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}/edit`, {
      body: JSON.stringify({
        name: 'Project with switched model and summary state',
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
  expect(body.data.project.name).toBe('Project with switched model and summary state')

  const [storedProject] = await queryDatabase<{modelId: string}>(`
    SELECT model_id AS modelId
    FROM app.project
    WHERE id = '${projectId}'
    LIMIT 1
  `)
  const [storedSummaryCount] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.judgment_human_summary
    WHERE project_id = '${projectId}'
  `)
  const [storedLargeRebuildState] = await queryDatabase<{projectId: string}>(`
    SELECT project_id AS projectId
    FROM app.project_mart_large_rebuild_state
    WHERE project_id = '${projectId}'
    LIMIT 1
  `)

  expect(storedProject?.modelId).toBe(nextModelId)
  expect(Number(storedSummaryCount?.count ?? 0)).toBe(1)
  expect(storedLargeRebuildState?.projectId).toBe(projectId)

  await flushMartRefreshes()
})

test('clone route reuses prompt ids and hides duplicate importable prompts', async () => {
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
  expect(clonedPromptRows[0]?.promptId).toBe(sourcePromptRows[0]?.promptId)
  expect(clonedPromptRows[0]?.originalText).toBe(sourcePromptRows[0]?.originalText)
  expect(clonedPromptRows[0]?.promptHeading).toBe(sourcePromptRows[0]?.promptHeading)
  expect(clonedPromptRows[0]?.contentHash).toBe(sourcePromptRows[0]?.contentHash)
  expect(clonedPromptRows[0]?.originProjectId).toBe(null)

  const detailsResponse = await app.handle(new Request(`http://localhost/api/projects/${clonedProjectId}`))
  const detailsBody = (await detailsResponse.json()) as {
    data: {prompts: Array<{id: string; linkedToProject: boolean; originalText: string; originProjectId: string | null}>}
  }
  const matchingPrompts = detailsBody.data.prompts.filter((prompt) => {
    return prompt.originalText === 'Is this about AI?'
  })
  const unrelatedPrompts = detailsBody.data.prompts.filter((prompt) => {
    return prompt.originalText === 'Unrelated prompt'
  })

  expect(detailsResponse.status).toBe(200)
  expect(matchingPrompts.length).toBe(1)
  expect(matchingPrompts[0]?.originProjectId).toBe(null)
  expect(matchingPrompts[0]?.linkedToProject).toBe(true)
  expect(unrelatedPrompts.length).toBe(1)
  expect(unrelatedPrompts[0]?.originProjectId).toBe(null)
  expect(unrelatedPrompts[0]?.linkedToProject).toBe(false)

  await flushMartRefreshes()
})

test('clone route preserves summary mode criteria and human summary judgments', async () => {
  if (!app || !queryDatabase || !runDatabase || !flushMartRefreshes) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'clone-summary-connection'
  const modelId = 'clone-summary-model'
  const projectId = 'clone-summary-project'
  const articleId = 'clone-summary-article'

  await insertProjectFixture({connectionId, humanJudgmentMode: 'summary', modelId, projectId})
  await insertProjectPromptFixture({
    contentHash: 'clone-summary-hash-include',
    criteriaDisposition: 'include',
    criteriaSectionKey: 'population',
    criteriaSectionLabel: 'Population',
    order: 0,
    originProjectId: projectId,
    originalText: 'Include prompt',
    projectId,
    projectPromptId: 'clone-summary-project-prompt-include',
    promptHeading: 'Include heading',
    promptId: 'clone-summary-prompt-include',
    type: 'string',
  })
  await insertProjectPromptFixture({
    contentHash: 'clone-summary-hash-exclude',
    criteriaDisposition: 'exclude',
    criteriaSectionKey: 'outcome',
    criteriaSectionLabel: 'Outcome',
    order: 1,
    originProjectId: projectId,
    originalText: 'Exclude prompt',
    projectId,
    projectPromptId: 'clone-summary-project-prompt-exclude',
    promptHeading: 'Exclude heading',
    promptId: 'clone-summary-prompt-exclude',
    type: 'string',
  })
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('${articleId}', 'Clone summary article')
  `)
  await runDatabase(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES ('clone-summary-project-article', '${projectId}', '${articleId}')
  `)
  await runDatabase(`
    INSERT INTO app.judgment_human_summary (id, project_id, article_id, answer, origin)
    VALUES ('clone-summary-judgment', '${projectId}', '${articleId}', 'yes', 'covidence_import')
  `)

  const cloneResponse = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}/clone`, {method: 'POST'}),
  )
  const cloneBody = (await cloneResponse.json()) as {data: {humanJudgmentMode: string | null; id: string}}
  const clonedProjectId = cloneBody.data.id

  expect(cloneResponse.status).toBe(200)
  expect(cloneBody.data.humanJudgmentMode).toBe('summary')

  const [storedProject] = await queryDatabase<{humanJudgmentMode: string | null}>(`
    SELECT human_judgment_mode AS humanJudgmentMode
    FROM app.project
    WHERE id = '${clonedProjectId}'
    LIMIT 1
  `)
  const clonedPromptRows = await queryDatabase<{
    criteriaDisposition: string | null
    criteriaSectionKey: string | null
    criteriaSectionLabel: string | null
    originProjectId: string | null
    promptHeading: string | null
  }>(`
    SELECT
      pp.criteria_disposition AS criteriaDisposition,
      pp.criteria_section_key AS criteriaSectionKey,
      pp.criteria_section_label AS criteriaSectionLabel,
      pp.origin_project_id AS originProjectId,
      p.prompt_heading AS promptHeading
    FROM app.project_prompt pp
    INNER JOIN app.prompt p ON p.id = pp.prompt_id
    WHERE pp.project_id = '${clonedProjectId}'
    ORDER BY pp.prompt_order ASC
  `)
  const clonedSummaryRows = await queryDatabase<{answer: string | null; articleId: string; origin: string}>(`
    SELECT answer, article_id AS articleId, origin
    FROM app.judgment_human_summary
    WHERE project_id = '${clonedProjectId}'
    ORDER BY article_id ASC
  `)

  expect(storedProject?.humanJudgmentMode).toBe('summary')
  expect(clonedPromptRows).toEqual([
    {
      criteriaDisposition: 'include',
      criteriaSectionKey: 'population',
      criteriaSectionLabel: 'Population',
      originProjectId: null,
      promptHeading: 'Include heading',
    },
    {
      criteriaDisposition: 'exclude',
      criteriaSectionKey: 'outcome',
      criteriaSectionLabel: 'Outcome',
      originProjectId: null,
      promptHeading: 'Exclude heading',
    },
  ])
  expect(clonedSummaryRows).toEqual([{answer: 'yes', articleId, origin: 'covidence_import'}])

  await flushMartRefreshes()
})

test('editing a cloned summary project prompt preserves summary criteria metadata', async () => {
  if (!app || !queryDatabase || !runDatabase || !flushMartRefreshes) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'clone-summary-edit-criteria-connection'
  const modelId = 'clone-summary-edit-criteria-model'
  const sourceProjectId = 'clone-summary-edit-criteria-source'
  const originalPromptId = 'clone-summary-edit-criteria-prompt-original'
  const originalPromptText = 'Original summary inclusion prompt'
  const editedPromptText = 'Edited summary inclusion prompt'
  const promptHeading = 'Population include'
  const type = "'yes' | 'no' | 'maybe'"

  await insertProjectFixture({connectionId, humanJudgmentMode: 'summary', modelId, projectId: sourceProjectId})
  await insertProjectPromptFixture({
    contentHash: computePromptContentHash(originalPromptText, null, promptHeading, type),
    criteriaDisposition: 'include',
    criteriaSectionKey: 'population',
    criteriaSectionLabel: 'Population',
    order: 0,
    originProjectId: sourceProjectId,
    originalText: originalPromptText,
    projectId: sourceProjectId,
    projectPromptId: 'clone-summary-edit-criteria-project-prompt-original',
    promptHeading,
    promptId: originalPromptId,
    type,
  })

  const cloneResponse = await app.handle(
    new Request(`http://localhost/api/projects/${sourceProjectId}/clone`, {method: 'POST'}),
  )
  const cloneBodyText = await cloneResponse.text()

  if (cloneResponse.status !== 200) {
    throw new Error(cloneBodyText)
  }

  const cloneBody = JSON.parse(cloneBodyText) as {data: {id: string}}
  const clonedProjectId = cloneBody.data.id

  expect(cloneResponse.status).toBe(200)

  const editResponse = await app.handle(
    new Request(`http://localhost/api/projects/${clonedProjectId}/edit`, {
      body: JSON.stringify({
        name: 'Clone with edited summary prompt',
        description: null,
        prompts: [
          {originalId: originalPromptId, originalText: editedPromptText, promptHeading, type, order: 0, enabled: true},
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

  expect(editResponse.status).toBe(200)

  const promptRows = await queryDatabase<{
    criteriaDisposition: string | null
    criteriaSectionKey: string | null
    criteriaSectionLabel: string | null
    originalText: string
    projectId: string
    promptId: string
  }>(`
    SELECT
      pp.project_id AS projectId,
      pp.prompt_id AS promptId,
      pp.criteria_disposition AS criteriaDisposition,
      pp.criteria_section_key AS criteriaSectionKey,
      pp.criteria_section_label AS criteriaSectionLabel,
      p.original_text AS originalText
    FROM app.project_prompt pp
    INNER JOIN app.prompt p ON p.id = pp.prompt_id
    WHERE pp.project_id IN ('${sourceProjectId}', '${clonedProjectId}')
    ORDER BY pp.project_id ASC
  `)
  const sourcePromptRow = promptRows.find((row) => {
    return row.projectId === sourceProjectId
  })
  const clonedPromptRow = promptRows.find((row) => {
    return row.projectId === clonedProjectId
  })

  expect(sourcePromptRow).toEqual({
    criteriaDisposition: 'include',
    criteriaSectionKey: 'population',
    criteriaSectionLabel: 'Population',
    originalText: originalPromptText,
    projectId: sourceProjectId,
    promptId: originalPromptId,
  })
  expect(clonedPromptRow?.promptId).not.toBe(originalPromptId)
  expect(clonedPromptRow?.criteriaDisposition).toBe('include')
  expect(clonedPromptRow?.criteriaSectionKey).toBe('population')
  expect(clonedPromptRow?.criteriaSectionLabel).toBe('Population')
  expect(clonedPromptRow?.originalText).toBe(editedPromptText)
  expect(clonedPromptRow?.projectId).toBe(clonedProjectId)

  await flushMartRefreshes()
})

test('editing a cloned project prompt keeps source prompt links and judgments isolated', async () => {
  if (!app || !queryDatabase || !runDatabase || !flushMartRefreshes) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'clone-edit-prompt-isolation-connection'
  const modelId = 'clone-edit-prompt-isolation-model'
  const sourceProjectId = 'clone-edit-prompt-isolation-source'
  const articleId = 'clone-edit-prompt-isolation-article'
  const originalPromptId = 'clone-edit-prompt-isolation-prompt-original'
  const originalPromptText = 'Original screening prompt'
  const editedPromptText = 'Edited clone screening prompt'
  const promptHeading = 'Eligibility'
  const type = 'string'

  await insertProjectFixture({connectionId, modelId, projectId: sourceProjectId})
  await insertProjectPromptFixture({
    contentHash: computePromptContentHash(originalPromptText, null, promptHeading, type),
    order: 0,
    originProjectId: null,
    originalText: originalPromptText,
    projectId: sourceProjectId,
    projectPromptId: 'clone-edit-prompt-isolation-project-prompt-original',
    promptHeading,
    promptId: originalPromptId,
    type,
  })
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('${articleId}', 'Clone prompt edit isolation article')
  `)
  await runDatabase(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES ('clone-edit-prompt-isolation-source-article', '${sourceProjectId}', '${articleId}')
  `)
  await runDatabase(`
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
      confidence_original,
      created_at
    )
    VALUES (
      'clone-edit-prompt-isolation-source-judgment',
      '${articleId}',
      '${originalPromptId}',
      '${modelId}',
      '${sourceProjectId}',
      '${sourceProjectId}',
      TRUE,
      TRUE,
      FALSE,
      FALSE,
      TRUE,
      'yes',
      ['yes'],
      91,
      TIMESTAMPTZ '2025-01-01 00:00:00+00'
    )
  `)

  const cloneResponse = await app.handle(
    new Request(`http://localhost/api/projects/${sourceProjectId}/clone`, {method: 'POST'}),
  )
  const cloneBody = (await cloneResponse.json()) as {data: {id: string}}
  const clonedProjectId = cloneBody.data.id

  expect(cloneResponse.status).toBe(200)

  const editResponse = await app.handle(
    new Request(`http://localhost/api/projects/${clonedProjectId}/edit`, {
      body: JSON.stringify({
        name: 'Clone with isolated prompt edit',
        description: null,
        prompts: [
          {originalId: originalPromptId, originalText: editedPromptText, promptHeading, type, order: 0, enabled: true},
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

  expect(editResponse.status).toBe(200)

  const promptRows = await queryDatabase<{
    contentHash: string | null
    originalText: string
    projectId: string
    promptId: string
  }>(`
    SELECT
      pp.project_id AS projectId,
      pp.prompt_id AS promptId,
      p.original_text AS originalText,
      p.content_hash AS contentHash
    FROM app.project_prompt pp
    INNER JOIN app.prompt p ON p.id = pp.prompt_id
    WHERE pp.project_id IN ('${sourceProjectId}', '${clonedProjectId}')
    ORDER BY pp.project_id ASC
  `)
  const sourcePromptRow = promptRows.find((row) => {
    return row.projectId === sourceProjectId
  })
  const clonedPromptRow = promptRows.find((row) => {
    return row.projectId === clonedProjectId
  })
  const clonedPromptId = clonedPromptRow?.promptId

  expect(sourcePromptRow?.promptId).toBe(originalPromptId)
  expect(sourcePromptRow?.originalText).toBe(originalPromptText)
  expect(sourcePromptRow?.contentHash).toBe(computePromptContentHash(originalPromptText, null, promptHeading, type))
  expect(clonedPromptId).not.toBe(originalPromptId)
  expect(clonedPromptRow?.originalText).toBe(editedPromptText)
  expect(clonedPromptRow?.contentHash).toBe(computePromptContentHash(editedPromptText, null, promptHeading, type))

  if (!clonedPromptId) {
    throw new Error('Cloned prompt id not found')
  }

  await runDatabase(`
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
      confidence_original,
      created_at
    )
    VALUES (
      'clone-edit-prompt-isolation-clone-judgment',
      '${articleId}',
      '${clonedPromptRow?.promptId ?? ''}',
      '${modelId}',
      '${clonedProjectId}',
      '${clonedProjectId}',
      TRUE,
      TRUE,
      FALSE,
      FALSE,
      TRUE,
      'no',
      ['no'],
      88,
      TIMESTAMPTZ '2025-01-02 00:00:00+00'
    )
  `)

  const sourceDetailsResponse = await app.handle(
    new Request('http://localhost/api/projectsreview', {
      body: JSON.stringify({articleId, projectId: sourceProjectId}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const cloneDetailsResponse = await app.handle(
    new Request('http://localhost/api/projectsreview', {
      body: JSON.stringify({articleId, projectId: clonedProjectId}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const sourceDetailsBody = (await sourceDetailsResponse.json()) as {
    judgments: Array<{answeredOriginal: string | null; id: string; prompt: {originalText: string}; promptId: string}>
    prompts: Array<{id: string; originalText: string}>
  }
  const cloneDetailsBody = (await cloneDetailsResponse.json()) as {
    judgments: Array<{answeredOriginal: string | null; id: string; prompt: {originalText: string}; promptId: string}>
    prompts: Array<{id: string; originalText: string}>
  }

  expect(sourceDetailsResponse.status).toBe(200)
  expect(cloneDetailsResponse.status).toBe(200)
  expect(
    sourceDetailsBody.prompts.map((prompt) => {
      return {id: prompt.id, originalText: prompt.originalText}
    }),
  ).toEqual([{id: originalPromptId, originalText: originalPromptText}])
  expect(
    sourceDetailsBody.judgments.map((judgment) => {
      return {
        answeredOriginal: judgment.answeredOriginal,
        id: judgment.id,
        prompt: {originalText: judgment.prompt.originalText},
        promptId: judgment.promptId,
      }
    }),
  ).toEqual([
    {
      answeredOriginal: 'yes',
      id: 'clone-edit-prompt-isolation-source-judgment',
      prompt: {originalText: originalPromptText},
      promptId: originalPromptId,
    },
  ])
  expect(
    cloneDetailsBody.prompts.map((prompt) => {
      return {id: prompt.id, originalText: prompt.originalText}
    }),
  ).toEqual([{id: clonedPromptId, originalText: editedPromptText}])
  expect(
    cloneDetailsBody.judgments.map((judgment) => {
      return {
        answeredOriginal: judgment.answeredOriginal,
        id: judgment.id,
        prompt: {originalText: judgment.prompt.originalText},
        promptId: judgment.promptId,
      }
    }),
  ).toEqual([
    {
      answeredOriginal: 'no',
      id: 'clone-edit-prompt-isolation-clone-judgment',
      prompt: {originalText: editedPromptText},
      promptId: clonedPromptId,
    },
  ])

  await flushMartRefreshes()
})

test('cloned project config reruns isolate judgments for every judgment-affecting setting', async () => {
  if (!app || !queryDatabase || !runDatabase || !flushMartRefreshes) {
    throw new Error('Test app not initialized')
  }

  const sourceConfig = baseCloneRerunConfig('clone-config-rerun-model')
  const currentApp = app
  const currentRunDatabase = runDatabase
  const scenarios: CloneRerunScenario[] = [
    {key: 'model-id', nextConfig: {...sourceConfig, modelId: 'clone-config-rerun-model-next'}},
    {key: 'use-title', nextConfig: {...sourceConfig, useTitle: false}},
    {key: 'use-abstract', nextConfig: {...sourceConfig, useAbstract: false}},
    {key: 'use-fulltext', nextConfig: {...sourceConfig, useFulltext: true}},
    {key: 'use-fulltext-no-images', nextConfig: {...sourceConfig, useFulltextNoImages: true}},
  ]

  await currentRunDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode)
    VALUES ('clone-config-rerun-connection', 'sglang', 'SGLang', TRUE, 'none')
  `)
  await currentRunDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES
      ('${sourceConfig.modelId}', 'clone-config-rerun-connection', 'Qwen/Qwen3.5-122B-A10B', 'Qwen/Qwen3.5-122B-A10B', 'Qwen 122B', 'manual', TRUE),
      ('clone-config-rerun-model-next', 'clone-config-rerun-connection', 'Qwen/Qwen3.5-32B', 'Qwen/Qwen3.5-32B', 'Qwen 32B', 'manual', TRUE)
  `)

  await scenarios.reduce(async (previous, scenario) => {
    await previous

    const sourceProjectId = `clone-config-rerun-source-${scenario.key}`
    const articleId = `clone-config-rerun-article-${scenario.key}`
    const promptId = `clone-config-rerun-prompt-${scenario.key}`
    const sourceJudgmentId = `clone-config-rerun-source-judgment-${scenario.key}`
    const cloneJudgmentId = `clone-config-rerun-clone-judgment-${scenario.key}`

    await currentRunDatabase(`
      INSERT INTO app.project (
        id,
        name,
        model_id,
        use_title,
        use_abstract,
        use_fulltext,
        use_fulltext_no_images
      )
      VALUES (
        '${sourceProjectId}',
        'Clone Config Rerun Source ${scenario.key}',
        '${sourceConfig.modelId}',
        TRUE,
        TRUE,
        FALSE,
        FALSE
      )
    `)
    await insertProjectPromptFixture({
      contentHash: `clone-config-rerun-hash-${scenario.key}`,
      order: 0,
      originProjectId: null,
      originalText: 'Clone rerun prompt',
      projectId: sourceProjectId,
      projectPromptId: `clone-config-rerun-project-prompt-${scenario.key}`,
      promptId,
    })
    await currentRunDatabase(`
      INSERT INTO app.article (id, article_title)
      VALUES ('${articleId}', 'Clone config rerun article ${scenario.key}')
    `)
    await currentRunDatabase(`
      INSERT INTO app.project_article (id, project_id, article_id)
      VALUES ('clone-config-rerun-project-article-${scenario.key}', '${sourceProjectId}', '${articleId}')
    `)
    await insertCloneRerunJudgmentFixture({
      answer: 'yes',
      articleId,
      config: sourceConfig,
      createdAt: '2025-01-01 00:00:00+00',
      judgmentId: sourceJudgmentId,
      projectId: sourceProjectId,
      promptId,
    })

    const cloneResponse = await currentApp.handle(
      new Request(`http://localhost/api/projects/${sourceProjectId}/clone`, {method: 'POST'}),
    )
    const cloneBodyText = await cloneResponse.text()

    if (cloneResponse.status !== 200) {
      throw new Error(cloneBodyText)
    }

    const cloneBody = JSON.parse(cloneBodyText) as {data: {id: string}}
    const clonedProjectId = cloneBody.data.id

    expect(cloneResponse.status).toBe(200)

    const editResponse = await currentApp.handle(
      new Request(`http://localhost/api/projects/${clonedProjectId}/edit`, {
        body: JSON.stringify({
          name: `Clone Config Rerun Clone ${scenario.key}`,
          description: null,
          modelId: scenario.nextConfig.modelId,
          useTitle: scenario.nextConfig.useTitle,
          useAbstract: scenario.nextConfig.useAbstract,
          useFulltext: scenario.nextConfig.useFulltext,
          useFulltextNoImages: scenario.nextConfig.useFulltextNoImages,
        }),
        headers: {'content-type': 'application/json'},
        method: 'PATCH',
      }),
    )

    const editBodyText = await editResponse.text()

    if (editResponse.status !== 200) {
      throw new Error(editBodyText)
    }

    expect(editResponse.status).toBe(200)

    await assertSourceCloneRerunState({articleId, promptId, sourceJudgmentId, sourceProjectId})

    const cloneDetailsBeforeRerun = await getProjectReviewDetails({articleId, projectId: clonedProjectId})

    expect(getJudgmentSummaries(cloneDetailsBeforeRerun.judgments)).toEqual([
      {answeredOriginal: 'not answered', id: `placeholder:${promptId}`, promptId},
    ])
    expect(getJudgmentSummaries(cloneDetailsBeforeRerun.allJudgments)).toEqual([])

    await insertCloneRerunJudgmentFixture({
      answer: 'no',
      articleId,
      config: scenario.nextConfig,
      createdAt: '2025-01-02 00:00:00+00',
      judgmentId: cloneJudgmentId,
      projectId: clonedProjectId,
      promptId,
    })

    await assertSourceCloneRerunState({articleId, promptId, sourceJudgmentId, sourceProjectId})

    const cloneDetailsAfterRerun = await getProjectReviewDetails({articleId, projectId: clonedProjectId})

    expect(getJudgmentSummaries(cloneDetailsAfterRerun.judgments)).toEqual([
      {answeredOriginal: 'no', id: cloneJudgmentId, promptId},
    ])
    expect(getJudgmentSummaries(cloneDetailsAfterRerun.allJudgments)).toEqual([])
  }, Promise.resolve())

  await flushMartRefreshes()
})

test('unchanged cloned project reruns reuse shared judgments when prompt model and content flags match', async () => {
  if (!app || !queryDatabase || !runDatabase || !flushMartRefreshes || !markArticleProjectsDirty || !refreshProject) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'clone-unchanged-rerun-connection'
  const modelId = 'clone-unchanged-rerun-model'
  const sourceProjectId = 'clone-unchanged-rerun-source'
  const articleId = 'clone-unchanged-rerun-article'
  const promptId = 'clone-unchanged-rerun-prompt'
  const sourceJudgmentId = 'clone-unchanged-rerun-source-judgment'
  const config = baseCloneRerunConfig(modelId)

  await insertProjectFixture({connectionId, modelId, projectId: sourceProjectId})
  await insertProjectPromptFixture({
    contentHash: 'clone-unchanged-rerun-hash',
    order: 0,
    originProjectId: null,
    originalText: 'Clone rerun prompt',
    projectId: sourceProjectId,
    projectPromptId: 'clone-unchanged-rerun-project-prompt',
    promptId,
  })
  await runDatabase(`
    INSERT INTO app.article (id, article_title, article_created_at, article_updated_at, article_id)
    VALUES (
      '${articleId}',
      'Clone unchanged rerun article',
      '2024-01-02T00:00:00.000Z',
      '2024-01-03T00:00:00.000Z',
      'external-clone-unchanged-rerun'
    )
  `)
  await runDatabase(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES ('clone-unchanged-rerun-project-article', '${sourceProjectId}', '${articleId}')
  `)
  await insertCloneRerunJudgmentFixture({
    answer: 'yes',
    articleId,
    config,
    createdAt: '2025-01-01 00:00:00+00',
    judgmentId: sourceJudgmentId,
    projectId: sourceProjectId,
    promptId,
  })
  await markArticleProjectsDirty(articleId, 'ProjectsRoutes.test.cloneUnchangedRerunJudgmentFact')
  await refreshProject(sourceProjectId)
  await flushMartRefreshes()

  const cloneResponse = await app.handle(
    new Request(`http://localhost/api/projects/${sourceProjectId}/clone`, {method: 'POST'}),
  )
  const cloneBody = (await cloneResponse.json()) as {data: {id: string}}
  const clonedProjectId = cloneBody.data.id

  expect(cloneResponse.status).toBe(200)

  await refreshProject(clonedProjectId)
  await flushMartRefreshes()
  await flushMartRefreshes()
  await assertSourceCloneRerunState({articleId, promptId, sourceJudgmentId, sourceProjectId})

  const [martCounts] = await queryDatabase<{
    activeCloneDetailCount: number
    activeCloneDetailJudgmentId: string | null
    cloneDetailCount: number
    cloneScopeCount: number
    judgmentFactCount: number
  }>(`
    SELECT
      (SELECT COUNT(*) FROM mart.judgment_fact WHERE judgment_id = '${sourceJudgmentId}') AS judgmentFactCount,
      (SELECT COUNT(*) FROM mart.project_scope_article WHERE project_id = '${clonedProjectId}') AS cloneScopeCount,
      (SELECT COUNT(*) FROM mart.review_article_serving_detail WHERE project_id = '${clonedProjectId}') AS cloneDetailCount,
      (
        SELECT COUNT(*)
        FROM mart.review_article_serving_detail detail
        INNER JOIN app.project_review_serving_generation generation
          ON generation.project_id = detail.project_id
         AND generation.active_generation = detail.generation
        WHERE detail.project_id = '${clonedProjectId}'
      ) AS activeCloneDetailCount,
      (
        SELECT detail.judgment_id
        FROM mart.review_article_serving_detail detail
        INNER JOIN app.project_review_serving_generation generation
          ON generation.project_id = detail.project_id
         AND generation.active_generation = detail.generation
        WHERE detail.project_id = '${clonedProjectId}'
        LIMIT 1
      ) AS activeCloneDetailJudgmentId
  `)

  expect(Number(martCounts?.judgmentFactCount ?? 0)).toBe(1)
  expect(Number(martCounts?.cloneScopeCount ?? 0)).toBe(1)
  expect(Number(martCounts?.cloneDetailCount ?? 0)).toBe(1)
  expect(Number(martCounts?.activeCloneDetailCount ?? 0)).toBe(1)
  expect(martCounts?.activeCloneDetailJudgmentId).toBe(sourceJudgmentId)
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

test('create route stores hash-backed immutable prompts', async () => {
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
  expect(promptRow?.contentHash).toBeTruthy()
  expect(promptRow?.originProjectId).toBe(null)

  await flushMartRefreshes()
})

test('create route reuses exact hash-matching immutable prompts', async () => {
  if (!app || !queryDatabase || !runDatabase || !flushMartRefreshes) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'create-immutable-reuse-connection'
  const modelId = 'create-immutable-reuse-model'
  const promptText = 'Shared immutable prompt text'
  const promptHeading = 'shared immutable'
  const type = 'string'
  const promptHash = computePromptContentHash(promptText, null, promptHeading, type)

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
    VALUES ('create-immutable-reuse-prompt', '${promptText}', '${promptHeading}', '${type}', '${promptHash}')
  `)

  const response = await app.handle(
    new Request('http://localhost/api/projects', {
      body: JSON.stringify({
        name: 'Create immutable reuse project',
        modelId,
        prompts: [{content: promptText, promptHeading, type, order: 0}],
      }),
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
  const [hashCountRow] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.prompt
    WHERE content_hash = '${promptHash}'
  `)

  expect(promptRow?.promptId).toBe('create-immutable-reuse-prompt')
  expect(promptRow?.contentHash).toBe(promptHash)
  expect(promptRow?.originProjectId).toBe(null)
  expect(Number(hashCountRow?.count ?? 0)).toBe(1)

  await flushMartRefreshes()
})

test('create route reuses archived hash-matching prompt and reactivates the canonical row', async () => {
  if (!app || !queryDatabase || !runDatabase || !flushMartRefreshes) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'create-archived-canonical-connection'
  const modelId = 'create-archived-canonical-model'
  const promptHash = computePromptContentHash('Archived shared prompt text', null, 'archived shared', 'string')

  await insertProjectFixture({connectionId, modelId, projectId: 'create-archived-canonical-seed-project'})
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, prompt_heading, type, content_hash, archived)
    VALUES (
      'create-archived-canonical-prompt',
      'Archived shared prompt text',
      'archived shared',
      'string',
      '${promptHash}',
      TRUE
    )
  `)

  const response = await app.handle(
    new Request('http://localhost/api/projects', {
      body: JSON.stringify({
        name: 'Archived canonical create project',
        modelId,
        prompts: [{content: 'Archived shared prompt text', promptHeading: 'archived shared', type: 'string', order: 0}],
      }),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const body = (await response.json()) as {data: {id: string}}
  const projectId = body.data.id

  expect(response.status).toBe(200)

  const promptRows = await queryDatabase<{
    archived: boolean
    contentHash: string | null
    linkedProjectId: string | null
    promptId: string
  }>(`
    SELECT
      p.id AS promptId,
      p.content_hash AS contentHash,
      p.archived AS archived,
      pp.project_id AS linkedProjectId
    FROM app.prompt p
    LEFT JOIN app.project_prompt pp
      ON pp.prompt_id = p.id
     AND pp.project_id = '${projectId}'
    WHERE p.content_hash = '${promptHash}'
    ORDER BY p.id ASC
  `)

  expect(promptRows).toEqual([
    {
      archived: false,
      contentHash: promptHash,
      linkedProjectId: projectId,
      promptId: 'create-archived-canonical-prompt',
    },
  ])

  await flushMartRefreshes()
})

test('edit route reuses matching immutable prompts when content matches', async () => {
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
    VALUES (
      'edit-detach-existing-prompt',
      'Shared prompt text',
      'shared',
      'string',
      '${computePromptContentHash('Shared prompt text', null, 'shared', 'string')}'
    )
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

  expect(promptRow?.promptId).toBe('edit-detach-existing-prompt')
  expect(promptRow?.contentHash).toBe(computePromptContentHash('Shared prompt text', null, 'shared', 'string'))
  expect(promptRow?.originProjectId).toBe(null)

  await flushMartRefreshes()
})

test('edit route creates a new immutable prompt row instead of mutating a shared prompt', async () => {
  if (!app || !queryDatabase || !runDatabase || !flushMartRefreshes) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'edit-immutable-new-row-connection'
  const modelId = 'edit-immutable-new-row-model'
  const projectId = 'edit-immutable-new-row-project'
  const linkedProjectId = 'edit-immutable-new-row-linked-project'
  const originalPromptId = 'edit-immutable-new-row-original-prompt'
  const originalPromptText = 'Original immutable prompt text'
  const editedPromptText = 'Edited immutable prompt text'
  const promptHeading = 'eligibility'
  const type = 'string'
  const originalPromptHash = computePromptContentHash(originalPromptText, null, promptHeading, type)
  const editedPromptHash = computePromptContentHash(editedPromptText, null, promptHeading, type)

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.project (
      id,
      name,
      model_id,
      human_judgment_mode,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images,
      archived
    )
    VALUES (
      '${linkedProjectId}',
      'Edit immutable linked project',
      '${modelId}',
      'prompt',
      TRUE,
      TRUE,
      FALSE,
      FALSE,
      FALSE
    )
  `)
  await insertProjectPromptFixture({
    contentHash: originalPromptHash,
    originProjectId: null,
    originalText: originalPromptText,
    projectId,
    projectPromptId: 'edit-immutable-new-row-project-prompt',
    promptHeading,
    promptId: originalPromptId,
    type,
  })
  await runDatabase(`
    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, archived, enabled, origin_project_id)
    VALUES (
      'edit-immutable-new-row-linked-project-prompt',
      '${linkedProjectId}',
      '${originalPromptId}',
      0,
      FALSE,
      TRUE,
      NULL
    )
  `)

  const response = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}/edit`, {
      body: JSON.stringify({
        name: 'Edited immutable project',
        description: null,
        prompts: [
          {originalId: originalPromptId, originalText: editedPromptText, promptHeading, type, order: 0, enabled: true},
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

  const projectPromptRows = await queryDatabase<{projectId: string; promptId: string}>(`
    SELECT project_id AS projectId, prompt_id AS promptId
    FROM app.project_prompt
    WHERE project_id IN ('${projectId}', '${linkedProjectId}')
    ORDER BY project_id ASC
  `)
  const [originalPromptRow] = await queryDatabase<{
    contentHash: string | null
    originalText: string
    promptHeading: string | null
    type: string | null
  }>(`
    SELECT
      content_hash AS contentHash,
      original_text AS originalText,
      prompt_heading AS promptHeading,
      type
    FROM app.prompt
    WHERE id = '${originalPromptId}'
    LIMIT 1
  `)
  const editedProjectPromptRow = projectPromptRows.find((row) => {
    return row.projectId === projectId
  })
  const linkedProjectPromptRow = projectPromptRows.find((row) => {
    return row.projectId === linkedProjectId
  })
  const [editedPromptRow] = await queryDatabase<{
    contentHash: string | null
    originalText: string
    promptHeading: string | null
    type: string | null
  }>(`
    SELECT
      content_hash AS contentHash,
      original_text AS originalText,
      prompt_heading AS promptHeading,
      type
    FROM app.prompt
    WHERE id = '${editedProjectPromptRow?.promptId ?? ''}'
    LIMIT 1
  `)
  const [editedHashCountRow] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.prompt
    WHERE content_hash = '${editedPromptHash}'
  `)

  expect(editedProjectPromptRow?.promptId).not.toBe(originalPromptId)
  expect(linkedProjectPromptRow?.promptId).toBe(originalPromptId)
  expect(originalPromptRow).toEqual({
    contentHash: originalPromptHash,
    originalText: originalPromptText,
    promptHeading,
    type,
  })
  expect(editedPromptRow).toEqual({contentHash: editedPromptHash, originalText: editedPromptText, promptHeading, type})
  expect(Number(editedHashCountRow?.count ?? 0)).toBe(1)

  await flushMartRefreshes()
})

test('edit route reuses archived hash-matching prompt without globally unarchiving it', async () => {
  if (!app || !queryDatabase || !runDatabase || !flushMartRefreshes) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'edit-archived-canonical-connection'
  const modelId = 'edit-archived-canonical-model'
  const projectId = 'edit-archived-canonical-project'
  const promptHash = computePromptContentHash('Archived edit prompt text', null, 'archived edit', 'string')

  await insertProjectFixture({connectionId, modelId, projectId})
  await insertProjectPromptFixture({
    contentHash: 'edit-archived-canonical-original-hash',
    originProjectId: projectId,
    originalText: 'Original edit prompt text',
    projectId,
    projectPromptId: 'edit-archived-canonical-project-prompt',
    promptId: 'edit-archived-canonical-original-prompt',
  })
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, prompt_heading, type, content_hash, archived)
    VALUES (
      'edit-archived-canonical-target-prompt',
      'Archived edit prompt text',
      'archived edit',
      'string',
      '${promptHash}',
      TRUE
    )
  `)

  const response = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}/edit`, {
      body: JSON.stringify({
        name: 'Edited archived canonical project',
        description: null,
        prompts: [
          {
            originalId: 'edit-archived-canonical-original-prompt',
            originalText: 'Archived edit prompt text',
            promptHeading: 'archived edit',
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

  const promptRows = await queryDatabase<{
    archived: boolean
    contentHash: string | null
    linkedProjectId: string | null
    promptId: string
  }>(`
    SELECT
      p.id AS promptId,
      p.content_hash AS contentHash,
      p.archived AS archived,
      pp.project_id AS linkedProjectId
    FROM app.prompt p
    LEFT JOIN app.project_prompt pp
      ON pp.prompt_id = p.id
     AND pp.project_id = '${projectId}'
    WHERE p.content_hash = '${promptHash}'
    ORDER BY p.id ASC
  `)

  expect(promptRows).toEqual([
    {
      archived: true,
      contentHash: promptHash,
      linkedProjectId: projectId,
      promptId: 'edit-archived-canonical-target-prompt',
    },
  ])

  await flushMartRefreshes()
})

test('clone route keeps legacy null-hash prompt links stable', async () => {
  if (!app || !queryDatabase || !runDatabase || !flushMartRefreshes) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'clone-null-hash-connection'
  const modelId = 'clone-null-hash-model'
  const projectId = 'clone-null-hash-project'

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, prompt_heading, type, content_hash)
    VALUES ('clone-null-hash-prompt', 'Legacy null hash prompt', 'legacy', 'string', NULL)
  `)
  await runDatabase(`
    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, archived, enabled, origin_project_id)
    VALUES ('clone-null-hash-project-prompt', '${projectId}', 'clone-null-hash-prompt', 0, FALSE, TRUE, NULL)
  `)

  const cloneResponse = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}/clone`, {method: 'POST'}),
  )
  const cloneBody = (await cloneResponse.json()) as {data: {id: string}}
  const clonedProjectId = cloneBody.data.id

  expect(cloneResponse.status).toBe(200)

  const clonedPromptRows = await queryDatabase<{contentHash: string | null; promptId: string}>(`
    SELECT p.id AS promptId,
           p.content_hash AS contentHash
    FROM app.project_prompt pp
    INNER JOIN app.prompt p ON p.id = pp.prompt_id
    WHERE pp.project_id = '${clonedProjectId}'
  `)

  expect(clonedPromptRows).toEqual([{contentHash: null, promptId: 'clone-null-hash-prompt'}])

  await flushMartRefreshes()
})

test('archive route marks active judgment jobs as project_removed and draining for archived projects', async () => {
  if (!app || !queryDatabase || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const projectId = 'archive-project-judgment-job-cleanup'
  const jobId = 'archive-project-judgment-job-cleanup-job'

  await insertProjectFixture({
    connectionId: 'archive-project-judgment-job-cleanup-connection',
    modelId: 'archive-project-judgment-job-cleanup-model',
    projectId,
  })
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${jobId}', '${projectId}', 'running', 'active')
  `)

  const response = await app.handle(new Request(`http://localhost/api/projects/${projectId}`, {method: 'DELETE'}))

  expect(response.status).toBe(200)

  const [jobRow] = await queryDatabase<{pauseRequestedAt: string | null; status: string; storageState: string}>(`
    SELECT
      status,
      storage_state AS storageState,
      pause_requested_at AS pauseRequestedAt
    FROM app.judgment_job
    WHERE id = '${jobId}'
    LIMIT 1
  `)

  expect(jobRow?.status).toBe('project_removed')
  expect(jobRow?.storageState).toBe('draining')
  expect(jobRow?.pauseRequestedAt).toBeTruthy()
})
