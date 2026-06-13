import {expect, test} from 'bun:test'

import {
  decodeAndValidateReviewServingCursor,
  decodeReviewServingCursor,
  encodeReviewServingCursor,
  getNormalizedReviewServingFilterSignatureInput,
  getReviewServingCursorSortKey,
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
  sortKey: getReviewServingCursorSortKey(['sort_key', 'article_id']),
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
  sortKey: payload.sortKey,
}

test('review serving cursors round trip through base64url encoding', () => {
  const encoded = encodeReviewServingCursor(payload)
  const decoded = decodeReviewServingCursor(encoded)

  expect(decoded.valid).toBe(true)
  expect(decoded.valid ? decoded.payload : null).toEqual(payload)
})

test('review serving filter signatures are stable for equivalent filters', () => {
  const left = getReviewServingFilterSignature({
    filters: {b: ['2', '1', '2'], a: ['1'], empty: [], skipped: undefined},
    listMode: 'llm',
  })
  const right = getReviewServingFilterSignature({listMode: 'llm', filters: {a: ['1'], b: ['1', '2']}})

  expect(left).toBe(right)
})

test('review serving filter signatures drop empty nested filter records', () => {
  const normalized = getNormalizedReviewServingFilterSignatureInput({
    filters: {nested: {promptAnswer: []}, promptAnswer: []},
    listMode: 'llm',
  })
  const nestedEmptySignature = getReviewServingFilterSignature({
    filters: {nested: {promptAnswer: []}, promptAnswer: []},
    listMode: 'llm',
  })
  const omittedSignature = getReviewServingFilterSignature({listMode: 'llm'})

  expect(normalized).toEqual({listMode: 'llm'})
  expect(nestedEmptySignature).toBe(omittedSignature)
})

test('review serving filter signature normalization keeps ordered range values explicit', () => {
  const normalized = getNormalizedReviewServingFilterSignatureInput({
    filters: {createdAt: {from: '2026-01-01', to: '2026-01-31'}, promptAnswer: ['maybe', 'yes', 'maybe']},
  })

  expect(normalized).toEqual({
    filters: {createdAt: {from: '2026-01-01', to: '2026-01-31'}, promptAnswer: ['maybe', 'yes']},
  })
})

test('validateReviewServingCursor rejects config hash mismatch', () => {
  const result = validateReviewServingCursor(payload, {...validationContext, reviewConfigHash: 'review:other'})

  expect(result).toEqual({reason: 'reviewConfigHashMismatch', valid: false})
})

test('validateReviewServingCursor rejects snapshot and contract mismatches', () => {
  const snapshotResult = validateReviewServingCursor(payload, {...validationContext, snapshotId: 'snapshot-2'})
  const contractResult = validateReviewServingCursor(payload, {...validationContext, contractKey: 'review.human.rows'})

  expect(snapshotResult).toEqual({reason: 'snapshotMismatch', valid: false})
  expect(contractResult).toEqual({reason: 'contractMismatch', valid: false})
})

test('validateReviewServingCursor rejects component state mismatches', () => {
  const baseGenerationResult = validateReviewServingCursor(payload, {
    ...validationContext,
    componentStates: {...componentStates, display: {...componentStates.display, baseGeneration: '11'}},
  })
  const patchWatermarkResult = validateReviewServingCursor(payload, {
    ...validationContext,
    componentStates: {...componentStates, display: {...componentStates.display, patchWatermark: '15'}},
  })
  const projectionIdentityResult = validateReviewServingCursor(payload, {
    ...validationContext,
    componentStates: {...componentStates, display: {...componentStates.display, projectionIdentity: 'display:other'}},
  })

  expect(baseGenerationResult).toEqual({reason: 'componentBaseGenerationMismatch', valid: false})
  expect(patchWatermarkResult).toEqual({reason: 'componentPatchWatermarkMismatch', valid: false})
  expect(projectionIdentityResult).toEqual({reason: 'componentProjectionIdentityMismatch', valid: false})
})

test('validateReviewServingCursor rejects filter and sort scope mismatches', () => {
  const filterResult = validateReviewServingCursor(payload, {...validationContext, filterSignature: 'filter:other'})
  const sortResult = validateReviewServingCursor(payload, {...validationContext, sortDirection: 'asc'})
  const sortKeyResult = validateReviewServingCursor(payload, {
    ...validationContext,
    sortKey: getReviewServingCursorSortKey(['article_id']),
  })

  expect(filterResult).toEqual({reason: 'filterSignatureMismatch', valid: false})
  expect(sortResult).toEqual({reason: 'sortDirectionMismatch', valid: false})
  expect(sortKeyResult).toEqual({reason: 'sortKeyMismatch', valid: false})
})

test('decodeReviewServingCursor rejects malformed cursors', () => {
  const decoded = decodeReviewServingCursor('not-json')

  expect(decoded).toEqual({reason: 'malformedCursor', valid: false})
})

test('decodeReviewServingCursor rejects cursor schema mismatches', () => {
  const decoded = decodeReviewServingCursor(
    Buffer.from(JSON.stringify({...payload, sortKey: undefined}), 'utf8').toString('base64url'),
  )

  expect(decoded).toEqual({reason: 'schemaMismatch', valid: false})
})

test('decodeAndValidateReviewServingCursor returns explicit invalid cursor results', () => {
  const malformedResult = decodeAndValidateReviewServingCursor('not-json', validationContext)
  const mismatchResult = decodeAndValidateReviewServingCursor(
    encodeReviewServingCursor({...payload, filterSignature: 'filter:other'}),
    validationContext,
  )

  expect(malformedResult).toEqual({reason: 'malformedCursor', valid: false})
  expect(mismatchResult).toEqual({reason: 'filterSignatureMismatch', valid: false})
})
