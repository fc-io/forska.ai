import {expect, test} from 'bun:test'

import {
  getReviewServingDirtyWorkScopeForChange,
  getReviewServingDirtyWorkScopeKey,
  getReviewServingLeaseOwner,
  getReviewServingProjectionComponentIdentityKey,
  getReviewServingProjectorWatermarkId,
  getReviewServingSourcePartitionWatermarks,
} from './reviewServingProjectorDomain.ts'

test('projection component identity keys are stable and scoped by component identity', () => {
  const input = {projectId: 'project-a', projectionComponent: 'display', projectionIdentity: 'display:abc'} as const
  const sameInputDifferentObjectOrder = {
    projectionIdentity: 'display:abc',
    projectionComponent: 'display',
    projectId: 'project-a',
  } as const
  const changedComponent = {...input, projectionComponent: 'search'} as const

  expect(getReviewServingProjectionComponentIdentityKey(input)).toBe(
    getReviewServingProjectionComponentIdentityKey(sameInputDifferentObjectOrder),
  )
  expect(getReviewServingProjectionComponentIdentityKey(input)).not.toBe(
    getReviewServingProjectionComponentIdentityKey(changedComponent),
  )
})

test('projector watermark ids are stable for the V4 foundation identity columns', () => {
  const input = {
    importRouteId: null,
    projectId: 'project-a',
    projectionComponent: 'display',
    projectorName: 'article-display-projector',
    sourcePartition: 'article.display',
  } as const
  const changedPartition = {...input, sourcePartition: 'article.search'}

  expect(getReviewServingProjectorWatermarkId(input)).toBe(getReviewServingProjectorWatermarkId({...input}))
  expect(getReviewServingProjectorWatermarkId(input)).not.toBe(getReviewServingProjectorWatermarkId(changedPartition))
})

test('dirty work scope uses invalidation registry lookup metadata', () => {
  const scope = getReviewServingDirtyWorkScopeForChange({
    changeKind: 'judgment.llm.updated',
    sourceHighWaterMark: 42,
    sourcePartition: 'review_change_delta:project-a',
    values: {
      articleId: 'article-a',
      contentFlags: {useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true},
      judgmentId: 'judgment-a',
      modelId: 'model-a',
      projectId: 'project-a',
      promptId: 'prompt-a',
      sourceHighWaterMark: 42,
    },
  })

  expect(scope).toEqual({
    affectedComponents: ['llmStatus', 'queue', 'posting', 'summary', 'payload'],
    dirtyKind: 'judgment.llm.updated',
    dirtyRangeEnd: null,
    dirtyRangeStart: null,
    firstAffectedComponent: 'llmStatus',
    projectId: 'project-a',
    projectionKey: null,
    scopeId: 'project-a:article-a',
    scopeKind: 'article',
    sourceHighWaterMark: 42,
    sourcePartition: 'review_change_delta:project-a',
  })
  expect(scope === null ? null : getReviewServingDirtyWorkScopeKey(scope)).toMatch(/^dirty:[a-f0-9]{32}$/)
})

test('dirty work scope returns null for unknown or incomplete invalidation input', () => {
  const baseInput = {
    sourceHighWaterMark: 42,
    sourcePartition: 'review_change_delta:project-a',
    values: {articleId: 'article-a', sourceHighWaterMark: 42},
  }

  expect(getReviewServingDirtyWorkScopeForChange({...baseInput, changeKind: 'project.everything.changed'})).toBeNull()
  expect(getReviewServingDirtyWorkScopeForChange({...baseInput, changeKind: 'judgment.human.updated'})).toBeNull()
})

test('source partition watermarks map dirty partitions to promotion source keys', () => {
  expect(
    getReviewServingSourcePartitionWatermarks([
      {latestSourceHighWaterMark: 10, sourcePartition: 'projectReviewConfig:project-a'},
      {latestSourceHighWaterMark: 12, sourcePartition: 'projectScope:project-a'},
      {latestSourceHighWaterMark: 14, sourcePartition: 'importRoute:route-a'},
    ]),
  ).toEqual({
    importRoute: 14,
    importRunArticle: 14,
    projectReviewConfig: 10,
    projectScope: 12,
    reviewChange: 10,
  })
})

test('lease owner values are non-empty strings', () => {
  expect(getReviewServingLeaseOwner(' worker-a ')).toBe('worker-a')
  expect(getReviewServingLeaseOwner('   ')).toBeNull()
})
