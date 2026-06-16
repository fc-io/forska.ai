import {expect, test} from 'bun:test'

import {getReviewServingProjectionComponentIdentityKey} from './reviewServingProjectorDomain.ts'
import {
  composeReviewServingCandidateSnapshotManifest,
  getReviewServingOptionalComponentAvailability,
  type ReviewServingSnapshotPromotionDatabase,
  validateReviewServingCandidateSnapshotManifest,
} from './reviewServingSnapshotPromotionService.ts'

const displayManifest = {
  baseGeneration: 1,
  definitionVersion: 'display-v1',
  inputDigest: null,
  inputWatermark: 10,
  invalidationReason: null,
  manifestId: 'display-manifest',
  patchRangeEnd: null,
  patchRangeStart: null,
  patchWatermark: 4,
  projectId: 'project-1',
  projectionComponent: 'display',
  projectionIdentity: 'display:identity-1',
  promptConfigHash: null,
  reviewConfigHash: 'review-config-1',
  status: 'candidate',
} as const

const searchManifest = {
  ...displayManifest,
  definitionVersion: 'search-v1',
  manifestId: 'search-manifest',
  projectionComponent: 'search',
  projectionIdentity: 'search:identity-1',
} as const

const getManifestKey = (manifest: {
  projectId: string
  projectionComponent: 'display' | 'search'
  projectionIdentity: string
}) => {
  return getReviewServingProjectionComponentIdentityKey(manifest)
}

const createPromotionDatabase = (input?: {selectedImportStatus?: string}) => {
  const manifests = new Map([
    [getManifestKey(displayManifest), displayManifest],
    [getManifestKey(searchManifest), searchManifest],
  ])
  const database: ReviewServingSnapshotPromotionDatabase = {
    queryJson: async <T>(statement: string) => {
      if (statement.includes('FROM app.review_selected_import_snapshot')) {
        return [{status: input?.selectedImportStatus ?? 'completed'}] as T[]
      }

      if (statement.includes('FROM app.review_projection_identity_manifest')) {
        const manifestId = statement.match(/manifest_id = '((?:''|[^'])*)'/u)?.[1]?.replaceAll("''", "'") ?? ''
        const manifest = manifests.get(manifestId)

        return (manifest === undefined ? [] : [manifest]) as T[]
      }

      return [] as T[]
    },
    run: async () => {},
  }

  return {database, manifests}
}

test('snapshot promotion composes required and optional manifests into candidate state', async () => {
  const {database} = createPromotionDatabase()
  const candidate = await composeReviewServingCandidateSnapshotManifest(
    {
      componentIdentities: {display: displayManifest, search: searchManifest},
      componentRequirements: {optionalComponents: ['search'], requiredComponents: ['display']},
      composedIdentity: {route: 'review.filters.facets', version: 1},
      projectId: 'project-1',
      reviewConfigHash: 'review-config-1',
      selectedImportSnapshotId: 'selected-import-1',
      snapshotId: 'snapshot-1',
      sourceWatermarks: {reviewChange: 10},
    },
    database,
  )

  expect(candidate.componentState.required).toEqual([
    {
      baseGeneration: '1',
      component: 'display',
      patchWatermark: '4',
      projectionIdentity: 'display:identity-1',
      requirement: 'required',
    },
  ])
  expect(candidate.componentState.optional).toEqual([
    {
      baseGeneration: '1',
      component: 'search',
      patchWatermark: '4',
      projectionIdentity: 'search:identity-1',
      requirement: 'optional',
    },
  ])
})

test('snapshot validation fails required gaps but allows missing optional component state', async () => {
  const {database} = createPromotionDatabase()
  const candidate = await composeReviewServingCandidateSnapshotManifest(
    {
      componentIdentities: {search: searchManifest},
      componentRequirements: {optionalComponents: ['search'], requiredComponents: ['display']},
      composedIdentity: {route: 'review.filters.facets', version: 1},
      projectId: 'project-1',
      reviewConfigHash: 'review-config-1',
      selectedImportSnapshotId: 'selected-import-1',
      snapshotId: 'snapshot-1',
      sourceWatermarks: {reviewChange: 10},
    },
    database,
  )
  const result = await validateReviewServingCandidateSnapshotManifest(
    {
      ...candidate,
      componentState: {...candidate.componentState, optional: []},
      lastError: null,
      lastKnownGoodSnapshotId: null,
      optionalComponents: candidate.componentRequirements.optionalComponents,
      requiredComponents: candidate.componentRequirements.requiredComponents,
      status: 'candidate',
      validationResult: null,
    },
    database,
  )

  expect(result.ok).toBe(false)
  expect(result.ok ? null : result.error).toBe('required component display is missing from snapshot state')
})

test('snapshot validation catches selected import and component-state pin mismatches', async () => {
  const {database} = createPromotionDatabase({selectedImportStatus: 'candidate'})
  const result = await validateReviewServingCandidateSnapshotManifest(
    {
      componentState: {
        optional: [],
        required: [
          {
            baseGeneration: '2',
            component: 'display',
            patchWatermark: '4',
            projectionIdentity: 'display:identity-1',
            requirement: 'required',
          },
        ],
      },
      composedIdentity: {route: 'review.llm.rows', version: 1},
      lastError: null,
      lastKnownGoodSnapshotId: null,
      optionalComponents: [],
      projectId: 'project-1',
      requiredComponents: ['display'],
      reviewConfigHash: 'review-config-1',
      selectedImportSnapshotId: 'selected-import-1',
      snapshotId: 'snapshot-1',
      sourceWatermarks: {reviewChange: 10},
      status: 'candidate',
      validationResult: null,
    },
    database,
  )

  expect(result.ok).toBe(false)
  expect(result.ok ? null : result.error).toBe('selected import snapshot is not completed')
})

test('optional component availability distinguishes route states', () => {
  expect(
    getReviewServingOptionalComponentAvailability({
      component: 'search',
      hasActiveSnapshot: false,
      optionalComponents: [],
      optionalStatePresent: false,
    }),
  ).toBe('unavailable')
  expect(
    getReviewServingOptionalComponentAvailability({
      component: 'search',
      hasActiveSnapshot: true,
      optionalComponents: ['search'],
      optionalStatePresent: false,
    }),
  ).toBe('indexing')
  expect(
    getReviewServingOptionalComponentAvailability({
      component: 'search',
      hasActiveSnapshot: true,
      optionalComponents: ['search'],
      optionalStatePresent: true,
    }),
  ).toBe('ready')
  expect(
    getReviewServingOptionalComponentAvailability({
      component: 'summary',
      hasActiveSnapshot: true,
      optionalComponents: [],
      optionalStatePresent: false,
    }),
  ).toBe('async')
})
