import {expect, test} from 'bun:test'

import {
  getReviewServingContributionDiffs,
  prepareReviewServingContributionDiff,
  type ReviewServingContributionComponentKind,
  type StoredReviewServingContributionRow,
} from './reviewServingContributionService.ts'
import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'

const claim = (input?: Partial<ReviewServingDirtyWorkClaim>): ReviewServingDirtyWorkClaim => {
  return {
    articleId: 'article-1',
    dirtyKind: 'judgment.llm.updated',
    dirtyRangeEnd: null,
    dirtyRangeStart: null,
    dirtyWorkId: 'dirty-work-1',
    firstSourceHighWaterMark: 10,
    latestDeltaId: 'delta-1',
    latestSourceHighWaterMark: 12,
    projectId: 'project-1',
    projectionComponent: 'summary',
    projectionIdentity: 'summary:identity-1',
    scopeId: 'project-1:article-1',
    scopeKind: 'article',
    sourcePartition: 'review-change:article-1',
    status: 'running',
    ...input,
  }
}

const createDatabase = (storedRows: readonly StoredReviewServingContributionRow[]) => {
  const statements: string[] = []

  return {
    database: {
      queryJson: async <T>(statement: string) => {
        statements.push(statement)

        return statement.includes('mart.review_article_summary_contribution_v4') ? (storedRows as T[]) : []
      },
    },
    statements,
  }
}

const prepareInput = (input?: {
  componentKind?: ReviewServingContributionComponentKind
  expectedArticleIds?: readonly string[]
  newKey?: string
  oldKey?: string
  requireExistingState?: boolean
}) => {
  return {
    claims: [claim()],
    componentKind: input?.componentKind ?? 'count',
    expectedArticleIds: input?.expectedArticleIds ?? ['article-1'],
    newRows: [{articleId: 'article-1', contributionKey: input?.newKey ?? 'new', contributionValue: 1}],
    projectId: 'project-1',
    projectionComponent: 'summary' as const,
    projectionIdentity: 'summary:identity-1',
    requireExistingState: input?.requireExistingState ?? false,
    reviewConfigHash: 'review-config-1',
    snapshotId: 'snapshot-1',
    summaryDefinitionVersion: 'definition-v1',
  }
}

test('computes old/new contribution diffs for counts, facets, badges, queues, and posting stats', () => {
  const componentKinds: readonly ReviewServingContributionComponentKind[] = [
    'count',
    'facet',
    'badge',
    'queue',
    'posting',
  ]

  componentKinds.map((componentKind) => {
    const diffs = getReviewServingContributionDiffs({
      newRows: [{articleId: 'article-1', contributionKey: `${componentKind}:new`, contributionValue: 1}],
      oldRows: [{articleId: 'article-1', contributionKey: `${componentKind}:old`, contributionValue: 1}],
    })

    expect(diffs).toContainEqual({contributionKey: `${componentKind}:old`, delta: -1})
    expect(diffs).toContainEqual({contributionKey: `${componentKind}:new`, delta: 1})

    return componentKind
  })
})

test('answer changes produce negative old and positive new deltas and contribution records', async () => {
  const {database} = createDatabase([
    {
      articleId: 'article-1',
      contributionKey: 'answer:no',
      contributionValue: 1,
      summaryDefinitionVersion: 'definition-v1',
    },
  ])

  const result = await prepareReviewServingContributionDiff(
    prepareInput({componentKind: 'facet', newKey: 'answer:yes'}),
    database,
  )

  expect(result.diffs).toContainEqual({contributionKey: 'answer:no', delta: -1})
  expect(result.diffs).toContainEqual({contributionKey: 'answer:yes', delta: 1})
  expect(result.contributionRecords).toHaveLength(1)
  expect(result.deleteContributionStateStatement).toContain('DELETE FROM mart.review_article_summary_contribution_v4')
})

test('deletes and membership removals remove old contributions without new foreground aggregation', async () => {
  const {database} = createDatabase([
    {
      articleId: 'article-1',
      contributionKey: 'posting:route-1',
      contributionValue: 1,
      summaryDefinitionVersion: 'definition-v1',
    },
  ])

  const result = await prepareReviewServingContributionDiff(
    {...prepareInput({componentKind: 'posting'}), newRows: []},
    database,
  )

  expect(result.diffs).toEqual([{contributionKey: 'posting:route-1', delta: -1}])
  expect(result.contributionRecords).toEqual([])
  expect(result.repairRequired).toBe(false)
})

test('missing or incompatible contribution state enqueues bounded repair', async () => {
  const missingState = await prepareReviewServingContributionDiff(
    prepareInput({requireExistingState: true}),
    createDatabase([]).database,
  )
  const incompatibleState = await prepareReviewServingContributionDiff(
    prepareInput({requireExistingState: true}),
    createDatabase([
      {articleId: 'article-1', contributionKey: 'old', contributionValue: 1, summaryDefinitionVersion: 'definition-v0'},
    ]).database,
  )

  expect(missingState.repairRequired).toBe(true)
  expect(missingState.contributionRecords).toHaveLength(1)
  expect(missingState.deleteContributionStateStatement).toContain(
    'DELETE FROM mart.review_article_summary_contribution_v4',
  )
  expect(missingState.repairDirtyWork[0]?.scope.scopeKind).toBe('article')
  expect(missingState.diffs).toEqual([{contributionKey: 'new', delta: 1}])
  expect(incompatibleState.repairRequired).toBe(true)
  expect(incompatibleState.contributionRecords).toHaveLength(1)
  expect(incompatibleState.deleteContributionStateStatement).not.toContain('summary_definition_version')
  expect(incompatibleState.repairDirtyWork[0]?.scope.dirtyRangeStart).toBe('article-1')
  expect(incompatibleState.diffs).toContainEqual({contributionKey: 'old', delta: -1})
  expect(incompatibleState.diffs).toContainEqual({contributionKey: 'new', delta: 1})
})
