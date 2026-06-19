import {createHash} from 'node:crypto'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {getStableReviewServingJson, type ReviewServingIdentityValue} from './reviewProjectionIdentity.ts'
import type {ReviewServingProjectionComponent, ReviewServingReadContractKey} from './reviewServingContracts.ts'
import {getReviewServingFilterSignature, type ReviewServingFilterSignatureValue} from './reviewServingCursor.ts'
import {
  getActiveReviewServingSnapshotManifest,
  getReviewServingSnapshotManifest,
  type ReviewServingManifestRepositoryDatabase,
  type ReviewServingSnapshotManifest,
} from './reviewServingManifestRepository.ts'
import {readReviewServingRows, type ReviewServingReaderDatabase} from './reviewServingReader.ts'
import {
  acquireReviewServingSnapshotPin,
  type ReviewServingSnapshotPinRepositoryDatabase,
} from './reviewServingSnapshotPinRepository.ts'

export type ReviewBulkOperationJobKind =
  | 'review.bulk.selection'
  | 'review.bulk.substringSelection'
  | 'review.export.selection'
  | 'review.pdf.selection'

export type ReviewBulkOperationSearchMode = 'none' | 'substring' | 'tokenPrefix'

export type ReviewBulkOperationSnapshotSemantics =
  | {expiresAt?: Date | string; snapshotId: string; type: 'pinned'}
  | {type: 'latest'}

export type ReviewBulkOperationCriteria = {
  articleIds?: readonly string[]
  concurrency?: number
  exportContract?: ReviewServingIdentityValue
  filters?: Partial<Record<string, ReviewServingFilterSignatureValue>>
  forceRefetch?: boolean
  from?: string
  hasDuplicateStudyRecords?: boolean
  hasStudyDecisionConflict?: boolean
  listType?: string
  llmStatus?: string
  operation: 'addToProject' | 'export' | 'pdfFetch' | 'selectAll'
  prompts?: Record<string, readonly string[]>
  reviewConfig?: ReviewServingIdentityValue
  requestId?: string
  search?: string
  selectionScope?: 'project'
  sourceProjectId?: string
  sourceProjectIds?: readonly string[]
  sourceProjectReviewConfigHashes?: Record<string, string | null>
  targetProjectId?: string
  to?: string
}

export type ReviewBulkOperationServiceRequest = {
  batchSize?: number
  criteria: ReviewBulkOperationCriteria
  filters?: Partial<Record<string, ReviewServingFilterSignatureValue>>
  jobKind: ReviewBulkOperationJobKind
  projectId: string
  reviewConfigHash?: string | null
  searchMode?: ReviewBulkOperationSearchMode
  searchText?: string | null
  snapshot: ReviewBulkOperationSnapshotSemantics
}

export type ReviewBulkOperationJobResult = {
  filterSignature: string
  jobId: string
  jobKind: ReviewBulkOperationJobKind
  latestSnapshotSemantics: boolean
  projectId: string
  snapshotId: string | null
  snapshotPinId: string | null
  status: 'pending'
}

export type ReviewBulkOperationServiceDatabase = ReviewServingReaderDatabase
  & ReviewServingSnapshotPinRepositoryDatabase & {run: (statement: string) => Promise<void>}

type ReviewBulkOperationServiceDependencies = {
  database?: ReviewBulkOperationServiceDatabase
  manifestDatabase?: ReviewServingManifestRepositoryDatabase
}

const defaultBatchSize = 500
export const reviewBulkOperationArticleIdCap = 5_000
export const reviewBulkOperationPayloadByteCap = 1_000_000

const getDatabase = () => {
  return getAppDatabaseService() as ReviewBulkOperationServiceDatabase
}

const hasText = (value: string | null | undefined) => {
  return typeof value === 'string' && value.trim().length > 0
}

const getComponentIdentity = (manifest: ReviewServingSnapshotManifest, component: ReviewServingProjectionComponent) => {
  const states = [...manifest.componentState.required, ...manifest.componentState.optional]
  const state = states.find((componentState) => {
    return componentState.component === component
  })

  return state?.projectionIdentity ?? null
}

const getBulkOperationFilterSignature = (request: ReviewBulkOperationServiceRequest) => {
  return getReviewServingFilterSignature({filters: request.filters ?? {}, searchText: request.searchText ?? undefined})
}

const getBulkOperationJobId = (input: {
  criteria: ReviewBulkOperationCriteria
  filterSignature: string
  jobKind: ReviewBulkOperationJobKind
  projectId: string
  reviewConfigHash: string | null
  searchMode: ReviewBulkOperationSearchMode
  searchText: string | null
  snapshotId: string | null
  snapshotSemantics: 'latest' | 'pinned'
}) => {
  const hash = createHash('sha256')
    .update(getStableReviewServingJson(input as ReviewServingIdentityValue))
    .digest('hex')
    .slice(0, 24)

  return `review-bulk-${hash}`
}

const getCriteriaJson = (request: ReviewBulkOperationServiceRequest) => {
  return {...request.criteria, searchMode: request.searchMode ?? 'none', searchText: request.searchText ?? null}
}

const getJsonSql = (value: unknown) => {
  return `${getSqlLiteral(getStableReviewServingJson(value as ReviewServingIdentityValue))}::JSON`
}

const getTotalEstimateSql = (request: ReviewBulkOperationServiceRequest) => {
  return Array.isArray(request.criteria.articleIds) ? getSqlLiteral(request.criteria.articleIds.length) : 'NULL'
}

const getManifest = async (
  request: ReviewBulkOperationServiceRequest,
  manifestDatabase: ReviewServingManifestRepositoryDatabase,
) => {
  return request.snapshot.type === 'latest'
    ? null
    : getReviewServingSnapshotManifest(
        {projectId: request.projectId, snapshotId: request.snapshot.snapshotId},
        manifestDatabase,
      )
}

const getLatestRequiredManifest = async (
  request: ReviewBulkOperationServiceRequest,
  manifestDatabase: ReviewServingManifestRepositoryDatabase,
  reviewConfigHash: string | null,
) => {
  return request.snapshot.type === 'latest' && !Array.isArray(request.criteria.articleIds)
    ? getActiveReviewServingSnapshotManifest({projectId: request.projectId, reviewConfigHash}, manifestDatabase)
    : null
}

const getPinnedSnapshotState = async (input: {
  database: ReviewBulkOperationServiceDatabase
  jobId: string
  manifest: ReviewServingSnapshotManifest
  request: ReviewBulkOperationServiceRequest
}) => {
  const expiresAt =
    input.request.snapshot.type === 'pinned' && input.request.snapshot.expiresAt
      ? input.request.snapshot.expiresAt
      : new Date(Date.now() + 24 * 60 * 60 * 1000)
  const pin = await acquireReviewServingSnapshotPin(
    {
      composedIdentity: input.manifest.composedIdentity,
      expiresAt,
      ownerId: input.jobId,
      ownerKind: 'reviewBulkOperationJob',
      projectId: input.request.projectId,
      snapshotId: input.manifest.snapshotId,
    },
    input.database,
  )

  return {
    composedIdentity: input.manifest.composedIdentity,
    snapshotId: input.manifest.snapshotId,
    snapshotPinId: pin?.pinId ?? null,
  }
}

const getLatestSnapshotState = () => {
  return {composedIdentity: {snapshotSemantics: 'latest'}, snapshotId: null, snapshotPinId: null}
}

const getRequestReviewConfigHash = async (
  request: ReviewBulkOperationServiceRequest,
  manifest: ReviewServingSnapshotManifest | null,
) => {
  return request.reviewConfigHash ?? manifest?.reviewConfigHash ?? null
}

const insertBulkOperationJob = async (input: {
  composedIdentity: ReviewServingIdentityValue
  database: ReviewBulkOperationServiceDatabase
  filterSignature: string
  jobId: string
  request: ReviewBulkOperationServiceRequest
  snapshotId: string | null
  snapshotPinId: string | null
}) => {
  const latestSnapshotSemantics = input.request.snapshot.type === 'latest'
  const batchSize = input.request.batchSize ?? defaultBatchSize
  const totalEstimateSql = getTotalEstimateSql(input.request)

  await input.database.run(`
    INSERT INTO app.review_bulk_operation_job (
      job_id,
      job_kind,
      project_id,
      snapshot_id,
      snapshot_pin_id,
      latest_snapshot_semantics,
      review_config_hash,
      composed_identity_json,
      filter_signature,
      criteria_json,
      cursor_json,
      batch_size,
      status,
      result_manifest_json,
      processed_count,
      total_estimate,
      cancel_requested,
      retry_count,
      last_error
    ) VALUES (
      ${getSqlLiteral(input.jobId)},
      ${getSqlLiteral(input.request.jobKind)},
      ${getSqlLiteral(input.request.projectId)},
      ${getSqlLiteral(input.snapshotId)},
      ${getSqlLiteral(input.snapshotPinId)},
      ${latestSnapshotSemantics ? 'TRUE' : 'FALSE'},
      ${getSqlLiteral(input.request.reviewConfigHash ?? null)},
      ${getJsonSql(input.composedIdentity)},
      ${getSqlLiteral(input.filterSignature)},
      ${getJsonSql(getCriteriaJson(input.request))},
      ${getJsonSql({cursor: null, jobId: input.jobId, limit: batchSize})},
      ${batchSize},
      'pending',
      ${getJsonSql({articleIdOnly: Array.isArray(input.request.criteria.articleIds), operation: input.request.criteria.operation})},
      0,
      ${totalEstimateSql},
      FALSE,
      0,
      NULL
    ) ON CONFLICT (job_id) DO UPDATE SET
      updated_at = current_timestamp,
      cursor_json = EXCLUDED.cursor_json,
      status = 'pending',
      result_manifest_json = EXCLUDED.result_manifest_json,
      processed_count = 0,
      total_estimate = ${totalEstimateSql},
      completed_at = NULL,
      cancel_requested = FALSE,
      retry_count = 0,
      last_error = NULL
  `)
}

const verifyPersistedJobWithContract = async (input: {
  database: ReviewBulkOperationServiceDatabase
  filterSignature: string
  manifestDatabase: ReviewServingManifestRepositoryDatabase
  manifest: ReviewServingSnapshotManifest
  request: ReviewBulkOperationServiceRequest
  searchIdentity: string | null
}) => {
  const result = await readReviewServingRows<{job_id: string}>(
    {
      contractKey: input.request.jobKind as ReviewServingReadContractKey,
      jobFilterSignature: input.filterSignature,
      jobState: {
        jobId: '',
        processedCount: 0,
        snapshotId: input.manifest.snapshotId,
        status: 'pending',
        totalEstimate: null,
      },
      limit: 1,
      projectId: input.request.projectId,
      reviewConfigHash: input.request.reviewConfigHash ?? input.manifest.reviewConfigHash,
      searchIdentity: input.searchIdentity,
      searchMode: input.request.searchMode === 'substring' ? 'substringAsync' : input.request.searchMode,
      searchState:
        input.request.searchMode === 'substring'
          ? {availability: 'async', jobId: '', reason: 'bulk substring selection runs async'}
          : input.request.searchMode === 'tokenPrefix'
            ? {availability: 'ready', snapshotId: input.manifest.snapshotId}
            : undefined,
      searchText: input.request.searchText ?? undefined,
      searchTokenPrefix: input.request.searchText?.trim().toLowerCase(),
      snapshotId: input.manifest.snapshotId,
    },
    {database: input.database, diagnosticsDatabase: input.manifestDatabase, manifestDatabase: input.manifestDatabase},
  )

  if (result.status === 'rejected') {
    throw new Error(`Review bulk operation contract verification rejected: ${result.reason}`)
  }
}

export const assertArticleIdOnlyBulkOperationCaps = (articleIds: readonly string[]) => {
  if (articleIds.length > reviewBulkOperationArticleIdCap) {
    throw new Error(`Bulk article ID operation exceeds cap of ${reviewBulkOperationArticleIdCap}`)
  }

  if (
    Buffer.byteLength(getStableReviewServingJson(articleIds as ReviewServingIdentityValue), 'utf8')
    > reviewBulkOperationPayloadByteCap
  ) {
    throw new Error(`Bulk article ID operation payload exceeds cap of ${reviewBulkOperationPayloadByteCap} bytes`)
  }
}

export const createReviewBulkOperationJob = async (
  request: ReviewBulkOperationServiceRequest,
  dependencies?: ReviewBulkOperationServiceDependencies,
): Promise<ReviewBulkOperationJobResult> => {
  const database = dependencies?.database ?? getDatabase()
  const manifestDatabase = dependencies?.manifestDatabase ?? (database as ReviewServingManifestRepositoryDatabase)
  const searchMode = request.searchMode ?? 'none'
  const searchText = request.searchText ?? null
  const filterSignature = getBulkOperationFilterSignature(request)
  const requestedSnapshotId = request.snapshot.type === 'pinned' ? request.snapshot.snapshotId : null

  if (!hasText(request.projectId)) {
    throw new Error('Review bulk operation projectId is required')
  }

  if (Array.isArray(request.criteria.articleIds)) {
    assertArticleIdOnlyBulkOperationCaps(request.criteria.articleIds)
  }

  const manifest = await getManifest(request, manifestDatabase)
  const pinnedReviewConfigHash = await getRequestReviewConfigHash(request, manifest)
  const latestRequiredManifest = await getLatestRequiredManifest(request, manifestDatabase, pinnedReviewConfigHash)
  const verificationManifest = manifest ?? latestRequiredManifest
  const reviewConfigHash = await getRequestReviewConfigHash(request, verificationManifest)
  const jobRequest = {...request, reviewConfigHash}
  const jobId = getBulkOperationJobId({
    criteria: request.criteria,
    filterSignature,
    jobKind: request.jobKind,
    projectId: request.projectId,
    reviewConfigHash,
    searchMode,
    searchText,
    snapshotId: requestedSnapshotId,
    snapshotSemantics: request.snapshot.type,
  })

  if (request.snapshot.type === 'pinned' && (!manifest || manifest.status !== 'active')) {
    throw new Error('Review bulk operation snapshot is not ready')
  }

  if (request.snapshot.type === 'latest' && !Array.isArray(request.criteria.articleIds) && !latestRequiredManifest) {
    throw new Error('Review bulk operation latest snapshot is not ready')
  }

  const searchIdentity = verificationManifest ? getComponentIdentity(verificationManifest, 'search') : null

  if (verificationManifest) {
    await verifyPersistedJobWithContract({
      database,
      filterSignature,
      manifest: verificationManifest,
      manifestDatabase,
      request: jobRequest,
      searchIdentity,
    })
  }

  const snapshotState = manifest
    ? await getPinnedSnapshotState({database, jobId, manifest, request: jobRequest})
    : getLatestSnapshotState()

  await insertBulkOperationJob({...snapshotState, database, filterSignature, jobId, request: jobRequest})

  return {
    filterSignature,
    jobId,
    jobKind: request.jobKind,
    latestSnapshotSemantics: request.snapshot.type === 'latest',
    projectId: request.projectId,
    snapshotId: snapshotState.snapshotId,
    snapshotPinId: snapshotState.snapshotPinId,
    status: 'pending',
  }
}
