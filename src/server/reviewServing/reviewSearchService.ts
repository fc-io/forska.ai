import {createHash} from 'node:crypto'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import type {ReviewServingFreshnessState, ReviewServingProjectionComponent} from './reviewServingContracts.ts'
import {getReviewServingFilterSignature, type ReviewServingFilterSignatureValue} from './reviewServingCursor.ts'
import {
  getReviewServingSnapshotManifest,
  type ReviewServingManifestRepositoryDatabase,
  type ReviewServingSnapshotManifest,
} from './reviewServingManifestRepository.ts'
import {readReviewServingRows, type ReviewServingReaderDatabase} from './reviewServingReader.ts'

export type ReviewSearchServiceDatabase = ReviewServingReaderDatabase & {run: (statement: string) => Promise<void>}

export type ReviewSearchModeRequest = 'substring' | 'tokenPrefix'

export type ReviewSearchServiceRequest = {
  createAsyncWork?: boolean
  filters?: Partial<Record<string, ReviewServingFilterSignatureValue>>
  limit: number
  projectId: string
  reviewConfigHash: string | null
  searchMode: ReviewSearchModeRequest
  searchText: string
  snapshotId: string
}

export type ReviewSearchTokenPrefixRow = {article_id: string; token: string}

export type ReviewSearchServiceResult =
  | {
      diagnostics: {projectId: string; searchMode: 'tokenPrefix'; searchText: string; snapshotId: string}
      rows: ReviewSearchTokenPrefixRow[]
      sql: string
      status: 'ready'
    }
  | {
      diagnostics: {
        jobId: string
        projectId: string
        searchMode: 'substringAsync'
        searchText: string
        snapshotId: string
      }
      status: 'async'
    }
  | {
      diagnostics: {
        projectId: string
        reason: string
        searchMode: ReviewSearchModeRequest | 'substringAsync'
        searchText: string
        snapshotId: string
      }
      status: 'indexing' | 'unavailable'
    }

type ReviewSearchServiceDependencies = {
  database?: ReviewSearchServiceDatabase
  manifestDatabase?: ReviewServingManifestRepositoryDatabase
}

const getDatabase = () => {
  return getAppDatabaseService() as ReviewSearchServiceDatabase
}

const hasText = (value: string | null | undefined) => {
  return typeof value === 'string' && value.trim().length > 0
}

const getManifestFreshness = (manifest: ReviewServingSnapshotManifest | null): ReviewServingFreshnessState => {
  if (!manifest) {
    return 'unavailable'
  }

  if (manifest.status === 'active') {
    return 'ready'
  }

  return manifest.status === 'candidate' ? 'indexing' : 'unavailable'
}

const getComponentIdentity = (manifest: ReviewServingSnapshotManifest, component: ReviewServingProjectionComponent) => {
  const states = [...manifest.componentState.required, ...manifest.componentState.optional]
  const state = states.find((componentState) => {
    return componentState.component === component
  })

  return state?.projectionIdentity ?? null
}

const getUnavailableResult = (
  request: ReviewSearchServiceRequest,
  status: 'indexing' | 'unavailable',
  reason: string,
): ReviewSearchServiceResult => {
  return {
    diagnostics: {
      projectId: request.projectId,
      reason,
      searchMode: request.searchMode,
      searchText: request.searchText,
      snapshotId: request.snapshotId,
    },
    status,
  }
}

const getSearchJobId = (input: {
  filterSignature: string
  projectId: string
  reviewConfigHash: string | null
  searchIdentity: string | null
  searchText: string
  snapshotId: string
}) => {
  const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 24)

  return `review-search-${hash}`
}

const getFilterSignature = (request: ReviewSearchServiceRequest) => {
  return getReviewServingFilterSignature({filters: request.filters ?? {}, searchText: request.searchText})
}

const createSubstringSearchJob = async (input: {
  database: ReviewSearchServiceDatabase
  filterSignature: string
  jobId: string
  manifest: ReviewServingSnapshotManifest
  projectScopeIdentity: string
  request: ReviewSearchServiceRequest
  searchIdentity: string | null
}) => {
  await input.database.run(`
    INSERT INTO app.review_search_job (
      job_id,
      project_id,
      search_identity,
      project_scope_identity,
      review_config_hash,
      snapshot_id,
      latest_snapshot_semantics,
      search_mode,
      search_text,
      filter_signature,
      cursor_json,
      status,
      result_count_availability
    ) VALUES (
      ${getSqlLiteral(input.jobId)},
      ${getSqlLiteral(input.request.projectId)},
      ${getSqlLiteral(input.searchIdentity)},
      ${getSqlLiteral(input.projectScopeIdentity)},
      ${getSqlLiteral(input.request.reviewConfigHash)},
      ${getSqlLiteral(input.manifest.snapshotId)},
      FALSE,
      'substringAsync',
      ${getSqlLiteral(input.request.searchText)},
      ${getSqlLiteral(input.filterSignature)},
      ${getSqlLiteral(JSON.stringify({cursor: null, limit: 500}))}::JSON,
      'pending',
      'async'
    ) ON CONFLICT (job_id) DO UPDATE SET updated_at = current_timestamp
  `)
}

const getManifest = async (
  request: ReviewSearchServiceRequest,
  manifestDatabase: ReviewServingManifestRepositoryDatabase,
) => {
  return getReviewServingSnapshotManifest(
    {projectId: request.projectId, snapshotId: request.snapshotId},
    manifestDatabase,
  )
}

const searchTokenPrefix = async (
  request: ReviewSearchServiceRequest,
  manifest: ReviewServingSnapshotManifest,
  database: ReviewSearchServiceDatabase,
  manifestDatabase: ReviewServingManifestRepositoryDatabase,
): Promise<ReviewSearchServiceResult> => {
  const searchIdentity = getComponentIdentity(manifest, 'search')
  const projectScopeIdentity = getComponentIdentity(manifest, 'projectScope')

  if (!searchIdentity || !projectScopeIdentity) {
    return getUnavailableResult(request, 'indexing', 'search projection identity is not ready')
  }

  const result = await readReviewServingRows<ReviewSearchTokenPrefixRow>(
    {
      contractKey: 'review.search.tokenPrefix',
      limit: request.limit,
      projectId: request.projectId,
      reviewConfigHash: request.reviewConfigHash,
      searchIdentity,
      searchMode: 'tokenPrefix',
      searchState: {availability: 'ready', snapshotId: request.snapshotId},
      searchText: request.searchText,
      searchTokenPrefix: request.searchText.trim().toLowerCase(),
      snapshotId: request.snapshotId,
    },
    {database, diagnosticsDatabase: manifestDatabase, manifestDatabase},
  )

  return result.status === 'accepted'
    ? {
        diagnostics: {
          projectId: request.projectId,
          searchMode: 'tokenPrefix',
          searchText: request.searchText,
          snapshotId: request.snapshotId,
        },
        rows: result.rows,
        sql: result.sql,
        status: 'ready',
      }
    : getUnavailableResult(request, 'unavailable', result.reason)
}

const searchSubstring = async (
  request: ReviewSearchServiceRequest,
  manifest: ReviewServingSnapshotManifest,
  database: ReviewSearchServiceDatabase,
  manifestDatabase: ReviewServingManifestRepositoryDatabase,
): Promise<ReviewSearchServiceResult> => {
  const searchIdentity = getComponentIdentity(manifest, 'search')
  const projectScopeIdentity = getComponentIdentity(manifest, 'projectScope')

  if (!projectScopeIdentity) {
    return getUnavailableResult(request, 'indexing', 'project scope projection identity is not ready')
  }

  const filterSignature = getFilterSignature(request)
  const jobId = getSearchJobId({
    filterSignature,
    projectId: request.projectId,
    reviewConfigHash: request.reviewConfigHash,
    searchIdentity,
    searchText: request.searchText,
    snapshotId: request.snapshotId,
  })

  if (request.createAsyncWork === true) {
    await createSubstringSearchJob({
      database,
      filterSignature,
      jobId,
      manifest,
      projectScopeIdentity,
      request,
      searchIdentity,
    })
  }

  const result = await readReviewServingRows<{job_id: string}>(
    {
      contractKey: 'review.search.substringAsync',
      jobFilterSignature: filterSignature,
      jobState: {jobId, processedCount: 0, snapshotId: request.snapshotId, status: 'pending', totalEstimate: null},
      limit: 1,
      projectId: request.projectId,
      reviewConfigHash: request.reviewConfigHash,
      searchIdentity,
      searchMode: 'substringAsync',
      searchState: {availability: 'async', jobId, reason: 'substring search runs async'},
      searchText: request.searchText,
      snapshotId: request.snapshotId,
    },
    {database, diagnosticsDatabase: manifestDatabase, manifestDatabase},
  )

  if (request.createAsyncWork !== true && (result.status !== 'accepted' || result.rows.length === 0)) {
    return getUnavailableResult(request, 'unavailable', 'substring search job is not available')
  }

  return {
    diagnostics: {
      jobId,
      projectId: request.projectId,
      searchMode: 'substringAsync',
      searchText: request.searchText,
      snapshotId: request.snapshotId,
    },
    status: 'async',
  }
}

export const searchReviewServing = async (
  request: ReviewSearchServiceRequest,
  dependencies?: ReviewSearchServiceDependencies,
): Promise<ReviewSearchServiceResult> => {
  const database = dependencies?.database ?? getDatabase()
  const manifestDatabase = dependencies?.manifestDatabase ?? (database as ReviewServingManifestRepositoryDatabase)

  if (!hasText(request.projectId) || !hasText(request.snapshotId) || !hasText(request.searchText)) {
    return getUnavailableResult(request, 'unavailable', 'search request identity is incomplete')
  }

  const manifest = await getManifest(request, manifestDatabase)
  const freshness = getManifestFreshness(manifest)

  if (freshness !== 'ready' || !manifest) {
    return getUnavailableResult(request, freshness === 'indexing' ? 'indexing' : 'unavailable', 'snapshot is not ready')
  }

  return request.searchMode === 'tokenPrefix'
    ? searchTokenPrefix(request, manifest, database, manifestDatabase)
    : searchSubstring(request, manifest, database, manifestDatabase)
}
