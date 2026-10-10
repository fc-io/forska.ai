import {expect, test} from 'bun:test'

import {getCompareProjectOptimisticConflictResolution} from './compareProjectOptimisticConflictResolution.ts'

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
