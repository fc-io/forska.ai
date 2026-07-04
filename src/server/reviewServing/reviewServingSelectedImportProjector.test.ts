import {readFileSync} from 'node:fs'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

import {
  projectReviewServingSelectedImportArticleRange,
  projectReviewServingSelectedImportBatch,
  type ReviewServingSelectedImportProjectorDatabase,
} from './reviewServingSelectedImportProjector.ts'

const createSelectedImportProjectorDatabase = (input?: {
  batchRows?: readonly Record<string, unknown>[]
  cursorJson?: unknown
  rangeRowCount?: number
}) => {
  const statements: string[] = []
  const database: ReviewServingSelectedImportProjectorDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('FROM app.review_selected_import_snapshot')) {
        return input?.cursorJson === undefined ? [] : ([{cursorJson: input.cursorJson, status: 'candidate'}] as T[])
      }

      if (statement.includes('FROM app.review_projection_identity_manifest')) {
        return [] as T[]
      }

      if (statement.includes('COUNT(*)') && statement.includes('FROM app.review_selected_article_import_v4 selected')) {
        return [{rowCount: input?.rangeRowCount ?? 0}] as T[]
      }

      return (input?.batchRows ?? []) as T[]
    },
    run: async (statement: string) => {
      statements.push(statement)
    },
    transaction: async (operation) => {
      return operation(database)
    },
  }

  return {database, statements}
}

const selectedImportRow = (input: {articleId: string; rankKeySort: string; rankNumericSort: number}) => {
  return {
    articleId: input.articleId,
    articleTitle: `Title ${input.articleId}`,
    conflictFlag: false,
    duplicateFlag: false,
    externalId: `external-${input.articleId}`,
    importRouteId: 'import-route-1',
    journalTitle: 'Journal',
    publicationYear: 2026,
    rankKeySort: input.rankKeySort,
    rankNumericSort: input.rankNumericSort,
    selectedRankKey: input.rankKeySort,
    selectedRankNumeric: input.rankNumericSort,
    sourceRecordKey: `source-${input.articleId}`,
    tombstone: false,
  }
}

test('selected-import projector creates snapshot cursor and selected article import rows', async () => {
  const {database, statements} = createSelectedImportProjectorDatabase({
    batchRows: [
      selectedImportRow({articleId: 'article-1', rankKeySort: '0000:article-1:source-1', rankNumericSort: 0}),
    ],
  })

  const result = await projectReviewServingSelectedImportBatch(
    {limit: 2, projectId: 'project-1', projectScopeIdentity: 'projectScope:identity-1', sourceDeltaHighWater: 9},
    database,
  )

  expect(result).toMatchObject({insertedRowCount: 1, status: 'completed'})
  expect(result.selectedImportSnapshotId).toStartWith('selectedImport:')
  expect(
    statements.some((statement) => {
      return statement.includes('INSERT INTO app.review_selected_article_import_v4')
    }),
  ).toBe(true)
  expect(
    statements.some((statement) => {
      return statement.includes('INSERT INTO app.review_selected_import_snapshot') && statement.includes("'completed'")
    }),
  ).toBe(true)
  expect(
    statements.some((statement) => {
      return (
        statement.includes('INSERT INTO app.review_projection_identity_manifest')
        && statement.includes("'selectedImport'")
      )
    }),
  ).toBe(true)
  expect(statements.join('\n')).toContain('"processedRowCount":1')
})

test('selected-import projector resumes after snapshot cursor checkpoint', async () => {
  const {database, statements} = createSelectedImportProjectorDatabase({
    batchRows: [
      selectedImportRow({articleId: 'article-3', rankKeySort: '0002:article-3:source-3', rankNumericSort: 2}),
    ],
    cursorJson: JSON.stringify({
      articleId: 'article-2',
      processedRowCount: 2,
      rankKeySort: '0001:article-2:source-2',
      rankNumericSort: 1,
    }),
  })

  await projectReviewServingSelectedImportBatch(
    {
      limit: 10,
      projectId: 'project-1',
      projectScopeIdentity: 'projectScope:identity-1',
      selectedImportSnapshotId: 'selected-import-1',
      sourceDeltaHighWater: 9,
    },
    database,
  )

  const batchSelect = statements.find((statement) => {
    return statement.includes('WITH selected_import_candidates AS')
  })

  expect(batchSelect).toContain('candidate.rank_numeric_sort > 1')
  expect(batchSelect).toContain("candidate.rank_key_sort > '0001:article-2:source-2'")
  expect(batchSelect).toContain("candidate.article_id > 'article-2'")
  expect(statements.join('\n')).toContain('"processedRowCount":3')
})

test('selected-import projector reads project scope and hot fields in bounded deterministic batches', async () => {
  const {database, statements} = createSelectedImportProjectorDatabase({batchRows: []})

  await projectReviewServingSelectedImportBatch(
    {
      limit: 3.9,
      projectId: 'project-1',
      projectScopeIdentity: 'projectScope:identity-1',
      selectedImportSnapshotId: 'selected-import-1',
      sourceDeltaHighWater: 9,
    },
    database,
  )

  const batchSelect = statements.find((statement) => {
    return statement.includes('WITH selected_import_candidates AS')
  })

  expect(batchSelect).toContain('FROM mart.project_scope_article scope')
  expect(batchSelect).toContain('SELECT DISTINCT')
  expect(batchSelect).toContain('INNER JOIN app.review_import_article_hot_field hot')
  expect(batchSelect).toContain('LEFT JOIN app.article_import_route current_link')
  expect(batchSelect).toContain("WHEN current_link.id IS NOT NULL THEN concat('0:', hot.selected_rank_key)")
  expect(batchSelect).toContain('ROW_NUMBER() OVER')
  expect(batchSelect).toContain('PARTITION BY candidate.article_id')
  expect(batchSelect).toContain('candidate.import_route_id ASC')
  expect(batchSelect).toContain(
    'ORDER BY candidate.rank_numeric_sort ASC, candidate.rank_key_sort ASC, candidate.article_id ASC',
  )
  expect(batchSelect).toContain('LIMIT 3')
})

test('selected-import article range rebuild writes selected rows directly in SQL', async () => {
  const {database, statements} = createSelectedImportProjectorDatabase({
    batchRows: [
      selectedImportRow({articleId: 'article-1', rankKeySort: '0000:article-1:source-1', rankNumericSort: 0}),
    ],
    rangeRowCount: 7,
  })

  const result = await projectReviewServingSelectedImportArticleRange(
    {
      chunkEndArticleId: 'article-9',
      chunkStartArticleId: 'article-1',
      projectId: 'project-1',
      projectScopeIdentity: 'projectScope:identity-1',
      selectedImportSnapshotId: 'selected-import-snapshot-1',
      sourceDeltaHighWater: 9,
    },
    database,
  )

  const deleteStatement = statements.find((statement) => {
    return statement.includes('DELETE FROM app.review_selected_article_import_v4')
  })
  const insertStatement = statements.find((statement) => {
    return statement.includes('INSERT INTO app.review_selected_article_import_v4')
  })
  const sourceQueries = statements.filter((statement) => {
    return statement.includes('WITH selected_import_candidates AS') && !statement.includes('INSERT INTO')
  })

  expect(result.insertedRowCount).toBe(7)
  expect(deleteStatement).toContain("project_id = 'project-1'")
  expect(deleteStatement).toContain("project_scope_identity = 'projectScope:identity-1'")
  expect(deleteStatement).toContain("selected_import_snapshot_id = 'selected-import-snapshot-1'")
  expect(deleteStatement).toContain("article_id >= 'article-1'")
  expect(deleteStatement).toContain("article_id <= 'article-9'")
  expect(insertStatement).toContain('WITH selected_import_candidates AS')
  expect(insertStatement).toContain('ROW_NUMBER() OVER')
  expect(insertStatement).toContain("WHEN current_link.id IS NOT NULL THEN concat('0:', hot.selected_rank_key)")
  expect(insertStatement).toContain(
    'ON CONFLICT(project_id, project_scope_identity, selected_import_snapshot_id, article_id) DO UPDATE SET',
  )
  expect(sourceQueries).toHaveLength(0)
})

test('selected-import V4 projector does not use the runtime selected scoped import CTE', () => {
  const source = readFileSync(join(import.meta.dir, 'reviewServingSelectedImportProjector.ts'), 'utf8')

  expect(source).not.toContain('selected_scoped_article_import')
})

test('selected-import snapshot identity is bumped for rank-key sort format changes', () => {
  const source = readFileSync(join(import.meta.dir, 'reviewServingSelectedImportProjector.ts'), 'utf8')

  expect(source).toContain("const selectedImportProjectorDefinitionVersion = 'review-serving-selected-import-v2'")
  expect(source).toContain("WHEN current_link.id IS NOT NULL THEN concat('0:', hot.selected_rank_key)")
  expect(source).toContain("ELSE concat('1:', hot.selected_rank_key)")
})
