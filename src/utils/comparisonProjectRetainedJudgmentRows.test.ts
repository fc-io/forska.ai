import {expect, test} from 'bun:test'

import type {ComparisonProjectJudgmentsRow} from '../services/comparisonProjectsService.ts'
import {getComparisonProjectJudgmentRowsWithRetainedEdits} from './comparisonProjectRetainedJudgmentRows.ts'

const getRow = (
  canonicalArticleId: string,
  conflictResolution: ComparisonProjectJudgmentsRow['conflictResolution'] = null,
): ComparisonProjectJudgmentsRow => {
  return {
    articleCreatedAt: null,
    articleExternalId: null,
    articleSummary: null,
    articleTitle: canonicalArticleId,
    canonicalArticleId,
    cells: {},
    conflictResolution,
    hasConflict: true,
    id: canonicalArticleId,
  }
}

test('appends retained conflict-resolution edits that no longer match the server filter', () => {
  const serverRows = [getRow('article-1')]
  const retainedRows = {
    'article-2': getRow('article-2', {
      articleId: 'article-2',
      label: 'no',
      reviewerDisplayName: 'Reviewer',
      reviewerUserId: 'reviewer-1',
      value: 'no',
    }),
  }

  expect(
    getComparisonProjectJudgmentRowsWithRetainedEdits(serverRows, retainedRows).map((row) => {
      return row.id
    }),
  ).toEqual(['article-1', 'article-2'])
})

test('does not duplicate retained edits still present in the server-filtered rows', () => {
  const serverRows = [
    getRow('article-1', {
      articleId: 'article-1',
      label: 'yes',
      reviewerDisplayName: null,
      reviewerUserId: null,
      value: 'yes',
    }),
  ]
  const retainedRows = {
    'article-1': getRow('article-1', {
      articleId: 'article-1',
      label: 'no',
      reviewerDisplayName: 'Reviewer',
      reviewerUserId: 'reviewer-1',
      value: 'no',
    }),
  }

  expect(getComparisonProjectJudgmentRowsWithRetainedEdits(serverRows, retainedRows)).toEqual(serverRows)
})
