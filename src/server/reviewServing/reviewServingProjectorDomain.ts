import {createHash} from 'node:crypto'

import {getStableReviewServingJson, type ReviewServingIdentityValue} from './reviewProjectionIdentity.ts'
import {
  type ReviewServingChangeKind,
  type ReviewServingProjectionComponent,
  type ReviewServingSnapshotStatus,
} from './reviewServingContracts.ts'
import {getReviewServingInvalidationRuleOrNull} from './reviewServingInvalidationRegistry.ts'

export type ReviewServingBaseGeneration = number

export type ReviewServingPatchWatermark = number

export type ReviewServingLeaseOwner = string

export type ReviewServingSnapshotLifecycleStatus = ReviewServingSnapshotStatus

export type ReviewServingSourcePartitionHighWaterState = {sourceHighWaterMark: number; sourcePartition: string}

export type ReviewServingProjectionComponentIdentity = {
  projectId: string | null
  projectionComponent: ReviewServingProjectionComponent
  projectionIdentity: string
}

export type ReviewServingProjectorWatermarkIdentity = ReviewServingSourcePartitionHighWaterState & {
  importRouteId: string | null
  projectId: string | null
  projectionComponent: ReviewServingProjectionComponent
  projectorName: string
}

export type ReviewServingProjectionManifestState = ReviewServingProjectionComponentIdentity & {
  baseGeneration: ReviewServingBaseGeneration
  definitionVersion: string
  inputWatermark: number
  patchRangeEnd: number | null
  patchRangeStart: number | null
  patchWatermark: ReviewServingPatchWatermark
  status: ReviewServingSnapshotLifecycleStatus
}

export type ReviewServingDirtyWorkScopeKind = 'article' | 'global' | 'importRoute' | 'project' | 'prompt'

export type ReviewServingDirtyWorkScope = ReviewServingSourcePartitionHighWaterState & {
  affectedComponents: readonly ReviewServingProjectionComponent[]
  dirtyKind: ReviewServingChangeKind
  dirtyRangeEnd: string | null
  dirtyRangeStart: string | null
  firstAffectedComponent: ReviewServingProjectionComponent
  projectId: string | null
  projectionKey: string | null
  scopeId: string
  scopeKind: ReviewServingDirtyWorkScopeKind
}

export type ReviewServingDirtyWorkScopeInput = ReviewServingSourcePartitionHighWaterState & {
  changeKind: string
  dirtyRangeEnd?: string | null
  dirtyRangeStart?: string | null
  projectionKey?: string | null
  values: Record<string, ReviewServingIdentityValue>
}

const getReviewServingDomainHash = (label: string, value: ReviewServingIdentityValue) => {
  return createHash('sha256')
    .update(`${label}:${getStableReviewServingJson(value)}`)
    .digest('hex')
}

const getRequiredKeyValues = (requiredKeys: readonly string[], values: Record<string, ReviewServingIdentityValue>) => {
  const missingKeys = requiredKeys.filter((key) => {
    return values[key] === undefined || values[key] === null || values[key] === ''
  })

  return missingKeys.length > 0 ? null : values
}

const getStringValue = (values: Record<string, ReviewServingIdentityValue>, key: string) => {
  const value = values[key]

  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

const getScopeFromValues = (values: Record<string, ReviewServingIdentityValue>) => {
  const projectId = getStringValue(values, 'projectId')
  const articleId = getStringValue(values, 'articleId')
  const promptId = getStringValue(values, 'promptId')
  const importRouteId = getStringValue(values, 'importRouteId')

  if (projectId !== null && articleId !== null) {
    return {projectId, scopeId: `${projectId}:${articleId}`, scopeKind: 'article' as const}
  }

  if (projectId !== null && promptId !== null) {
    return {projectId, scopeId: `${projectId}:${promptId}`, scopeKind: 'prompt' as const}
  }

  if (importRouteId !== null) {
    return {projectId, scopeId: importRouteId, scopeKind: 'importRoute' as const}
  }

  if (projectId !== null) {
    return {projectId, scopeId: projectId, scopeKind: 'project' as const}
  }

  return {projectId: null, scopeId: 'global', scopeKind: 'global' as const}
}

export const getReviewServingProjectionComponentIdentityKey = (input: ReviewServingProjectionComponentIdentity) => {
  return `projection:${getReviewServingDomainHash('review-projection-component-identity', {
    projectId: input.projectId,
    projectionComponent: input.projectionComponent,
    projectionIdentity: input.projectionIdentity,
  }).slice(0, 32)}`
}

export const getReviewServingProjectorWatermarkId = (
  input: Omit<ReviewServingProjectorWatermarkIdentity, 'sourceHighWaterMark'>,
) => {
  return `watermark:${getReviewServingDomainHash('review-projector-watermark', {
    importRouteId: input.importRouteId,
    projectId: input.projectId,
    projectionComponent: input.projectionComponent,
    projectorName: input.projectorName,
    sourcePartition: input.sourcePartition,
  }).slice(0, 32)}`
}

export const getReviewServingDirtyWorkScopeKey = (scope: ReviewServingDirtyWorkScope) => {
  return `dirty:${getReviewServingDomainHash('review-dirty-work-scope', {
    dirtyKind: scope.dirtyKind,
    projectId: scope.projectId,
    projectionKey: scope.projectionKey,
    scopeId: scope.scopeId,
    scopeKind: scope.scopeKind,
    sourcePartition: scope.sourcePartition,
  }).slice(0, 32)}`
}

export const getReviewServingLeaseOwner = (value: string): ReviewServingLeaseOwner | null => {
  const owner = value.trim()

  return owner.length > 0 ? owner : null
}

export const getReviewServingDirtyWorkScopeForChange = (input: ReviewServingDirtyWorkScopeInput) => {
  const rule = getReviewServingInvalidationRuleOrNull(input.changeKind)

  if (rule === null || input.sourceHighWaterMark < 0 || input.sourcePartition.trim().length === 0) {
    return null
  }

  const values = getRequiredKeyValues(rule.requiredKeys, input.values)

  if (values === null) {
    return null
  }

  const scope = getScopeFromValues(values)

  return {
    affectedComponents: rule.affectedComponents,
    dirtyKind: rule.changeKind,
    dirtyRangeEnd: input.dirtyRangeEnd ?? null,
    dirtyRangeStart: input.dirtyRangeStart ?? null,
    firstAffectedComponent: rule.firstAffectedComponent,
    projectId: scope.projectId,
    projectionKey: input.projectionKey ?? null,
    scopeId: scope.scopeId,
    scopeKind: scope.scopeKind,
    sourceHighWaterMark: input.sourceHighWaterMark,
    sourcePartition: input.sourcePartition,
  }
}
