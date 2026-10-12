import {expect, test} from 'bun:test'

import {
  getCompareProjectOptimisticConflictComment,
  getCompareProjectOptimisticConflictResolution,
} from './compareProjectOptimisticConflictResolution.ts'

const setAt = new Date('2026-10-10T12:34:56.000Z')

test('optimistic conflict resolution assumes a UI save under the active judgment context', () => {
  expect(
    getCompareProjectOptimisticConflictResolution({
      activeGeneration: 7,
      articleId: 'article-1',
      judgmentContextId: 'context-current',
      label: 'Include',
      setAt,
      value: 'yes',
    }),
  ).toEqual({
    articleId: 'article-1',
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
    setAt,
    value: 'no',
  })

  expect(resolution.provenanceMatchesCurrent).toBeNull()
  expect(resolution.provenance).toEqual({contextId: null, generation: null, origin: 'ui', setAt: setAt.toISOString()})
})

test('optimistic conflict comment keeps the previous author until the server answers, and null removes it', () => {
  const updatedAt = new Date('2026-10-10T12:40:00.000Z')
  const added = getCompareProjectOptimisticConflictComment({
    comment: 'Population unclear',
    previousConflictComment: null,
    updatedAt,
  })
  const edited = getCompareProjectOptimisticConflictComment({
    comment: 'Population clear',
    previousConflictComment: {
      author: {displayName: 'Dr Local', userId: 'local-user'},
      comment: 'Population unclear',
      updatedAt: '2026-10-10T12:00:00.000Z',
    },
    updatedAt,
  })

  expect(added).toEqual({author: null, comment: 'Population unclear', updatedAt: '2026-10-10T12:40:00.000Z'})
  expect(edited).toEqual({
    author: {displayName: 'Dr Local', userId: 'local-user'},
    comment: 'Population clear',
    updatedAt: '2026-10-10T12:40:00.000Z',
  })
  expect(getCompareProjectOptimisticConflictComment({comment: null, previousConflictComment: edited, updatedAt})).toBe(
    null,
  )
})
