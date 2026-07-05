import {expect, test} from 'bun:test'

import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {
  getReviewServingSearchAvailabilityFromManifest,
  projectReviewServingTitleSearchRebuildRows,
  projectReviewServingTitleSearchRows,
  type ReviewServingTitleSearchProjectorDatabase,
} from './reviewServingTitleSearchProjector.ts'

const createTitleSearchDatabase = (input?: {rows?: readonly Record<string, unknown>[]}) => {
  const statements: string[] = []
  const database: ReviewServingTitleSearchProjectorDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('FROM app.review_source_change_outbox')) {
        return [] as T[]
      }

      return (input?.rows ?? []) as T[]
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

const searchClaim = (input?: Partial<ReviewServingDirtyWorkClaim>): ReviewServingDirtyWorkClaim => {
  return {
    articleId: 'article-1',
    dirtyKind: 'article.searchText.updated',
    dirtyRangeEnd: null,
    dirtyRangeStart: null,
    dirtyWorkId: 'dirty-work-search-1',
    firstSourceHighWaterMark: 5,
    latestDeltaId: 'delta-search-1',
    latestSourceHighWaterMark: 9,
    projectId: 'project-1',
    projectionComponent: 'search',
    projectionIdentity: 'search:identity-1',
    scopeId: 'project-1:article-1',
    scopeKind: 'article',
    sourcePartition: 'review-change:article',
    status: 'running',
    ...input,
  }
}

test('title search projection writes token rows and search-only component state for dirty articles', async () => {
  const {database, statements} = createTitleSearchDatabase({
    rows: [
      {
        activitySortAt: '2026-01-02T00:00:00.000Z',
        articleId: 'article-1',
        articleTitle: 'Alpha Beta alpha',
        tombstone: false,
      },
    ],
  })

  const result = await projectReviewServingTitleSearchRows(
    {
      baseGeneration: 2,
      claims: [searchClaim()],
      definitionVersion: 'search-v4-test',
      projectId: 'project-1',
      projectScopeIdentity: 'projectScope:identity-1',
      projectionIdentity: 'search:identity-1',
      searchIdentity: 'search:identity-1',
      selectedImportSnapshotId: 'selected-import-snapshot-1',
      snapshotId: 'snapshot-1',
    },
    database,
  )
  const selectStatement = statements.find((statement) => {
    return statement.includes('WITH dirty_article(article_id)')
  })
  const deleteStatement = statements.find((statement) => {
    return statement.includes('DELETE FROM mart.review_title_search_serving_v4')
  })
  const inserts = statements.filter((statement) => {
    return statement.includes('INSERT INTO mart.review_title_search_serving_v4')
  })
  const joined = statements.join('\n')

  expect(result).toEqual({patchWatermark: 9, searchRowCount: 2})
  expect(selectStatement).toContain("VALUES ('article-1')")
  expect(selectStatement).toContain('LEFT JOIN app.review_selected_article_import_v4 selected_base')
  expect(selectStatement).toContain('LEFT JOIN mart.review_selected_import_patch_v4 selected_patch')
  expect(selectStatement).toContain(
    'WHEN selected_patch.patch_watermark IS NOT NULL THEN COALESCE(selected_patch.article_title, article.article_title)',
  )
  expect(selectStatement).toContain('ELSE COALESCE(selected_base.article_title, article.article_title)')
  expect(selectStatement).toContain('FROM mart.review_selected_import_patch_v4 newer')
  expect(deleteStatement).toContain('search_identity')
  expect(inserts).toHaveLength(1)
  expect(inserts.join('\n')).toContain("'alpha'")
  expect(inserts.join('\n')).toContain("'beta'")
  expect(inserts.join('\n')).not.toContain('regexp_split_to_array')
  expect(joined).toContain("'search'")
  expect(joined).toContain('title-token-v1:article.searchText.updated')
  expect(joined).not.toContain("'judgmentInputContent'")
  expect(joined).not.toContain("'selectedImport'")
})

test('title search direct projection reads selected import base rows without patch overlay', async () => {
  const {database, statements} = createTitleSearchDatabase({
    rows: [
      {
        activitySortAt: '2026-01-02T00:00:00.000Z',
        articleId: 'article-1',
        articleTitle: 'Selected Base',
        tombstone: false,
      },
    ],
  })

  const result = await projectReviewServingTitleSearchRows(
    {
      baseGeneration: 2,
      projectId: 'project-1',
      projectScopeIdentity: 'projectScope:identity-1',
      searchIdentity: 'search:identity-1',
      selectedImportSnapshotId: 'selected-import-snapshot-1',
      snapshotId: 'snapshot-1',
    },
    database,
  )
  const selectStatement = statements.find((statement) => {
    return statement.includes('FROM mart.project_scope_article scope')
  })

  expect(result).toEqual({patchWatermark: 0, searchRowCount: 2})
  expect(selectStatement).toContain('LEFT JOIN app.review_selected_article_import_v4 selected_base')
  expect(selectStatement).toContain('ELSE COALESCE(selected_base.article_title, article.article_title)')
  expect(selectStatement).not.toContain('mart.review_selected_import_patch_v4')
  expect(selectStatement).not.toContain('selected_patch')
})

test('project-scoped title search rebuilds scoped articles and clears snapshot search rows', async () => {
  const {database, statements} = createTitleSearchDatabase({
    rows: [
      {
        activitySortAt: '2026-01-02T00:00:00.000Z',
        articleId: 'article-2',
        articleTitle: 'Gamma Delta',
        tombstone: false,
      },
    ],
  })

  const result = await projectReviewServingTitleSearchRows(
    {
      baseGeneration: 2,
      claims: [
        searchClaim({
          articleId: null,
          dirtyKind: 'project.reviewConfig.updated',
          scopeId: 'project-1',
          scopeKind: 'project',
        }),
      ],
      definitionVersion: 'search-v4-test',
      projectId: 'project-1',
      projectScopeIdentity: 'projectScope:identity-1',
      projectionIdentity: 'search:identity-1',
      searchIdentity: 'search:identity-1',
      snapshotId: 'snapshot-1',
    },
    database,
  )
  const selectStatement = statements.find((statement) => {
    return statement.includes('FROM mart.project_scope_article scope')
  })
  const deleteStatement = statements.find((statement) => {
    return statement.includes('DELETE FROM mart.review_title_search_serving_v4')
  })

  expect(result).toEqual({patchWatermark: 9, searchRowCount: 2})
  expect(selectStatement).not.toContain('WITH dirty_article(article_id)')
  expect(selectStatement).not.toContain('dirty_article(article_id)')
  expect(selectStatement).not.toContain('INNER JOIN dirty_article dirty')
  expect(deleteStatement).toContain("project_id IS NOT DISTINCT FROM 'project-1'")
  expect(deleteStatement).toContain("snapshot_id IS NOT DISTINCT FROM 'snapshot-1'")
  expect(deleteStatement).toContain('search_identity')
  expect(deleteStatement).not.toContain('article_id IN')
})

test('sql-native title search rebuild clears stale chunk tokens before inserting current tokens', async () => {
  const {database, statements} = createTitleSearchDatabase()

  await projectReviewServingTitleSearchRebuildRows(
    {
      baseGeneration: 2,
      chunkEndArticleId: 'article-099',
      chunkStartArticleId: 'article-001',
      projectId: 'project-1',
      projectScopeIdentity: 'projectScope:identity-1',
      searchIdentity: 'search:identity-1',
      selectedImportSnapshotId: 'selected-import-snapshot-1',
      snapshotId: 'snapshot-1',
    },
    database,
  )
  const deleteStatement = statements.find((statement) => {
    return statement.includes('DELETE FROM mart.review_title_search_serving_v4 search')
  })
  const insertStatement = statements.find((statement) => {
    return statement.includes('INSERT INTO mart.review_title_search_serving_v4')
  })

  expect(statements.indexOf(deleteStatement ?? '')).toBeLessThan(statements.indexOf(insertStatement ?? ''))
  expect(deleteStatement).toContain("search.project_id = 'project-1'")
  expect(deleteStatement).toContain("search.search_identity = 'search:identity-1'")
  expect(deleteStatement).toContain("search.project_scope_identity = 'projectScope:identity-1'")
  expect(deleteStatement).toContain("search.snapshot_id = 'snapshot-1'")
  expect(deleteStatement).toContain("search.article_id >= 'article-001'")
  expect(deleteStatement).toContain("search.article_id <= 'article-099'")
  expect(insertStatement).toContain('LEFT JOIN app.review_selected_article_import_v4 selected_base')
  expect(insertStatement).not.toContain('mart.review_selected_import_patch_v4')
  expect(insertStatement).not.toContain('selected_patch')
  expect(insertStatement).toContain('CROSS JOIN unnest(regexp_split_to_array')
})

test('search availability distinguishes ready indexing unavailable and async states', () => {
  expect(
    getReviewServingSearchAvailabilityFromManifest({
      hasActiveSnapshot: false,
      optionalComponents: [],
      optionalSearchStatePresent: false,
    }),
  ).toBe('unavailable')
  expect(
    getReviewServingSearchAvailabilityFromManifest({
      hasActiveSnapshot: true,
      optionalComponents: ['search'],
      optionalSearchStatePresent: false,
    }),
  ).toBe('indexing')
  expect(
    getReviewServingSearchAvailabilityFromManifest({
      hasActiveSnapshot: true,
      optionalComponents: ['search'],
      optionalSearchStatePresent: true,
    }),
  ).toBe('ready')
  expect(
    getReviewServingSearchAvailabilityFromManifest({
      hasActiveSnapshot: true,
      optionalComponents: [],
      optionalSearchStatePresent: false,
    }),
  ).toBe('async')
})
