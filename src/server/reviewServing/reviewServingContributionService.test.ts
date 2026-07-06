import {expect, test} from 'bun:test'

import {
  getReviewServingContributionDiffs,
  type ReviewServingContributionComponentKind,
} from './reviewServingContributionService.ts'

test('computes in-memory old/new contribution diffs for counts, facets, badges, queues, and posting stats', () => {
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

test('contribution diffs do not create runtime SQL for the legacy summary contribution table', async () => {
  const serviceSource = await globalThis.Bun.file(import.meta.dir + '/reviewServingContributionService.ts').text()

  expect(serviceSource).not.toContain('review_article_summary_contribution_v4')
})
