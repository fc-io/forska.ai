import {expect, test} from 'bun:test'

import {getReviewJudgmentChunkingLabel} from './reviewJudgmentChunkingLabel.ts'

test('the review chunking line names the full-text mode, part count and plan, and keeps historical strategies', () => {
  expect(
    getReviewJudgmentChunkingLabel({chunkCount: 3, chunkPlanHash: '9a5efe878a95c0de', fullTextMode: 'chunked'}),
  ).toBe('yes (full text in 3 parts, plan 9a5efe87)')
  expect(getReviewJudgmentChunkingLabel({fullTextMode: 'single'})).toBe('no (full text in one request)')
  expect(getReviewJudgmentChunkingLabel({chunkingStrategy: 'article_heading_greedy'})).toBe(
    'yes (article_heading_greedy)',
  )
  expect(getReviewJudgmentChunkingLabel({})).toBe('no')
})
