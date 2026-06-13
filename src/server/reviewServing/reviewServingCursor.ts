import {getStableReviewServingJson, type ReviewServingIdentityValue} from './reviewProjectionIdentity.ts'
import {
  isReviewServingProjectionComponent,
  isReviewServingReadContractKey,
  type ReviewServingProjectionComponent,
  type ReviewServingReadContractKey,
  type ReviewServingSortDirection,
} from './reviewServingContracts.ts'

export type ReviewServingCursorComponentState = {
  baseGeneration: string
  patchWatermark: string
  projectionIdentity: string
}

export type ReviewServingCursorPayload = {
  articleId: string
  componentStates: Partial<Record<ReviewServingProjectionComponent, ReviewServingCursorComponentState>>
  contractKey: ReviewServingReadContractKey
  filterSignature: string
  reviewConfigHash: string | null
  snapshotId: string
  sortDirection: ReviewServingSortDirection
  sortKey: string
  sortValues: readonly (null | number | string)[]
  version: 1
}

export type ReviewServingCursorValidationContext = {
  componentStates: Partial<Record<ReviewServingProjectionComponent, ReviewServingCursorComponentState>>
  contractKey: ReviewServingReadContractKey
  filterSignature: string
  reviewConfigHash?: string | null
  snapshotId: string
  sortDirection: ReviewServingSortDirection
  sortKey: string
}

export type ReviewServingCursorDecodeFailureReason = 'malformedCursor' | 'schemaMismatch'

export type ReviewServingCursorValidationFailureReason =
  | 'componentBaseGenerationMismatch'
  | 'componentPatchWatermarkMismatch'
  | 'componentProjectionIdentityMismatch'
  | 'contractMismatch'
  | 'filterSignatureMismatch'
  | 'reviewConfigHashMismatch'
  | 'snapshotMismatch'
  | 'sortDirectionMismatch'
  | 'sortKeyMismatch'

export type ReviewServingCursorFailureReason =
  | ReviewServingCursorDecodeFailureReason
  | ReviewServingCursorValidationFailureReason

export type ReviewServingCursorDecodeResult =
  | {payload: ReviewServingCursorPayload; valid: true}
  | {reason: ReviewServingCursorDecodeFailureReason; valid: false}

export type ReviewServingCursorValidationResult =
  | {payload: ReviewServingCursorPayload; valid: true}
  | {reason: ReviewServingCursorValidationFailureReason; valid: false}

export type ReviewServingCursorParseResult =
  | {payload: ReviewServingCursorPayload; valid: true}
  | {reason: ReviewServingCursorFailureReason; valid: false}

export type ReviewServingFilterSignaturePrimitive = boolean | null | number | string

export type ReviewServingFilterSignatureValue =
  | ReviewServingFilterSignaturePrimitive
  | readonly ReviewServingFilterSignatureValue[]
  | {[key: string]: ReviewServingFilterSignatureValue | undefined}
  | undefined

const isFilterSignatureRecord = (
  value: ReviewServingFilterSignatureValue,
): value is {[key: string]: ReviewServingFilterSignatureValue | undefined} => {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const compareStableReviewServingValues = (left: ReviewServingIdentityValue, right: ReviewServingIdentityValue) => {
  return getStableReviewServingJson(left).localeCompare(getStableReviewServingJson(right))
}

const getUniqueReviewServingValues = (values: readonly ReviewServingIdentityValue[]) => {
  const valuesByJson = values.reduce<Record<string, ReviewServingIdentityValue>>((entries, value) => {
    return {...entries, [getStableReviewServingJson(value)]: value}
  }, {})

  return Object.values(valuesByJson).sort(compareStableReviewServingValues)
}

const getNormalizedReviewServingFilterArray = (
  values: readonly ReviewServingFilterSignatureValue[],
): readonly ReviewServingIdentityValue[] => {
  const normalizedValues = values
    .map(getNormalizedReviewServingFilterValue)
    .filter((value): value is Exclude<ReviewServingIdentityValue, undefined> => {
      return value !== undefined
    })

  return getUniqueReviewServingValues(normalizedValues)
}

const getNormalizedReviewServingFilterRecord = (value: {
  [key: string]: ReviewServingFilterSignatureValue | undefined
}) => {
  return Object.keys(value)
    .sort()
    .reduce<{[key: string]: ReviewServingIdentityValue}>((record, key) => {
      const normalizedValue = getNormalizedReviewServingFilterValue(value[key])
      const shouldSkip =
        normalizedValue === undefined || (Array.isArray(normalizedValue) && normalizedValue.length === 0)

      return shouldSkip ? record : {...record, [key]: normalizedValue}
    }, {})
}

const getNormalizedReviewServingFilterValue = (
  value: ReviewServingFilterSignatureValue,
): ReviewServingIdentityValue => {
  if (Array.isArray(value)) {
    return getNormalizedReviewServingFilterArray(value)
  }

  return isFilterSignatureRecord(value) ? getNormalizedReviewServingFilterRecord(value) : value
}

export const getNormalizedReviewServingFilterSignatureInput = (
  input: ReviewServingFilterSignatureValue,
): ReviewServingIdentityValue => {
  const normalizedInput = getNormalizedReviewServingFilterValue(input)

  return normalizedInput === undefined ? null : normalizedInput
}

export const getReviewServingFilterSignature = (input: ReviewServingFilterSignatureValue) => {
  return Buffer.from(
    getStableReviewServingJson(getNormalizedReviewServingFilterSignatureInput(input)),
    'utf8',
  ).toString('base64url')
}

export const getReviewServingCursorSortKey = (fields: readonly string[]) => {
  return Buffer.from(getStableReviewServingJson(fields), 'utf8').toString('base64url')
}

const isSortValue = (value: unknown): value is null | number | string => {
  return value === null || typeof value === 'number' || typeof value === 'string'
}

const isCursorComponentState = (value: unknown): value is ReviewServingCursorComponentState => {
  const state = value as Partial<ReviewServingCursorComponentState>
  return (
    value !== null
    && typeof value === 'object'
    && typeof state.baseGeneration === 'string'
    && typeof state.patchWatermark === 'string'
    && typeof state.projectionIdentity === 'string'
  )
}

const getCursorComponentStates = (
  value: unknown,
): Partial<Record<ReviewServingProjectionComponent, ReviewServingCursorComponentState>> | null => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const record = value as Record<string, unknown>
  const entries = Object.entries(record).filter(
    (entry): entry is [ReviewServingProjectionComponent, ReviewServingCursorComponentState] => {
      const [component, state] = entry

      return isReviewServingProjectionComponent(component) && isCursorComponentState(state)
    },
  )

  return entries.length === Object.keys(record).length
    ? entries.reduce<Partial<Record<ReviewServingProjectionComponent, ReviewServingCursorComponentState>>>(
        (states, [component, state]) => {
          return {...states, [component]: state}
        },
        {},
      )
    : null
}

const isReviewServingCursorPayload = (value: unknown): value is ReviewServingCursorPayload => {
  const payload = value as Partial<ReviewServingCursorPayload>
  const componentStates = getCursorComponentStates(payload.componentStates)

  return (
    value !== null
    && typeof value === 'object'
    && payload.version === 1
    && typeof payload.contractKey === 'string'
    && isReviewServingReadContractKey(payload.contractKey)
    && typeof payload.snapshotId === 'string'
    && typeof payload.filterSignature === 'string'
    && (payload.sortDirection === 'asc' || payload.sortDirection === 'desc')
    && typeof payload.sortKey === 'string'
    && Array.isArray(payload.sortValues)
    && payload.sortValues.every(isSortValue)
    && typeof payload.articleId === 'string'
    && (typeof payload.reviewConfigHash === 'string' || payload.reviewConfigHash === null)
    && componentStates !== null
  )
}

const getComponentMismatch = (
  payload: ReviewServingCursorPayload,
  expected: ReviewServingCursorValidationContext,
): ReviewServingCursorValidationResult | null => {
  const mismatchedEntry = Object.entries(expected.componentStates).find(([component, expectedState]) => {
    const payloadState = isReviewServingProjectionComponent(component) ? payload.componentStates[component] : null
    return (
      payloadState?.projectionIdentity !== expectedState?.projectionIdentity
      || payloadState?.baseGeneration !== expectedState?.baseGeneration
      || payloadState?.patchWatermark !== expectedState?.patchWatermark
    )
  })

  const component = mismatchedEntry?.[0]
  const expectedState = mismatchedEntry?.[1]
  const payloadState =
    component && isReviewServingProjectionComponent(component) ? payload.componentStates[component] : null

  if (!expectedState || !payloadState) {
    return mismatchedEntry ? {reason: 'componentProjectionIdentityMismatch', valid: false} : null
  }

  if (payloadState.projectionIdentity !== expectedState.projectionIdentity) {
    return {reason: 'componentProjectionIdentityMismatch', valid: false}
  }

  if (payloadState.baseGeneration !== expectedState.baseGeneration) {
    return {reason: 'componentBaseGenerationMismatch', valid: false}
  }

  return payloadState.patchWatermark !== expectedState.patchWatermark
    ? {reason: 'componentPatchWatermarkMismatch', valid: false}
    : null
}

export const encodeReviewServingCursor = (payload: ReviewServingCursorPayload) => {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

export const decodeReviewServingCursor = (cursor: string | null | undefined): ReviewServingCursorDecodeResult => {
  if (!cursor) {
    return {reason: 'malformedCursor', valid: false}
  }

  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown
    return isReviewServingCursorPayload(parsed)
      ? {payload: parsed, valid: true}
      : {reason: 'schemaMismatch', valid: false}
  } catch (_error) {
    return {reason: 'malformedCursor', valid: false}
  }
}

export const validateReviewServingCursor = (
  payload: ReviewServingCursorPayload,
  expected: ReviewServingCursorValidationContext,
): ReviewServingCursorValidationResult => {
  const componentMismatch = getComponentMismatch(payload, expected)

  if (payload.contractKey !== expected.contractKey) {
    return {reason: 'contractMismatch', valid: false}
  }

  if (payload.snapshotId !== expected.snapshotId) {
    return {reason: 'snapshotMismatch', valid: false}
  }

  if (payload.filterSignature !== expected.filterSignature) {
    return {reason: 'filterSignatureMismatch', valid: false}
  }

  if (payload.sortDirection !== expected.sortDirection) {
    return {reason: 'sortDirectionMismatch', valid: false}
  }

  if (payload.sortKey !== expected.sortKey) {
    return {reason: 'sortKeyMismatch', valid: false}
  }

  if ((expected.reviewConfigHash ?? null) !== payload.reviewConfigHash) {
    return {reason: 'reviewConfigHashMismatch', valid: false}
  }

  return componentMismatch ?? {payload, valid: true}
}

export const decodeAndValidateReviewServingCursor = (
  cursor: string | null | undefined,
  expected: ReviewServingCursorValidationContext,
): ReviewServingCursorParseResult => {
  const decoded = decodeReviewServingCursor(cursor)

  return decoded.valid ? validateReviewServingCursor(decoded.payload, expected) : decoded
}
