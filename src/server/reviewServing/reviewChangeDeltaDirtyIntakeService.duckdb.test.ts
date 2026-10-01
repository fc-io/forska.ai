import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('review-change-delta-dirty-intake-article-metadata')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const projectIds = ['project-metadata-null', 'project-metadata-off', 'project-metadata-on'] as const

let database: ReturnType<typeof getAppDatabaseService> | null = null

const getDatabase = () => {
  if (database === null) {
    throw new Error('Database not initialized')
  }

  return database
}

type DirtyWorkRow = {articleId: string; dirtyKind: string; projectId: string; projectionComponent: string}

const projectUseMetadataSql: Record<(typeof projectIds)[number], string> = {
  'project-metadata-null': 'NULL',
  'project-metadata-off': 'FALSE',
  'project-metadata-on': 'TRUE',
}

const getScopeRowsSql = () => {
  const scopeRows = [
    ...projectIds.flatMap((projectId) => {
      return ['article-abstract', 'article-metadata'].map((articleId) => {
        return {articleId, projectId}
      })
    }),
    {articleId: 'article-off-only', projectId: 'project-metadata-off'},
  ]

  return scopeRows
    .map((row) => {
      return `('${row.projectId}', '${row.articleId}', TRUE, FALSE, TIMESTAMPTZ '2026-09-20T10:00:00Z')`
    })
    .join(', ')
}

const getDirtyWorkRows = async () => {
  return getDatabase().queryJson<DirtyWorkRow>(`
    SELECT DISTINCT
      project_id AS projectId,
      article_id AS articleId,
      dirty_kind AS dirtyKind,
      projection_component AS projectionComponent
    FROM app.review_serving_dirty_work
    ORDER BY projectId, articleId, dirtyKind, projectionComponent
  `)
}

const getComponents = (rows: readonly DirtyWorkRow[], projectId: string, articleId: string) => {
  return rows
    .filter((row) => {
      return row.projectId === projectId && row.articleId === articleId
    })
    .map((row) => {
      return row.projectionComponent
    })
}

const getMissingComponents = (actual: readonly string[], expected: readonly string[]) => {
  return expected.filter((component) => {
    return !actual.includes(component)
  })
}

beforeAll(async () => {
  const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] =
    await Promise.all([
      import('../../db/migrateDuckdb.ts'),
      import('../services/appDatabaseService.ts'),
      import('../utils/duckdbService.ts'),
      import('../utils/serverRuntimeRole.ts'),
    ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()
  await migrateDuckdb()

  database = getAppDatabaseService()

  await getDatabase().run(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images, use_metadata)
    VALUES ${projectIds
      .map((projectId) => {
        return `('${projectId}', '${projectId}', 'model-1', TRUE, TRUE, FALSE, FALSE, ${projectUseMetadataSql[projectId]})`
      })
      .join(', ')}
  `)
  await getDatabase().run(`
    INSERT INTO mart.project_scope_article (project_id, article_id, in_curated_scope, in_route_scope, article_created_at)
    VALUES ${getScopeRowsSql()}
  `)
})

afterAll(async () => {
  await database?.close()
  tempRuntimeRoot.cleanup()
})

test('metadata-only article edits dirty judgment input only for projects that use article metadata', async () => {
  const [{appendArticleReviewServingDeltas}, {intakeReviewChangeDeltasToDirtyWork}] = await Promise.all([
    import('./articleReviewServingDeltaService.ts'),
    import('./reviewChangeDeltaDirtyIntakeService.ts'),
  ])

  await getDatabase().transaction(async (tx) => {
    await appendArticleReviewServingDeltas(tx, {
      articleId: 'article-metadata',
      changedFields: ['doi', 'pubmedId', 'publicationStatus', 'sourceMetadata', 'articleCreatedAt'],
      sourceMutationKey: 'test|article-metadata',
      sourceOperation: 'update',
    })
    await appendArticleReviewServingDeltas(tx, {
      articleId: 'article-abstract',
      changedFields: ['articleSummary'],
      sourceMutationKey: 'test|article-abstract',
      sourceOperation: 'update',
    })
    await appendArticleReviewServingDeltas(tx, {
      articleId: 'article-off-only',
      changedFields: ['doi'],
      sourceMutationKey: 'test|article-off-only',
      sourceOperation: 'update',
    })
  })

  const result = await intakeReviewChangeDeltasToDirtyWork(
    {endSourceHighWaterMark: 1_000, limit: 100, sourcePartition: 'article:all', startSourceHighWaterMark: 0},
    getDatabase(),
  )
  const rows = await getDirtyWorkRows()
  const unreconciled = await getDatabase().queryJson<{deltaId: string}>(`
    SELECT delta_id AS deltaId
    FROM app.review_change_delta
    WHERE source_partition = 'article:all'
      AND reconciled_at IS NULL
  `)
  const judgmentInputComponents = ['judgmentInputContent', 'llmStatus', 'queue', 'payload']

  expect(result).toMatchObject({status: 'converted'})
  expect(unreconciled).toEqual([])
  expect(
    getMissingComponents(getComponents(rows, 'project-metadata-on', 'article-metadata'), [
      'display',
      ...judgmentInputComponents,
    ]),
  ).toEqual([])
  expect(getComponents(rows, 'project-metadata-off', 'article-metadata')).toContain('display')
  expect(getComponents(rows, 'project-metadata-null', 'article-metadata')).toContain('display')
  expect(
    rows.filter((row) => {
      return (
        row.articleId !== 'article-abstract'
        && row.projectId !== 'project-metadata-on'
        && (row.dirtyKind === 'article.judgmentInput.updated'
          || judgmentInputComponents.includes(row.projectionComponent))
      )
    }),
  ).toEqual([])
  expect(
    getMissingComponents(getComponents(rows, 'project-metadata-off', 'article-off-only'), [
      'display',
      'posting',
      'summary',
    ]),
  ).toEqual([])
  expect(
    projectIds.map((projectId) => {
      return getComponents(rows, projectId, 'article-abstract').includes('judgmentInputContent')
    }),
  ).toEqual([true, true, true])
})
