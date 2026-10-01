import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import {createTempRuntimeRoot} from '../../test/createTempRuntimeRoot.ts'
import type {JudgmentJobSqliteOutboxEntry} from './judgmentJobSqliteService.ts'
import {commitJudgmentSqliteOutboxImportDirtyWork} from './judgmentsJobsMarkDirtyWork.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('f1-judgments-jobs-mark-dirty-work')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.RUN_SERVER_JUDGING = 'false'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

let closeDatabase: (() => Promise<void>) | null = null
let queryDatabase: (<T>(statement: string) => Promise<T[]>) | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null

beforeAll(async () => {
  const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] =
    await Promise.all([
      import('../../../db/migrateDuckdb.ts'),
      import('../../services/appDatabaseService.ts'),
      import('../../utils/duckdbService.ts'),
      import('../../utils/serverRuntimeRole.ts'),
    ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()

  await migrateDuckdb()

  const database = getAppDatabaseService()

  closeDatabase = () => {
    return database.close()
  }
  queryDatabase = (statement: string) => {
    return database.queryJson(statement)
  }
  runDatabase = (statement: string) => {
    return database.run(statement)
  }
})

afterAll(async () => {
  await closeDatabase?.()
  tempRuntimeRoot.cleanup()
})

const seedImportFixture = async (suffix: string) => {
  if (!runDatabase) {
    throw new Error('Test database not initialized')
  }

  const ids = {
    articleId: `article-mark-dirty-${suffix}`,
    connectionId: `connection-mark-dirty-${suffix}`,
    jobId: `job-mark-dirty-${suffix}`,
    judgmentId: `judgment-mark-dirty-${suffix}`,
    modelId: `model-mark-dirty-${suffix}`,
    projectId: `project-mark-dirty-${suffix}`,
    projectPromptId: `project-prompt-mark-dirty-${suffix}`,
    promptId: `prompt-mark-dirty-${suffix}`,
    queuePromptId: `queue-mark-dirty-${suffix}`,
  }

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('${ids.connectionId}', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${ids.modelId}', '${ids.connectionId}', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${ids.projectId}', 'Mark Dirty Work Test', '${ids.modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${ids.jobId}', '${ids.projectId}', 'running')
  `)
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('${ids.promptId}', 'Prompt', '${ids.promptId}-hash')
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('${ids.articleId}', 'Article')
  `)
  await runDatabase(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES ('${ids.jobId}-project-article', '${ids.projectId}', '${ids.articleId}')
  `)
  await runDatabase(`
    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
    VALUES ('${ids.projectPromptId}', '${ids.projectId}', '${ids.promptId}', 1, TRUE)
  `)

  return ids
}

const getEntry = (
  ids: Awaited<ReturnType<typeof seedImportFixture>>,
  outboxSeq = 1,
  overrides: Partial<JudgmentJobSqliteOutboxEntry> = {},
): JudgmentJobSqliteOutboxEntry => {
  const now = new Date()

  return {
    answeredOriginal: 'include',
    answeredOriginalAsArray: ['include'],
    articleId: ids.articleId,
    chunkingStrategy: null,
    claimId: null,
    confidenceOriginal: 90,
    createdAt: now,
    executionSnapshotHash: null,
    executionSnapshotId: null,
    explanation: 'because',
    isAnswered: true,
    jobId: ids.jobId,
    judgmentId: ids.judgmentId,
    modelId: ids.modelId,
    outboxSeq,
    projectId: ids.projectId,
    promptId: ids.promptId,
    queuePromptId: ids.queuePromptId,
    quotes: ['quote'],
    rawResponseJson: {answer: 'include'},
    requestAttemptsJson: null,
    snapshotProjectId: ids.projectId,
    snapshotProjectModelName: 'Qwen 35B',
    systemPromptVariant: 'legacy',
    updatedAt: now,
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useMetadata: false,
    useTitle: true,
    ...overrides,
  }
}

test('dirty work commits judgment, import marker, and dirty state idempotently', async () => {
  if (!queryDatabase) {
    throw new Error('Test database not initialized')
  }

  const ids = await seedImportFixture(`idempotent-${Date.now()}`)
  const entry = getEntry(ids)
  const firstResult = await commitJudgmentSqliteOutboxImportDirtyWork({
    discardedEntries: [],
    importableEntries: [entry],
    requestedBy: 'test-importer',
  })
  const secondResult = await commitJudgmentSqliteOutboxImportDirtyWork({
    discardedEntries: [],
    importableEntries: [entry],
    requestedBy: 'test-importer',
  })
  const [row] = await queryDatabase<{
    deltaRows: number
    dirtyWorkRows: number
    judgmentRows: number
    markerRows: number
    modelId: string | null
    systemPromptVariant: string | null
    useAbstract: boolean | null
    useFulltext: boolean | null
    useFulltextNoImages: boolean | null
    useTitle: boolean | null
  }>(`
    SELECT
      (SELECT COUNT(*) FROM app.judgment WHERE id = '${ids.judgmentId}') AS judgmentRows,
      (SELECT system_prompt_variant FROM app.judgment WHERE id = '${ids.judgmentId}') AS systemPromptVariant,
      (SELECT COUNT(*) FROM app.judgment_job_sqlite_outbox_import WHERE job_id = '${ids.jobId}') AS markerRows,
      (SELECT COUNT(*) FROM app.review_change_delta WHERE judgment_id = '${ids.judgmentId}') AS deltaRows,
      (SELECT model_id FROM app.review_change_delta WHERE judgment_id = '${ids.judgmentId}' LIMIT 1) AS modelId,
      (SELECT use_title FROM app.review_change_delta WHERE judgment_id = '${ids.judgmentId}' LIMIT 1) AS useTitle,
      (SELECT use_abstract FROM app.review_change_delta WHERE judgment_id = '${ids.judgmentId}' LIMIT 1) AS useAbstract,
      (SELECT use_fulltext FROM app.review_change_delta WHERE judgment_id = '${ids.judgmentId}' LIMIT 1) AS useFulltext,
      (SELECT use_fulltext_no_images FROM app.review_change_delta WHERE judgment_id = '${ids.judgmentId}' LIMIT 1) AS useFulltextNoImages,
      (SELECT COUNT(*) FROM app.review_serving_dirty_work WHERE project_id = '${ids.projectId}') AS dirtyWorkRows
  `)

  expect(firstResult.importedRows).toEqual([{jobId: ids.jobId, outboxSeq: 1}])
  expect(firstResult.duplicateRows).toEqual([])
  expect(secondResult.importedRows).toEqual([])
  expect(secondResult.duplicateRows).toEqual([{jobId: ids.jobId, outboxSeq: 1}])
  expect(Number(row?.judgmentRows ?? 0)).toBe(1)
  expect(row?.systemPromptVariant).toBe('legacy')
  expect(Number(row?.markerRows ?? 0)).toBe(1)
  expect(Number(row?.deltaRows ?? 0)).toBe(1)
  expect(row?.modelId).toBe(ids.modelId)
  expect(row?.useTitle).toBe(true)
  expect(row?.useAbstract).toBe(true)
  expect(row?.useFulltext).toBe(false)
  expect(row?.useFulltextNoImages).toBe(false)
  expect(Number(row?.dirtyWorkRows ?? 0)).toBe(5)
})

test('dirty work fans out SQLite LLM deltas to every visible project', async () => {
  if (!queryDatabase || !runDatabase) {
    throw new Error('Test database not initialized')
  }

  const ids = await seedImportFixture(`visible-fanout-${Date.now()}`)
  const visibleProjectId = `${ids.projectId}-visible`
  const entry = getEntry(ids)

  await runDatabase(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${visibleProjectId}', 'Visible Project', '${ids.modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES ('${visibleProjectId}-article', '${visibleProjectId}', '${ids.articleId}')
  `)
  await runDatabase(`
    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
    VALUES ('${visibleProjectId}-prompt', '${visibleProjectId}', '${ids.promptId}', 1, TRUE)
  `)

  await commitJudgmentSqliteOutboxImportDirtyWork({
    discardedEntries: [],
    importableEntries: [entry],
    requestedBy: 'test-importer',
  })

  const rows = await queryDatabase<{projectId: string}>(`
    SELECT project_id AS projectId
    FROM app.review_change_delta
    WHERE judgment_id = '${ids.judgmentId}'
    ORDER BY project_id ASC
  `)

  expect(rows).toEqual([{projectId: ids.projectId}, {projectId: visibleProjectId}])
})

test('dirty work stores each system prompt variant as its own judgment and fans out by variant', async () => {
  if (!queryDatabase || !runDatabase) {
    throw new Error('Test database not initialized')
  }

  const ids = await seedImportFixture(`variant-identity-${Date.now()}`)
  const screeningProjectId = `${ids.projectId}-screening`
  const screeningJudgmentId = `${ids.judgmentId}-screening`

  await runDatabase(`
    INSERT INTO app.project (
      id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images, system_prompt_variant
    )
    VALUES ('${screeningProjectId}', 'Screening Project', '${ids.modelId}', TRUE, TRUE, FALSE, FALSE, 'screening_v1')
  `)
  await runDatabase(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES ('${screeningProjectId}-article', '${screeningProjectId}', '${ids.articleId}')
  `)
  await runDatabase(`
    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
    VALUES ('${screeningProjectId}-prompt', '${screeningProjectId}', '${ids.promptId}', 1, TRUE)
  `)

  const result = await commitJudgmentSqliteOutboxImportDirtyWork({
    discardedEntries: [],
    importableEntries: [
      getEntry(ids, 1),
      getEntry(ids, 2, {
        judgmentId: screeningJudgmentId,
        queuePromptId: `${ids.queuePromptId}-screening`,
        systemPromptVariant: 'screening_v1',
      }),
    ],
    requestedBy: 'test-importer',
  })
  const judgments = await queryDatabase<{id: string; systemPromptVariant: string}>(`
    SELECT id, system_prompt_variant AS systemPromptVariant
    FROM app.judgment
    WHERE article_id = '${ids.articleId}'
    ORDER BY system_prompt_variant ASC
  `)
  const deltas = await queryDatabase<{judgmentId: string; projectId: string}>(`
    SELECT judgment_id AS judgmentId, project_id AS projectId
    FROM app.review_change_delta
    WHERE judgment_id IN ('${ids.judgmentId}', '${screeningJudgmentId}')
    ORDER BY project_id ASC
  `)

  expect(result.importedRows).toEqual([
    {jobId: ids.jobId, outboxSeq: 1},
    {jobId: ids.jobId, outboxSeq: 2},
  ])
  expect(judgments).toEqual([
    {id: ids.judgmentId, systemPromptVariant: 'legacy'},
    {id: screeningJudgmentId, systemPromptVariant: 'screening_v1'},
  ])
  expect(deltas).toEqual([
    {judgmentId: ids.judgmentId, projectId: ids.projectId},
    {judgmentId: screeningJudgmentId, projectId: screeningProjectId},
  ])
})

test('dirty work stores use_metadata as its own judgment identity and fans out by the flag', async () => {
  if (!queryDatabase || !runDatabase) {
    throw new Error('Test database not initialized')
  }

  const ids = await seedImportFixture(`metadata-identity-${Date.now()}`)
  const metadataProjectId = `${ids.projectId}-metadata`
  const metadataJudgmentId = `${ids.judgmentId}-metadata`
  const duplicateMetadataJudgmentId = `${ids.judgmentId}-metadata-duplicate`

  await runDatabase(`
    INSERT INTO app.project (
      id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images, use_metadata
    )
    VALUES ('${metadataProjectId}', 'Metadata Project', '${ids.modelId}', TRUE, TRUE, FALSE, FALSE, TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES ('${metadataProjectId}-article', '${metadataProjectId}', '${ids.articleId}')
  `)
  await runDatabase(`
    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
    VALUES ('${metadataProjectId}-prompt', '${metadataProjectId}', '${ids.promptId}', 1, TRUE)
  `)

  const result = await commitJudgmentSqliteOutboxImportDirtyWork({
    discardedEntries: [],
    importableEntries: [
      getEntry(ids, 1),
      getEntry(ids, 2, {
        judgmentId: metadataJudgmentId,
        queuePromptId: `${ids.queuePromptId}-metadata`,
        useMetadata: true,
      }),
    ],
    requestedBy: 'test-importer',
  })
  const duplicateResult = await commitJudgmentSqliteOutboxImportDirtyWork({
    discardedEntries: [],
    importableEntries: [
      getEntry(ids, 3, {
        judgmentId: duplicateMetadataJudgmentId,
        queuePromptId: `${ids.queuePromptId}-metadata-duplicate`,
        useMetadata: true,
      }),
    ],
    requestedBy: 'test-importer',
  })
  const judgments = await queryDatabase<{id: string; useMetadata: boolean}>(`
    SELECT id, use_metadata AS useMetadata
    FROM app.judgment
    WHERE article_id = '${ids.articleId}'
    ORDER BY use_metadata ASC
  `)
  const deltas = await queryDatabase<{judgmentId: string; projectId: string; useMetadata: boolean | null}>(`
    SELECT DISTINCT judgment_id AS judgmentId, project_id AS projectId, use_metadata AS useMetadata
    FROM app.review_change_delta
    WHERE judgment_id IN ('${ids.judgmentId}', '${metadataJudgmentId}', '${duplicateMetadataJudgmentId}')
    ORDER BY project_id ASC
  `)

  expect(result.importedRows).toEqual([
    {jobId: ids.jobId, outboxSeq: 1},
    {jobId: ids.jobId, outboxSeq: 2},
  ])
  expect(duplicateResult.importedRows).toEqual([])
  expect(duplicateResult.duplicateRows).toEqual([{jobId: ids.jobId, outboxSeq: 3}])
  expect(judgments).toEqual([
    {id: ids.judgmentId, useMetadata: false},
    {id: metadataJudgmentId, useMetadata: true},
  ])
  expect(deltas).toEqual([
    {judgmentId: ids.judgmentId, projectId: ids.projectId, useMetadata: false},
    {judgmentId: metadataJudgmentId, projectId: metadataProjectId, useMetadata: true},
  ])
})

test('dirty work records import and V4 dirty work without legacy refresh claims', async () => {
  if (!queryDatabase || !runDatabase) {
    throw new Error('Test database not initialized')
  }

  const ids = await seedImportFixture(`quarantine-${Date.now()}`)
  const entry = getEntry(ids)

  await commitJudgmentSqliteOutboxImportDirtyWork({
    discardedEntries: [],
    importableEntries: [entry],
    requestedBy: 'test-importer',
  })

  const [row] = await queryDatabase<{dirtyWorkRows: number; legacyStateRows: number; markerRows: number}>(`
    SELECT
      (SELECT COUNT(*) FROM app.judgment_job_sqlite_outbox_import WHERE job_id = '${ids.jobId}') AS markerRows,
      (SELECT COUNT(*) FROM app.review_serving_dirty_work WHERE project_id = '${ids.projectId}') AS dirtyWorkRows,
      (SELECT COUNT(*) FROM app.project_mart_refresh_state WHERE project_id = '${ids.projectId}') AS legacyStateRows
  `)

  expect(Number(row?.markerRows ?? 0)).toBe(1)
  expect(Number(row?.dirtyWorkRows ?? 0)).toBe(5)
  expect(Number(row?.legacyStateRows ?? 0)).toBe(0)
})
