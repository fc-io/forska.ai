import {expect, test} from 'bun:test'

import {
  getCompareProjectOptimisticConflictResolution,
  getCompareProjectOptimisticConflictResolutionComment,
} from './compareProjectOptimisticConflictResolution.ts'

const setAt = new Date('2026-10-10T12:34:56.000Z')

test('optimistic conflict resolution assumes a UI save under the active judgment context', () => {
  expect(
    getCompareProjectOptimisticConflictResolution({
      activeGeneration: 7,
      articleId: 'article-1',
      judgmentContextId: 'context-current',
      label: 'Include',
      previousConflictResolution: null,
      setAt,
      value: 'yes',
    }),
  ).toEqual({
    articleId: 'article-1',
    comment: null,
    commentUpdatedAt: null,
    label: 'Include',
    provenance: {contextId: 'context-current', generation: 7, origin: 'ui', setAt: '2026-10-10T12:34:56.000Z'},
    provenanceMatchesCurrent: true,
    reviewer: null,
    reviewerDisplayName: null,
    reviewerUserId: null,
    setAt: '2026-10-10T12:34:56.000Z',
    value: 'yes',
  })
})

test('optimistic conflict resolution leaves the match unknown when the active generation has no context', () => {
  const resolution = getCompareProjectOptimisticConflictResolution({
    activeGeneration: null,
    articleId: 'article-1',
    judgmentContextId: null,
    label: 'no',
    previousConflictResolution: null,
    setAt,
    value: 'no',
  })

  expect(resolution.provenanceMatchesCurrent).toBeNull()
  expect(resolution.provenance).toEqual({contextId: null, generation: null, origin: 'ui', setAt: setAt.toISOString()})
})

test('optimistic re-resolution keeps the previous comment, like the server carry-over', () => {
  const previousConflictResolution = getCompareProjectOptimisticConflictResolution({
    activeGeneration: 7,
    articleId: 'article-1',
    judgmentContextId: 'context-current',
    label: 'maybe',
    previousConflictResolution: null,
    setAt,
    value: 'maybe',
  })
  const commented = getCompareProjectOptimisticConflictResolutionComment({
    comment: 'Population unclear',
    commentUpdatedAt: new Date('2026-10-10T12:40:00.000Z'),
    conflictResolution: previousConflictResolution,
  })
  const reResolved = getCompareProjectOptimisticConflictResolution({
    activeGeneration: 7,
    articleId: 'article-1',
    judgmentContextId: 'context-current',
    label: 'yes',
    previousConflictResolution: commented,
    setAt,
    value: 'yes',
  })

  expect(commented).toEqual({
    ...previousConflictResolution,
    comment: 'Population unclear',
    commentUpdatedAt: '2026-10-10T12:40:00.000Z',
  })
  expect(reResolved).toMatchObject({
    comment: 'Population unclear',
    commentUpdatedAt: '2026-10-10T12:40:00.000Z',
    value: 'yes',
  })
})
