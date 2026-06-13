import {expect, test} from 'bun:test'

import {
  decodeReviewServingCursor,
  encodeReviewServingCursor,
  getReviewServingFilterSignature,
  type ReviewServingCursorPayload,
  validateReviewServingCursor,
} from './reviewServingCursor.ts'

const componentStates = {
  display: {baseGeneration: '10', patchWatermark: '14', projectionIdentity: 'display:abc'},
  llmStatus: {baseGeneration: '22', patchWatermark: '23', projectionIdentity: 'llmStatus:def'},
} as const

const payload: ReviewServingCursorPayload = {
  articleId: 'article-1',
  componentStates,
  contractKey: 'review.llm.rows',
  filterSignature: getReviewServingFilterSignature({filters: {promptAnswer: ['yes']}, listMode: 'llm'}),
  reviewConfigHash: 'review:123',
  snapshotId: 'snapshot-1',
  sortDirection: 'desc',
  sortValues: ['2026-01-01T00:00:00.000Z', 'article-1'],
  version: 1,
}

const validationContext = {
  componentStates,
  contractKey: payload.contractKey,
  filterSignature: payload.filterSignature,
  reviewConfigHash: payload.reviewConfigHash,
  snapshotId: payload.snapshotId,
  sortDirection: payload.sortDirection,
}

test('review serving cursors round trip through base64url encoding', () => {
  const encoded = encodeReviewServingCursor(payload)
  const decoded = decodeReviewServingCursor(encoded)

  expect(decoded.valid).toBe(true)
  expect(decoded.valid ? decoded.payload : null).toEqual(payload)
})

test('review serving filter signatures are stable for equivalent filters', () => {
  const left = getReviewServingFilterSignature({filters: {b: ['2'], a: ['1']}, listMode: 'llm'})
  const right = getReviewServingFilterSignature({listMode: 'llm', filters: {a: ['1'], b: ['2']}})

  expect(left).toBe(right)
})

test('validateReviewServingCursor rejects config hash mismatch', () => {
  const result = validateReviewServingCursor(payload, {...validationContext, reviewConfigHash: 'review:other'})

  expect(result).toEqual({reason: 'reviewConfigHashMismatch', valid: false})
})

test('validateReviewServingCursor rejects component base generation mismatch', () => {
  const result = validateReviewServingCursor(payload, {
    ...validationContext,
    componentStates: {...componentStates, display: {...componentStates.display, baseGeneration: '11'}},
  })

  expect(result).toEqual({reason: 'componentBaseGenerationMismatch', valid: false})
})

test('validateReviewServingCursor rejects filter and sort mismatches', () => {
  const filterResult = validateReviewServingCursor(payload, {...validationContext, filterSignature: 'filter:other'})
  const sortResult = validateReviewServingCursor(payload, {...validationContext, sortDirection: 'asc'})

  expect(filterResult).toEqual({reason: 'filterSignatureMismatch', valid: false})
  expect(sortResult).toEqual({reason: 'sortDirectionMismatch', valid: false})
})

test('decodeReviewServingCursor rejects malformed cursors', () => {
  const decoded = decodeReviewServingCursor('not-json')

  expect(decoded).toEqual({reason: 'malformedCursor', valid: false})
})
