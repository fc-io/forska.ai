import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {getAppDatabaseService} from '../server/services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../server/test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('migrate-shared-article-partition')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const migrationSql = readFileSync(
  resolve(import.meta.dir, 'duckdbMigrations', '0245_shareArticleReviewServingDeltaPartition.sql'),
  'utf8',
)

let database: ReturnType<typeof getAppDatabaseService> | null = null

const getDatabase = () => {
  if (database === null) {
    throw new Error('Database not initialized')
  }

  return database
}

const insertArticleDelta = async (input: {
  articleId: string
  changeKind: string
  createdAt: string
  deltaId: string
  highWaterMark: number
  reconciled: boolean
}) => {
  await getDatabase().run(`
    INSERT INTO app.review_change_delta (
      delta_id, change_kind, source_table, source_row_id, source_operation, source_partition, source_high_water_mark,
      idempotency_key, payload_version, article_id, payload_json, created_at, reconciled_at
    ) VALUES (
      '${input.deltaId}', '${input.changeKind}', 'app.article', '${input.articleId}', 'insert',
      'article:${input.articleId}', ${input.highWaterMark}, 'key:${input.deltaId}', 1, '${input.articleId}',
      '{"articleId":"${input.articleId}"}'::JSON, TIMESTAMPTZ '${input.createdAt}',
      ${input.reconciled ? "TIMESTAMPTZ '2026-09-27T00:00:00Z'" : 'NULL'}
    )
  `)
  await getDatabase().run(`
    INSERT INTO app.review_delta_reconciliation_cursor (source_partition, source_high_water_mark)
    VALUES ('article:${input.articleId}', ${input.highWaterMark})
    ON CONFLICT DO NOTHING
  `)
}

const insertDirtyWork = async (input: {
  articleId: string
  component: string
  deltaId: string
  dirtyWorkId: string
  status: string
}) => {
  await getDatabase().run(`
    INSERT INTO app.review_serving_dirty_work (
      dirty_work_id, project_id, scope_kind, scope_id, article_id, projection_component, projection_identity,
      dirty_kind, source_partition, first_source_high_water_mark, latest_source_high_water_mark, latest_delta_id, status
    ) VALUES (
      '${input.dirtyWorkId}', 'project-shared', 'article', 'project-shared:${input.articleId}', '${input.articleId}',
      '${input.component}', '${input.component}:identity', 'article.judgmentInput.updated',
      'article:${input.articleId}', 3, 3, '${input.deltaId}', '${input.status}'
    )
  `)
  await getDatabase().run(`
    INSERT INTO app.review_serving_dirty_work_claim_state (
      dirty_work_id, project_id, projection_component, projection_identity, source_partition, status,
      latest_source_high_water_mark
    ) VALUES (
      '${input.dirtyWorkId}', 'project-shared', '${input.component}', '${input.component}:identity',
      'article:${input.articleId}', '${input.status}', 3
    )
  `)
}

beforeAll(async () => {
  const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] =
    await Promise.all([
      import('./migrateDuckdb.ts'),
      import('../server/services/appDatabaseService.ts'),
      import('../server/utils/duckdbService.ts'),
      import('../server/utils/serverRuntimeRole.ts'),
    ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()
  await migrateDuckdb()

  database = getAppDatabaseService()
})

afterAll(async () => {
  await database?.close()
  tempRuntimeRoot.cleanup()
})

test('the migration moves pending per-article work onto the shared article partition above every old counter', async () => {
  await insertArticleDelta({
    articleId: 'article-pending-work',
    changeKind: 'article.judgmentInput.updated',
    createdAt: '2026-09-26T08:00:00Z',
    deltaId: 'delta-pending-work',
    highWaterMark: 3,
    reconciled: true,
  })
  await insertArticleDelta({
    articleId: 'article-a',
    changeKind: 'article.display.updated',
    createdAt: '2026-09-26T09:00:00Z',
    deltaId: 'delta-a',
    highWaterMark: 1,
    reconciled: false,
  })
  await insertArticleDelta({
    articleId: 'article-b',
    changeKind: 'article.searchText.updated',
    createdAt: '2026-09-26T10:00:00Z',
    deltaId: 'delta-b',
    highWaterMark: 2,
    reconciled: false,
  })
  await insertArticleDelta({
    articleId: 'article-done',
    changeKind: 'article.display.updated',
    createdAt: '2026-09-26T07:00:00Z',
    deltaId: 'delta-done',
    highWaterMark: 1,
    reconciled: true,
  })
  await insertDirtyWork({
    articleId: 'article-pending-work',
    component: 'llmStatus',
    deltaId: 'delta-pending-work',
    dirtyWorkId: 'dirty-pending-llm',
    status: 'pending',
  })
  await insertDirtyWork({
    articleId: 'article-pending-work',
    component: 'queue',
    deltaId: 'delta-pending-work',
    dirtyWorkId: 'dirty-running-queue',
    status: 'running',
  })
  await insertDirtyWork({
    articleId: 'article-done',
    component: 'display',
    deltaId: 'delta-done',
    dirtyWorkId: 'dirty-completed-display',
    status: 'completed',
  })

  await getDatabase().run(migrationSql)

  expect(
    await getDatabase().queryJson<{articleId: string; highWaterMark: number; reconciled: boolean}>(`
      SELECT article_id AS articleId, source_high_water_mark::INTEGER AS highWaterMark, reconciled_at IS NOT NULL AS reconciled
      FROM app.review_change_delta
      WHERE source_partition = 'article:all'
      ORDER BY source_high_water_mark
    `),
  ).toEqual([
    {articleId: 'article-pending-work', highWaterMark: 4, reconciled: false},
    {articleId: 'article-a', highWaterMark: 5, reconciled: false},
    {articleId: 'article-b', highWaterMark: 6, reconciled: false},
  ])
  expect(
    await getDatabase().queryJson<{deltaId: string; reconciled: boolean}>(`
      SELECT delta_id AS deltaId, reconciled_at IS NOT NULL AS reconciled
      FROM app.review_change_delta
      WHERE source_partition <> 'article:all'
      ORDER BY delta_id
    `),
  ).toEqual([
    {deltaId: 'delta-a', reconciled: true},
    {deltaId: 'delta-b', reconciled: true},
    {deltaId: 'delta-done', reconciled: true},
    {deltaId: 'delta-pending-work', reconciled: true},
  ])
  expect(
    await getDatabase().queryJson<{dirtyWorkId: string; lifecycleReason: string | null; status: string}>(`
      SELECT dirty.dirty_work_id AS dirtyWorkId, dirty.status, dirty.lifecycle_reason AS lifecycleReason
      FROM app.review_serving_dirty_work dirty
      INNER JOIN app.review_serving_dirty_work_claim_state state
        ON state.dirty_work_id = dirty.dirty_work_id
        AND state.status = dirty.status
        AND state.lifecycle_reason IS NOT DISTINCT FROM dirty.lifecycle_reason
      ORDER BY dirty.dirty_work_id
    `),
  ).toEqual([
    {dirtyWorkId: 'dirty-completed-display', lifecycleReason: null, status: 'completed'},
    {dirtyWorkId: 'dirty-pending-llm', lifecycleReason: 'repartitioned', status: 'completed'},
    {dirtyWorkId: 'dirty-running-queue', lifecycleReason: 'repartitioned', status: 'completed'},
  ])
  expect(
    await getDatabase().queryJson<{highWaterMark: number}>(`
      SELECT source_high_water_mark::INTEGER AS highWaterMark
      FROM app.review_delta_reconciliation_cursor
      WHERE source_partition = 'article:all'
    `),
  ).toEqual([{highWaterMark: 6}])

  await getDatabase().run(migrationSql)

  expect(
    await getDatabase().queryJson<{count: number; maxHighWaterMark: number}>(`
      SELECT COUNT(*)::INTEGER AS count, MAX(source_high_water_mark)::INTEGER AS maxHighWaterMark
      FROM app.review_change_delta
      WHERE source_partition = 'article:all'
    `),
  ).toEqual([{count: 3, maxHighWaterMark: 6}])
})
