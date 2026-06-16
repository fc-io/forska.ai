import {expect, test} from 'bun:test'

import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {
  getReviewServingSearchAvailabilityFromManifest,
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
  expect(deleteStatement).toContain('search_identity')
  expect(inserts).toHaveLength(2)
  expect(inserts.join('\n')).toContain("'alpha'")
  expect(inserts.join('\n')).toContain("'beta'")
  expect(joined).toContain("'search'")
  expect(joined).toContain('title-token-v1:article.searchText.updated')
  expect(joined).not.toContain("'judgmentInputContent'")
  expect(joined).not.toContain("'selectedImport'")
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
