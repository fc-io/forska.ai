import {expect, test} from 'bun:test'

import {
  getReviewIndexingInProgressTitle,
  getReviewIndexingQueuedBody,
  getReviewIndexingQueuedTitle,
  getReviewIndexingStalledBody,
  getReviewIndexingStalledTitle,
} from './getReviewIndexingInProgressTitle.ts'

test('review indexing queued copy does not claim active progress', () => {
  expect(getReviewIndexingQueuedTitle('project-1')).toBe('Review indexing queued for project project-1')
  expect(getReviewIndexingQueuedTitle('project-1')).not.toContain('in progress')
  expect(getReviewIndexingQueuedBody()).toContain('queued')
})

test('review indexing progress copy is reserved for active progress', () => {
  expect(getReviewIndexingInProgressTitle('project-1')).toBe('Review indexing in progress for project project-1')
})

test('review indexing stalled copy does not claim active progress', () => {
  expect(getReviewIndexingStalledTitle()).toBe('Review indexing stalled')
  expect(getReviewIndexingStalledTitle()).not.toContain('in progress')
  expect(getReviewIndexingStalledBody()).toContain('not made progress')
})
