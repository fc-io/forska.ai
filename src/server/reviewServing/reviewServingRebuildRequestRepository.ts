import {createHash} from 'node:crypto'

import {Effect} from 'effect'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getJsonValue, getSqlLiteral} from '../services/appQueryHelpers.ts'
import {getStableReviewServingJson} from './reviewProjectionIdentity.ts'
import {
  getReviewServingRebuildChunkId,
  releaseInactiveRequestRebuildChunkManifestsForUpsert,
  type ReviewServingChunkManifestRepositoryDatabase,
  type ReviewServingChunkManifestRepositoryTransaction,
  type ReviewServingRebuildChunkBudgetFields,
  type ReviewServingRebuildChunkManifestInput,
  type ReviewServingRebuildChunkStatus,
  upsertReviewServingRebuildChunkManifests,
} from './reviewServingChunkManifestRepository.ts'
import {
  isReviewServingProjectionComponent,
  type ReviewServingProjectionComponent,
  reviewServingProjectionComponents,
} from './reviewServingContracts.ts'

export type ReviewServingRebuildRequestStatus =
  | 'pending_admission'
  | 'admitted'
  | 'blocked_over_budget'
  | 'running'
  | 'completed'
  | 'failed'
  | 'quarantined'
  | 'cancelled'

export type ReviewServingRebuildRequestAdmissionState = 'pending' | 'admitted' | 'blocked_over_budget'

export type ReviewServingRebuildRequestBudget = {
  maxInputRows?: number | null
  maxOutputBytes?: number | null
  maxOutputRows?: number | null
  maxPayloadBytes?: number | null
  maxPromptCount?: number | null
  maxSnapshotCount?: number | null
  maxTempBytes?: number | null
}

export type ReviewServingRebuildRequestEstimate = {
  estimatedInputRows?: number | null
  estimatedOutputBytes?: number | null
  estimatedOutputRows?: number | null
  estimatedPayloadBytes?: number | null
  estimatedPromptCount?: number | null
  estimatedSnapshotCount?: number | null
  estimatedTempBytes?: number | null
}

export type ReviewServingRebuildRequestInput = {
  budget?: ReviewServingRebuildRequestBudget
  chunks?: readonly ReviewServingRebuildChunkManifestInput[]
  diagnostics?: unknown
  estimate?: ReviewServingRebuildRequestEstimate
  identity?: unknown
  priority?: number
  projectId: string
  reason: string
  requestedComponents: readonly ReviewServingProjectionComponent[]
  requestId?: string
  retryPolicy?: unknown
  sourceWatermarks?: unknown
}

export type ReviewServingRebuildRequest = {
  admissionState: ReviewServingRebuildRequestAdmissionState
  admittedAt: string | null
  completedAt: string | null
  createdAt: string
  diagnosticsJson: unknown
  failedAt: string | null
  identityJson: unknown
  lastError: string | null
  leaseExpiresAt: string | null
  leaseOwner: string | null
  oomCategory: string | null
  overBudgetReason: string | null
  priority: number
  projectId: string
  reason: string
  requestedComponents: ReviewServingProjectionComponent[]
  requestId: string
  retryAfter: string | null
  retryCount: number
  retryPolicyJson: unknown
  sourceWatermarksJson: unknown
  status: ReviewServingRebuildRequestStatus
  updatedAt: string
}

type ReviewServingRebuildRequestRow = {
  admissionState: ReviewServingRebuildRequestAdmissionState
  admittedAt: string | null
  completedAt: string | null
  createdAt: string
  diagnosticsJson: unknown
  failedAt: string | null
  identityJson: unknown
  lastError: string | null
  leaseExpiresAt: string | null
  leaseOwner: string | null
  oomCategory: string | null
  overBudgetReason: string | null
  priority: number
  projectId: string
  reason: string
  requestedComponentsJson: unknown
  requestId: string
  retryAfter: string | null
  retryCount: number
  retryPolicyJson: unknown
  sourceWatermarksJson: unknown
  status: ReviewServingRebuildRequestStatus
  updatedAt: string
}

type DefaultRebuildArticleBoundsRow = {
  chunkEndKey: string | null
  chunkStartKey: string | null
  scopedArticleCount: number
}

type DefaultRebuildArticleRange = {chunkEndKey: string; chunkStartKey: string; scopedArticleCount: number}

type DefaultRebuildSnapshotStateRow = {componentStateJson: unknown}

type DefaultRebuildSnapshotComponentState = {
  baseGeneration: number
  inputWatermark: number
  projectionComponent: ReviewServingProjectionComponent
  projectionIdentity: string
}

type DefaultRebuildProjectionManifestRow = {
  baseGeneration: number
  inputDigest: string | null
  inputWatermark: number
  projectionComponent: ReviewServingProjectionComponent
  projectionIdentity: string
}

export type TerminalizeStaleZeroChunkReviewServingRebuildRequestInput = {
  apply?: boolean
  minimumAgeMinutes?: number
  now?: Date
  projectId: string
  requestId: string
}

export type TerminalizeStaleZeroChunkReviewServingRebuildRequestResult = {
  applied: boolean
  chunkCount: number | null
  currentRequest: ReviewServingRebuildRequest | null
  minimumAgeMinutes: number
  refusalReasons: string[]
  status: 'not_found' | 'refused' | 'dry_run' | 'terminalized'
}

export type ReleaseFailedRequestlessReviewServingRebuildChunksInput = {
  apply?: boolean
  projectId: string
  requestId: string
}

export type ReleaseFailedRequestlessReviewServingRebuildChunkCount = {
  admissionState: string
  chunkCount: number
  projectionComponent: string
  status: string
}

export type ReleaseFailedRequestlessReviewServingRebuildChunksResult = {
  affectedCount: number
  applied: boolean
  chunkCounts: ReleaseFailedRequestlessReviewServingRebuildChunkCount[]
  currentRequest: ReviewServingRebuildRequest | null
  refusalReasons: string[]
  sampleChunkIds: string[]
  status: 'not_found' | 'refused' | 'dry_run' | 'released'
}

export type ReviewServingSummaryPartialCleanupAuthorizationTable = 'mart.review_article_summary_rebuild_partial_v4'

export type AuthorizeReviewServingSummaryPartialCleanupInput = {
  apply?: boolean
  chunkId: string
  expectedRowCount: number
  expiresAt?: Date | string
  minimumAgeMinutes?: number
  now?: Date
  operatorAck: string
  partialTable: ReviewServingSummaryPartialCleanupAuthorizationTable
  projectId: string
  reason: string
  requestId: string
  reviewConfigHash: string
  snapshotId: string
}

export type ReviewServingSummaryPartialCleanupAuthorizationGuardCounts = {
  activeAdmittedRunningPendingOrRunningChunkCount: number
  affectedRowCount: number
  allChunkCount: number
  liveLeaseCount: number
  matchingSummaryChunkCount: number
  newestDiagnosticCount: number
  retryableFailedChunkCount: number
  snapshotPinCount: number
  snapshotProtectionCount: number
  tooNewRowCount: number
}

export type AuthorizeReviewServingSummaryPartialCleanupResult = {
  applied: boolean
  authorizationId: string | null
  currentRequest: ReviewServingRebuildRequest | null
  expiresAt: string | null
  guardCounts: ReviewServingSummaryPartialCleanupAuthorizationGuardCounts | null
  minimumAgeMinutes: number
  refusalReasons: string[]
  status: 'not_found' | 'refused' | 'dry_run' | 'authorized'
}

const requestBudgetPairs = [
  ['estimatedInputRows', 'maxInputRows', 'input rows'],
  ['estimatedOutputRows', 'maxOutputRows', 'output rows'],
  ['estimatedOutputBytes', 'maxOutputBytes', 'output bytes'],
  ['estimatedPayloadBytes', 'maxPayloadBytes', 'payload bytes'],
  ['estimatedPromptCount', 'maxPromptCount', 'prompt count'],
  ['estimatedSnapshotCount', 'maxSnapshotCount', 'snapshot count'],
  ['estimatedTempBytes', 'maxTempBytes', 'temp bytes'],
] as const

const getReviewServingRebuildRequestDatabase = () => {
  return getAppDatabaseService() as ReviewServingChunkManifestRepositoryDatabase
}

const getJsonSqlLiteral = (value: unknown) => {
  return getSqlLiteral(getStableReviewServingJson(value ?? {}))
}

const getSqlStringList = (values: readonly string[]) => {
  return values.map(getSqlLiteral).join(', ')
}

const getOptionalTimestampLiteral = (value: Date | string | null | undefined) => {
  return value === null || value === undefined ? 'NULL' : getSqlLiteral(value)
}

const getNormalizedPriority = (value: number | undefined) => {
  return Number.isInteger(value) && value !== undefined && value >= 0 ? value : 100
}

const getNormalizedComponents = (components: readonly ReviewServingProjectionComponent[]) => {
  return [...new Set(components)].filter((component): component is ReviewServingProjectionComponent => {
    return isReviewServingProjectionComponent(component)
  })
}

export const getReviewServingRebuildRequestId = (input: Omit<ReviewServingRebuildRequestInput, 'chunks'>) => {
  return `rebuild:${createHash('sha256')
    .update(
      getStableReviewServingJson({
        identity: input.identity ?? {},
        projectId: input.projectId,
        reason: input.reason,
        requestedComponents: getNormalizedComponents(input.requestedComponents),
        sourceWatermarks: input.sourceWatermarks ?? {},
      }),
    )
    .digest('hex')
    .slice(0, 32)}`
}

const getOverBudgetReason = (
  estimate: ReviewServingRebuildRequestEstimate | undefined,
  budget: ReviewServingRebuildRequestBudget | undefined,
) => {
  const exceeded = requestBudgetPairs.flatMap(([estimateKey, budgetKey, label]) => {
    const estimatedValue = estimate?.[estimateKey]
    const maxValue = budget?.[budgetKey]

    return estimatedValue !== null
      && estimatedValue !== undefined
      && maxValue !== null
      && maxValue !== undefined
      && estimatedValue > maxValue
      ? [`${label}: estimated ${estimatedValue} > max ${maxValue}`]
      : []
  })

  return exceeded[0] ?? null
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const getUnknownArray = (value: unknown): readonly unknown[] => {
  return Array.isArray(value) ? value : []
}

const getNonNegativeInteger = (value: unknown, fallback: number) => {
  const numberValue = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN

  return Number.isFinite(numberValue) && numberValue >= 0 ? Math.trunc(numberValue) : fallback
}

const getSnapshotComponentStates = (componentStateJson: unknown): DefaultRebuildSnapshotComponentState[] => {
  const parsed = getJsonValue(componentStateJson)
  const state = isRecord(parsed) ? parsed : {}
  const candidates = [...getUnknownArray(state.required), ...getUnknownArray(state.optional)]

  return candidates.flatMap((candidate) => {
    if (
      !isRecord(candidate)
      || typeof candidate.component !== 'string'
      || !isReviewServingProjectionComponent(candidate.component)
      || typeof candidate.projectionIdentity !== 'string'
    ) {
      return []
    }

    return [
      {
        baseGeneration: getNonNegativeInteger(candidate.baseGeneration, 0),
        inputWatermark: getNonNegativeInteger(candidate.patchWatermark, 0),
        projectionComponent: candidate.component,
        projectionIdentity: candidate.projectionIdentity,
      },
    ]
  })
}

const getDefaultRebuildArticleBounds = async (
  input: {projectId: string},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const [row] = await database.queryJson<DefaultRebuildArticleBoundsRow>(`
    SELECT
      MIN(article_id) AS chunkStartKey,
      MAX(article_id) AS chunkEndKey,
      CAST(COUNT(*) AS INTEGER) AS scopedArticleCount
    FROM (
      SELECT project_article.article_id
      FROM app.project_article project_article
      INNER JOIN app.project project ON project.id = project_article.project_id
      INNER JOIN app.article article ON article.id = project_article.article_id
      WHERE project_article.project_id = ${getSqlLiteral(input.projectId)}
        AND (project.date_from IS NULL OR article.article_created_at >= project.date_from)
        AND (project.date_to IS NULL OR article.article_created_at <= project.date_to)
      UNION
      SELECT article_import_route.article_id
      FROM app.project_import_route project_import_route
      INNER JOIN app.project project ON project.id = project_import_route.project_id
      INNER JOIN app.article_import_route article_import_route
        ON article_import_route.import_route_id = project_import_route.import_route_id
      INNER JOIN app.article article ON article.id = article_import_route.article_id
      WHERE project_import_route.project_id = ${getSqlLiteral(input.projectId)}
        AND (project.date_from IS NULL OR article.article_created_at >= project.date_from)
        AND (project.date_to IS NULL OR article.article_created_at <= project.date_to)
    ) scoped_article
  `)
  const scopedArticleCount = Number(row?.scopedArticleCount ?? 0)

  return row?.chunkStartKey === null
    || row?.chunkStartKey === undefined
    || row.chunkEndKey === null
    || scopedArticleCount === 0
    ? null
    : {chunkEndKey: row.chunkEndKey, chunkStartKey: row.chunkStartKey}
}

const defaultRebuildMaxAdmissionSplitCount = 64
const defaultRebuildNonPresplittableComponents = new Set<ReviewServingProjectionComponent>([
  'display',
  'judgmentInputContent',
  'llmStatus',
  'projectScope',
  'queue',
  'selectedImport',
])
const defaultRebuildNativeHeavyComponents = new Set<ReviewServingProjectionComponent>(['posting', 'summary'])
const defaultRebuildCoalescingCandidateComponents = new Set<ReviewServingProjectionComponent>([
  'humanStatus',
  'llmStatus',
  'posting',
  'queue',
  'search',
])
const defaultRebuildPresplitInputRowLimits = {
  display: 25_000,
  humanStatus: 64,
  judgmentInputContent: 5_000,
  llmStatus: 64,
  payload: 10_000,
  posting: 512,
  projectScope: 50_000,
  queue: 5_000,
  search: 50_000,
  selectedImport: 25_000,
  summary: 512,
} as const satisfies Record<ReviewServingProjectionComponent, number>

const defaultTerminalizeMinimumAgeMinutes = 60
const staleZeroChunkTerminalizationLastError =
  'Operator terminalized stale malformed V4 review rebuild request: admitted/running request has no rebuild chunks; no cleanup authorized.'
const staleOrphanSummaryPartialCleanupMode = 'stale_orphan_summary_partial'
export const reviewServingSummaryPartialCleanupAuthorizationAck =
  'authorize-stale-orphan-review-serving-summary-partial-cleanup'
const requestlessRebuildRequestPrefixes = ['requestless-bootstrap:', 'requestless-summary:'] as const
const isRequestlessRebuildRequestId = (requestId: string) => {
  return requestlessRebuildRequestPrefixes.some((prefix) => {
    return requestId.startsWith(prefix)
  })
}
const requestlessRebuildChunkReleaseStatuses = [
  'pending',
  'completed',
  'running',
  'failed',
] as const satisfies readonly ReviewServingRebuildChunkStatus[]
const requestlessRebuildChunkReleaseStatusSql = `(${requestlessRebuildChunkReleaseStatuses.map(getSqlLiteral).join(', ')})`

const getMinimumAgeMinutes = (value: number | undefined) => {
  return Number.isFinite(value) && value !== undefined && value >= 0
    ? Math.trunc(value)
    : defaultTerminalizeMinimumAgeMinutes
}

const getTimestampMillis = (value: string | null) => {
  if (value === null) {
    return Number.NaN
  }

  const timestamp = Date.parse(value)

  return Number.isFinite(timestamp) ? timestamp : Number.NaN
}

const getReviewServingRebuildRequestChunkCount = async (
  input: {requestId: string},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const [row] = await database.queryJson<{chunkCount: number | string}>(`
    SELECT CAST(COUNT(*) AS INTEGER) AS chunkCount
    FROM app.review_rebuild_chunk_manifest
    WHERE request_id = ${getSqlLiteral(input.requestId)}
  `)

  return Number(row?.chunkCount ?? 0)
}

const getStaleZeroChunkTerminalizationRefusalReasons = (input: {
  chunkCount: number
  minimumAgeMinutes: number
  now: Date
  projectId: string
  request: ReviewServingRebuildRequest
}) => {
  const reasons: string[] = []

  if (input.request.projectId !== input.projectId) {
    reasons.push('wrong_project')
  }

  if (input.request.admissionState !== 'admitted') {
    reasons.push('non_admitted_admission_state')
  }

  if (input.request.status !== 'admitted' && input.request.status !== 'running') {
    reasons.push('non_active_request_status')
  }

  if (input.request.leaseOwner !== null || input.request.leaseExpiresAt !== null) {
    reasons.push('request_has_lease')
  }

  if (input.chunkCount > 0) {
    reasons.push('request_has_chunks')
  }

  const createdAtMillis = getTimestampMillis(input.request.createdAt)
  const minimumAgeMillis = input.minimumAgeMinutes * 60 * 1000

  if (!Number.isFinite(createdAtMillis) || input.now.getTime() - createdAtMillis < minimumAgeMillis) {
    reasons.push('request_too_new')
  }

  return reasons
}

const getDefaultRebuildPresplitBucketCount = (input: {
  component: ReviewServingProjectionComponent
  estimate: ReviewServingRebuildRequestEstimate | undefined
  requestedComponents: readonly ReviewServingProjectionComponent[]
}) => {
  const estimatedInputRows = input.estimate?.estimatedInputRows
  const inputRowLimit = defaultRebuildPresplitInputRowLimits[input.component]

  return (input.requestedComponents.length === 1 || defaultRebuildNativeHeavyComponents.has(input.component))
    && !defaultRebuildNonPresplittableComponents.has(input.component)
    && estimatedInputRows !== null
    && estimatedInputRows !== undefined
    && estimatedInputRows > inputRowLimit
    ? Math.min(defaultRebuildMaxAdmissionSplitCount, Math.max(2, Math.ceil(estimatedInputRows / inputRowLimit)))
    : 1
}

const getDefaultRebuildChunkPlanningDiagnostics = (input: {
  chunkCount: number
  component: ReviewServingProjectionComponent
  estimate: ReviewServingRebuildRequestEstimate | undefined
  requestedComponents: readonly ReviewServingProjectionComponent[]
}) => {
  return input.chunkCount === 1
    ? undefined
    : {
        admissionPlan: {
          chunkCount: input.chunkCount,
          coalescingCandidate: defaultRebuildCoalescingCandidateComponents.has(input.component),
          component: input.component,
          estimatedInputRows: input.estimate?.estimatedInputRows ?? null,
          inputRowLimit: defaultRebuildPresplitInputRowLimits[input.component],
          maxAdmissionSplitCount: defaultRebuildMaxAdmissionSplitCount,
          requestedComponentCount: input.requestedComponents.length,
        },
        admissionPresplit: true,
      }
}

const getDefaultRebuildArticleRanges = async (
  input: {chunkCount: number; projectId: string},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const rows = await database.queryJson<DefaultRebuildArticleBoundsRow>(`
    WITH scoped_article AS (
      SELECT project_article.article_id
      FROM app.project_article project_article
      INNER JOIN app.project project ON project.id = project_article.project_id
      INNER JOIN app.article article ON article.id = project_article.article_id
      WHERE project_article.project_id = ${getSqlLiteral(input.projectId)}
        AND (project.date_from IS NULL OR article.article_created_at >= project.date_from)
        AND (project.date_to IS NULL OR article.article_created_at <= project.date_to)
      UNION
      SELECT article_import_route.article_id
      FROM app.project_import_route project_import_route
      INNER JOIN app.project project ON project.id = project_import_route.project_id
      INNER JOIN app.article_import_route article_import_route
        ON article_import_route.import_route_id = project_import_route.import_route_id
      INNER JOIN app.article article ON article.id = article_import_route.article_id
      WHERE project_import_route.project_id = ${getSqlLiteral(input.projectId)}
        AND (project.date_from IS NULL OR article.article_created_at >= project.date_from)
        AND (project.date_to IS NULL OR article.article_created_at <= project.date_to)
    ), chunked_article AS (
      SELECT
        article_id,
        NTILE(${input.chunkCount}) OVER (ORDER BY article_id) AS chunk_index
      FROM (
        SELECT DISTINCT article_id
        FROM scoped_article
      ) distinct_article
    ), bucket_range AS (
      SELECT
        chunk_index,
        MIN(article_id) AS scoped_start_key,
        MAX(article_id) AS scoped_end_key,
        CAST(COUNT(*) AS INTEGER) AS scopedArticleCount
      FROM chunked_article
      GROUP BY chunk_index
    ), bucket_with_boundary AS (
      SELECT
        chunk_index,
        scoped_start_key,
        scoped_end_key,
        scopedArticleCount,
        LAG(scoped_end_key) OVER (ORDER BY chunk_index) AS previous_scoped_end_key
      FROM bucket_range
    )
    SELECT
      CASE
        WHEN previous_scoped_end_key IS NULL THEN scoped_start_key
        ELSE previous_scoped_end_key || ' '
      END AS chunkStartKey,
      scoped_end_key AS chunkEndKey,
      scopedArticleCount
    FROM bucket_with_boundary
    ORDER BY chunk_index
  `)

  return rows.flatMap((row): DefaultRebuildArticleRange[] => {
    const scopedArticleCount = Number(row.scopedArticleCount ?? 0)

    return row.chunkStartKey === null || row.chunkEndKey === null || scopedArticleCount <= 0
      ? []
      : [{chunkEndKey: row.chunkEndKey, chunkStartKey: row.chunkStartKey, scopedArticleCount}]
  })
}

const getChunkEstimate = (input: {
  chunkCount: number
  estimate: ReviewServingRebuildRequestEstimate | undefined
}): ReviewServingRebuildRequestEstimate => {
  return input.chunkCount <= 1
    ? {
        estimatedInputRows: input.estimate?.estimatedInputRows,
        estimatedOutputBytes: input.estimate?.estimatedOutputBytes,
        estimatedOutputRows: input.estimate?.estimatedOutputRows,
        estimatedPayloadBytes: input.estimate?.estimatedPayloadBytes,
        estimatedPromptCount: input.estimate?.estimatedPromptCount,
        estimatedSnapshotCount: input.estimate?.estimatedSnapshotCount,
        estimatedTempBytes: input.estimate?.estimatedTempBytes,
      }
    : {
        estimatedInputRows:
          input.estimate?.estimatedInputRows === null || input.estimate?.estimatedInputRows === undefined
            ? input.estimate?.estimatedInputRows
            : Math.ceil(input.estimate.estimatedInputRows / input.chunkCount),
        estimatedOutputBytes:
          input.estimate?.estimatedOutputBytes === null || input.estimate?.estimatedOutputBytes === undefined
            ? input.estimate?.estimatedOutputBytes
            : Math.ceil(input.estimate.estimatedOutputBytes / input.chunkCount),
        estimatedOutputRows:
          input.estimate?.estimatedOutputRows === null || input.estimate?.estimatedOutputRows === undefined
            ? input.estimate?.estimatedOutputRows
            : Math.ceil(input.estimate.estimatedOutputRows / input.chunkCount),
        estimatedPayloadBytes:
          input.estimate?.estimatedPayloadBytes === null || input.estimate?.estimatedPayloadBytes === undefined
            ? input.estimate?.estimatedPayloadBytes
            : Math.ceil(input.estimate.estimatedPayloadBytes / input.chunkCount),
        estimatedPromptCount: input.estimate?.estimatedPromptCount,
        estimatedSnapshotCount: input.estimate?.estimatedSnapshotCount,
        estimatedTempBytes: input.estimate?.estimatedTempBytes,
      }
}

const maxDefinedEstimateValue = (values: Array<number | null | undefined>) => {
  const definedValues = values.filter((value): value is number => {
    return value !== null && value !== undefined
  })

  return definedValues.length === 0 ? undefined : Math.max(...definedValues)
}

const getChunkedAdmissionEstimate = (input: {
  chunks: readonly ReviewServingRebuildChunkManifestInput[]
  estimate: ReviewServingRebuildRequestEstimate | undefined
}) => {
  if (input.chunks.length <= 1) {
    return input.estimate
  }

  const canUsePerChunkAdmissionBudget = input.chunks.every((chunk) => {
    return chunk.projectionComponent === 'search'
  })

  if (!canUsePerChunkAdmissionBudget) {
    return input.estimate
  }

  const hasChunkEstimate = input.chunks.some((chunk) => {
    return (
      chunk.estimatedInputRows !== undefined
      || chunk.estimatedOutputBytes !== undefined
      || chunk.estimatedOutputRows !== undefined
      || chunk.estimatedPayloadBytes !== undefined
      || chunk.estimatedPromptCount !== undefined
      || chunk.estimatedTempBytes !== undefined
    )
  })

  if (!hasChunkEstimate) {
    return input.estimate
  }

  return {
    estimatedInputRows: maxDefinedEstimateValue(
      input.chunks.map((chunk) => {
        return chunk.estimatedInputRows
      }),
    ),
    estimatedOutputBytes: maxDefinedEstimateValue(
      input.chunks.map((chunk) => {
        return chunk.estimatedOutputBytes
      }),
    ),
    estimatedOutputRows: maxDefinedEstimateValue(
      input.chunks.map((chunk) => {
        return chunk.estimatedOutputRows
      }),
    ),
    estimatedPayloadBytes: maxDefinedEstimateValue(
      input.chunks.map((chunk) => {
        return chunk.estimatedPayloadBytes
      }),
    ),
    estimatedPromptCount: input.estimate?.estimatedPromptCount,
    estimatedSnapshotCount: input.estimate?.estimatedSnapshotCount,
    estimatedTempBytes: maxDefinedEstimateValue(
      input.chunks.map((chunk) => {
        return chunk.estimatedTempBytes
      }),
    ),
  } satisfies ReviewServingRebuildRequestEstimate
}

const getDefaultRebuildSnapshotStates = async (
  input: {projectId: string; requestedComponents: readonly ReviewServingProjectionComponent[]},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const requestedComponentSet = new Set(input.requestedComponents)
  const rows = await database.queryJson<DefaultRebuildSnapshotStateRow>(`
    SELECT component_state_json AS componentStateJson
    FROM app.review_serving_snapshot_manifest
    WHERE project_id = ${getSqlLiteral(input.projectId)}
      AND snapshot_status IN ('candidate', 'active')
    ORDER BY CASE WHEN snapshot_status = 'candidate' THEN 0 ELSE 1 END, updated_at DESC, snapshot_id DESC
  `)

  return rows
    .flatMap((row) => {
      return getSnapshotComponentStates(row.componentStateJson)
    })
    .filter((state) => {
      return requestedComponentSet.has(state.projectionComponent)
    })
}

const getUniqueSnapshotComponentStates = (states: readonly DefaultRebuildSnapshotComponentState[]) => {
  return states.reduce<DefaultRebuildSnapshotComponentState[]>((uniqueStates, state) => {
    const hasState = uniqueStates.some((candidate) => {
      return getProjectionManifestKey(candidate) === getProjectionManifestKey(state)
    })

    return hasState ? uniqueStates : [...uniqueStates, state]
  }, [])
}

const getComponentStatesByComponent = (
  requestedComponents: readonly ReviewServingProjectionComponent[],
  states: readonly DefaultRebuildSnapshotComponentState[],
) => {
  return requestedComponents.reduce<
    Partial<Record<ReviewServingProjectionComponent, DefaultRebuildSnapshotComponentState[]>>
  >((stateByComponent, component) => {
    const componentStates = states.filter((candidate) => {
      return candidate.projectionComponent === component
    })

    return componentStates.length === 0
      ? stateByComponent
      : {...stateByComponent, [component]: getUniqueSnapshotComponentStates(componentStates)}
  }, {})
}

const getProjectionManifestKey = (input: {
  baseGeneration: number
  projectionComponent: ReviewServingProjectionComponent
  projectionIdentity: string
}) => {
  return `${input.projectionComponent}\0${input.projectionIdentity}\0${input.baseGeneration}`
}

const getDefaultRebuildProjectionManifests = async (
  input: {projectId: string; states: readonly DefaultRebuildSnapshotComponentState[]},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const components = [
    ...new Set(
      input.states.map((state) => {
        return state.projectionComponent
      }),
    ),
  ]
  const requestedIdentityKeys = new Set(input.states.map(getProjectionManifestKey))

  if (components.length === 0) {
    return []
  }

  const rows = await database.queryJson<DefaultRebuildProjectionManifestRow>(`
    SELECT
      projection_component AS projectionComponent,
      projection_identity AS projectionIdentity,
      base_generation AS baseGeneration,
      input_watermark AS inputWatermark,
      input_digest AS inputDigest
    FROM app.review_projection_identity_manifest
    WHERE project_id IS NOT DISTINCT FROM ${getSqlLiteral(input.projectId)}
      AND projection_component IN (${getSqlStringList(components)})
    ORDER BY CASE WHEN status = 'active' THEN 0 WHEN status = 'candidate' THEN 1 ELSE 2 END, updated_at DESC
  `)

  return rows.filter((row) => {
    return requestedIdentityKeys.has(getProjectionManifestKey(row))
  })
}

const getProjectionManifestByKey = (rows: readonly DefaultRebuildProjectionManifestRow[]) => {
  return rows.reduce<Record<string, DefaultRebuildProjectionManifestRow>>((manifestByKey, row) => {
    const key = getProjectionManifestKey(row)

    return manifestByKey[key] === undefined ? {...manifestByKey, [key]: row} : manifestByKey
  }, {})
}

const getMissingDefaultRebuildComponents = (
  requestedComponents: readonly ReviewServingProjectionComponent[],
  stateByComponent: Partial<Record<ReviewServingProjectionComponent, DefaultRebuildSnapshotComponentState[]>>,
) => {
  return requestedComponents.filter((component) => {
    return (stateByComponent[component] ?? []).length === 0
  })
}

const getMissingDefaultRebuildManifestKeys = (
  states: readonly DefaultRebuildSnapshotComponentState[],
  manifestByKey: Record<string, DefaultRebuildProjectionManifestRow>,
) => {
  return states
    .filter((state) => {
      return manifestByKey[getProjectionManifestKey(state)] === undefined
    })
    .map((state) => {
      return `${state.projectionComponent}:${state.projectionIdentity}:${state.baseGeneration}`
    })
}

const assertDefaultRebuildExpansionComplete = (input: {
  manifestByKey: Record<string, DefaultRebuildProjectionManifestRow>
  projectId: string
  requestedComponents: readonly ReviewServingProjectionComponent[]
  selectedStates: readonly DefaultRebuildSnapshotComponentState[]
  stateByComponent: Partial<Record<ReviewServingProjectionComponent, DefaultRebuildSnapshotComponentState[]>>
}) => {
  const missingComponents = getMissingDefaultRebuildComponents(input.requestedComponents, input.stateByComponent)
  const missingManifestKeys = getMissingDefaultRebuildManifestKeys(input.selectedStates, input.manifestByKey)

  if (missingComponents.length > 0 || missingManifestKeys.length > 0) {
    throw new Error(
      `Review rebuild request for ${input.projectId} skipped requested rebuild components: ${[
        ...missingComponents,
        ...missingManifestKeys,
      ].join(', ')}`,
    )
  }
}

const getDefaultReviewServingRebuildChunks = async (
  input: {
    estimate: ReviewServingRebuildRequestEstimate | undefined
    projectId: string
    requestedComponents: readonly ReviewServingProjectionComponent[]
  },
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const articleBounds = await getDefaultRebuildArticleBounds(input, database)

  if (articleBounds === null) {
    return []
  }

  const snapshotStates = await getDefaultRebuildSnapshotStates(input, database)
  const stateByComponent = getComponentStatesByComponent(input.requestedComponents, snapshotStates)
  const selectedStates = input.requestedComponents.flatMap((component) => {
    const states = stateByComponent[component]

    return states ?? []
  })
  const manifests = await getDefaultRebuildProjectionManifests(
    {projectId: input.projectId, states: selectedStates},
    database,
  )
  const manifestByKey = getProjectionManifestByKey(manifests)

  assertDefaultRebuildExpansionComplete({
    manifestByKey,
    projectId: input.projectId,
    requestedComponents: input.requestedComponents,
    selectedStates,
    stateByComponent,
  })

  return selectedStates.reduce<Promise<ReviewServingRebuildChunkManifestInput[]>>(async (previous, state) => {
    const chunks = await previous
    const manifest = manifestByKey[getProjectionManifestKey(state)]

    if (manifest === undefined) {
      throw new Error(`Review rebuild request for ${input.projectId} skipped requested rebuild manifest`)
    }

    const chunkCount = getDefaultRebuildPresplitBucketCount({
      component: state.projectionComponent,
      estimate: input.estimate,
      requestedComponents: input.requestedComponents,
    })
    const articleRanges =
      chunkCount === 1
        ? [{...articleBounds, scopedArticleCount: 0}]
        : await getDefaultRebuildArticleRanges({chunkCount, projectId: input.projectId}, database)
    const chunkEstimate = getChunkEstimate({chunkCount: articleRanges.length, estimate: input.estimate})

    const stateChunks = articleRanges.map((articleRange) => {
      return {
        ...chunkEstimate,
        chunkEndKey: articleRange.chunkEndKey,
        chunkStartKey: articleRange.chunkStartKey,
        diagnosticsJson: getDefaultRebuildChunkPlanningDiagnostics({
          chunkCount,
          component: state.projectionComponent,
          estimate: input.estimate,
          requestedComponents: input.requestedComponents,
        }),
        inputDigest: manifest.inputDigest,
        inputWatermark: Number(manifest.inputWatermark ?? state.inputWatermark),
        outputBaseGeneration: state.baseGeneration,
        projectId: input.projectId,
        projectionComponent: state.projectionComponent,
        projectionIdentity: state.projectionIdentity,
        splitDepth: chunkCount === 1 ? undefined : 1,
      } satisfies ReviewServingRebuildChunkManifestInput
    })

    return [...chunks, ...stateChunks]
  }, Promise.resolve([]))
}

const getRequestFromRow = (row: ReviewServingRebuildRequestRow): ReviewServingRebuildRequest => {
  const requestedComponents = getJsonValue(row.requestedComponentsJson)
  const normalizedComponents = Array.isArray(requestedComponents)
    ? requestedComponents.filter((component): component is ReviewServingProjectionComponent => {
        return typeof component === 'string' && isReviewServingProjectionComponent(component)
      })
    : []

  return {
    admissionState: row.admissionState,
    admittedAt: row.admittedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    diagnosticsJson: getJsonValue(row.diagnosticsJson),
    failedAt: row.failedAt,
    identityJson: getJsonValue(row.identityJson),
    lastError: row.lastError,
    leaseExpiresAt: row.leaseExpiresAt,
    leaseOwner: row.leaseOwner,
    oomCategory: row.oomCategory,
    overBudgetReason: row.overBudgetReason,
    priority: Number(row.priority),
    projectId: row.projectId,
    reason: row.reason,
    requestedComponents: normalizedComponents,
    requestId: row.requestId,
    retryAfter: row.retryAfter,
    retryCount: Number(row.retryCount),
    retryPolicyJson: getJsonValue(row.retryPolicyJson),
    sourceWatermarksJson: getJsonValue(row.sourceWatermarksJson),
    status: row.status,
    updatedAt: row.updatedAt,
  }
}

const getRequestSelectSql = () => {
  return `
    SELECT
      request_id AS requestId,
      project_id AS projectId,
      reason,
      requested_components_json AS requestedComponentsJson,
      source_watermarks_json AS sourceWatermarksJson,
      identity_json AS identityJson,
      priority,
      status,
      admission_state AS admissionState,
      retry_policy_json AS retryPolicyJson,
      retry_count AS retryCount,
      retry_after AS retryAfter,
      oom_category AS oomCategory,
      over_budget_reason AS overBudgetReason,
      diagnostics_json AS diagnosticsJson,
      lease_owner AS leaseOwner,
      lease_expires_at AS leaseExpiresAt,
      admitted_at AS admittedAt,
      completed_at AS completedAt,
      failed_at AS failedAt,
      last_error AS lastError,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM app.review_rebuild_request
  `
}

export const getReviewServingRebuildRequest = async (
  input: {requestId: string},
  database: ReviewServingChunkManifestRepositoryTransaction = getReviewServingRebuildRequestDatabase(),
) => {
  const [row] = await database.queryJson<ReviewServingRebuildRequestRow>(`
    ${getRequestSelectSql()}
    WHERE request_id = ${getSqlLiteral(input.requestId)}
    LIMIT 1
  `)

  return row === undefined ? null : getRequestFromRow(row)
}

const getReviewServingRebuildRequestScanSafe = async (
  input: {requestId: string},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const [row] = await database.queryJson<ReviewServingRebuildRequestRow>(`
    ${getRequestSelectSql()}
    WHERE (request_id || '') = ${getSqlLiteral(input.requestId)}
    LIMIT 1
  `)

  return row === undefined ? null : getRequestFromRow(row)
}

const getFailedRequestlessRebuildChunkCounts = async (
  input: {requestId: string},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const rows = await database.queryJson<{
    admissionState: string
    chunkCount: number | string
    projectionComponent: string
    status: string
  }>(`
    SELECT
      status,
      projection_component AS projectionComponent,
      admission_state AS admissionState,
      CAST(COUNT(*) AS INTEGER) AS chunkCount
    FROM app.review_rebuild_chunk_manifest
    WHERE (request_id || '') = ${getSqlLiteral(input.requestId)}
    GROUP BY status, projection_component, admission_state
    ORDER BY status, projection_component, admission_state
  `)

  return rows.map((row) => {
    return {
      admissionState: row.admissionState,
      chunkCount: Number(row.chunkCount),
      projectionComponent: row.projectionComponent,
      status: row.status,
    }
  })
}

const getFailedRequestlessRebuildChunkSampleIds = async (
  input: {requestId: string},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const rows = await database.queryJson<{chunkId: string}>(`
    SELECT chunk_id AS chunkId
    FROM app.review_rebuild_chunk_manifest
    WHERE (request_id || '') = ${getSqlLiteral(input.requestId)}
    ORDER BY updated_at ASC, chunk_id ASC
    LIMIT 20
  `)

  return rows.map((row) => {
    return row.chunkId
  })
}

const getFailedRequestlessRebuildChunkGuardCounts = async (
  input: {projectId: string; requestId: string},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const [row] = await database.queryJson<{
    affectedCount: number | string
    liveLeaseCount: number | string
    otherProjectCount: number | string
    unsafeStatusCount: number | string
  }>(`
    SELECT
      CAST(COUNT(*) AS INTEGER) AS affectedCount,
      CAST(COUNT(*) FILTER (WHERE project_id IS DISTINCT FROM ${getSqlLiteral(input.projectId)}) AS INTEGER) AS otherProjectCount,
      CAST(COUNT(*) FILTER (WHERE status NOT IN ${requestlessRebuildChunkReleaseStatusSql}) AS INTEGER) AS unsafeStatusCount,
      CAST(COUNT(*) FILTER (WHERE lease_owner IS NOT NULL OR lease_expires_at IS NOT NULL) AS INTEGER) AS liveLeaseCount
    FROM app.review_rebuild_chunk_manifest
    WHERE (request_id || '') = ${getSqlLiteral(input.requestId)}
  `)

  return {
    affectedCount: Number(row?.affectedCount ?? 0),
    liveLeaseCount: Number(row?.liveLeaseCount ?? 0),
    otherProjectCount: Number(row?.otherProjectCount ?? 0),
    unsafeStatusCount: Number(row?.unsafeStatusCount ?? 0),
  }
}

const getFailedRequestlessRebuildChunkReleaseRefusalReasons = (input: {
  guardCounts: Awaited<ReturnType<typeof getFailedRequestlessRebuildChunkGuardCounts>>
  projectId: string
  request: ReviewServingRebuildRequest
}) => {
  const reasons: string[] = []

  if (input.request.projectId !== input.projectId) {
    reasons.push('wrong_project')
  }

  if (
    !requestlessRebuildRequestPrefixes.some((prefix) => {
      return input.request.requestId.startsWith(prefix)
    })
  ) {
    reasons.push('non_requestless_request_id')
  }

  if (input.request.status !== 'failed') {
    reasons.push('non_failed_request_status')
  }

  if (input.request.admissionState !== 'admitted') {
    reasons.push('non_admitted_admission_state')
  }

  if (input.request.leaseOwner !== null || input.request.leaseExpiresAt !== null) {
    reasons.push('request_has_lease')
  }

  if (input.guardCounts.affectedCount === 0) {
    reasons.push('request_has_no_chunks')
  }

  if (input.guardCounts.otherProjectCount > 0) {
    reasons.push('chunk_project_mismatch')
  }

  if (input.guardCounts.liveLeaseCount > 0) {
    reasons.push('chunk_has_lease')
  }

  if (input.guardCounts.unsafeStatusCount > 0) {
    reasons.push('unsafe_chunk_status')
  }

  return reasons
}

const releaseFailedRequestlessRebuildChunks = async (
  input: {projectId: string; requestId: string},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const rows = await database.queryJson<{chunkId: string}>(`
    UPDATE app.review_rebuild_chunk_manifest
    SET status = 'pending',
        request_id = NULL,
        admission_state = 'admitted',
        retry_after = NULL,
        retry_count = 0,
        actual_input_rows = NULL,
        actual_output_bytes = NULL,
        actual_output_rows = NULL,
        actual_payload_bytes = NULL,
        actual_prompt_count = NULL,
        actual_temp_bytes = NULL,
        duration_ms = NULL,
        oom_category = NULL,
        over_budget_reason = NULL,
        budget_json = NULL,
        diagnostics_json = NULL,
        checksum = NULL,
        lease_owner = NULL,
        lease_expires_at = NULL,
        last_error = NULL,
        started_at = NULL,
        completed_at = NULL,
        updated_at = current_timestamp
    WHERE (request_id || '') = ${getSqlLiteral(input.requestId)}
      AND project_id IS NOT DISTINCT FROM ${getSqlLiteral(input.projectId)}
      AND status IN ${requestlessRebuildChunkReleaseStatusSql}
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM app.review_rebuild_request request
        WHERE (request.request_id || '') = app.review_rebuild_chunk_manifest.request_id
          AND request.project_id = ${getSqlLiteral(input.projectId)}
          AND request.status = 'failed'
          AND request.admission_state = 'admitted'
          AND request.lease_owner IS NULL
          AND request.lease_expires_at IS NULL
          AND (
            request.request_id LIKE 'requestless-bootstrap:%'
            OR request.request_id LIKE 'requestless-summary:%'
          )
      )
    RETURNING chunk_id AS chunkId
  `)

  return rows.length
}

export const releaseFailedRequestlessReviewServingRebuildChunks = async (
  input: ReleaseFailedRequestlessReviewServingRebuildChunksInput,
  database: ReviewServingChunkManifestRepositoryDatabase = getReviewServingRebuildRequestDatabase(),
): Promise<ReleaseFailedRequestlessReviewServingRebuildChunksResult> => {
  return database.transaction(async (tx) => {
    const request = await getReviewServingRebuildRequestScanSafe({requestId: input.requestId}, tx)

    if (request === null) {
      return {
        affectedCount: 0,
        applied: false,
        chunkCounts: [],
        currentRequest: null,
        refusalReasons: ['request_not_found'],
        sampleChunkIds: [],
        status: 'not_found',
      }
    }

    const [chunkCounts, sampleChunkIds, guardCounts] = await Promise.all([
      getFailedRequestlessRebuildChunkCounts({requestId: input.requestId}, tx),
      getFailedRequestlessRebuildChunkSampleIds({requestId: input.requestId}, tx),
      getFailedRequestlessRebuildChunkGuardCounts({projectId: input.projectId, requestId: input.requestId}, tx),
    ])
    const refusalReasons = getFailedRequestlessRebuildChunkReleaseRefusalReasons({
      guardCounts,
      projectId: input.projectId,
      request,
    })

    if (refusalReasons.length > 0) {
      return {
        affectedCount: guardCounts.affectedCount,
        applied: false,
        chunkCounts,
        currentRequest: request,
        refusalReasons,
        sampleChunkIds,
        status: 'refused',
      }
    }

    if (input.apply !== true) {
      return {
        affectedCount: guardCounts.affectedCount,
        applied: false,
        chunkCounts,
        currentRequest: request,
        refusalReasons: [],
        sampleChunkIds,
        status: 'dry_run',
      }
    }

    const affectedCount = await releaseFailedRequestlessRebuildChunks(
      {projectId: input.projectId, requestId: input.requestId},
      tx,
    )

    return {
      affectedCount,
      applied: true,
      chunkCounts,
      currentRequest: request,
      refusalReasons: [],
      sampleChunkIds,
      status: 'released',
    }
  })
}

const summaryPartialCleanupAuthorizationTables = new Set<ReviewServingSummaryPartialCleanupAuthorizationTable>([
  'mart.review_article_summary_rebuild_partial_v4',
])

const getSummaryPartialUpdatedAtColumn = (_partialTable: ReviewServingSummaryPartialCleanupAuthorizationTable) => {
  return 'partial_updated_at'
}

const getAuthorizationExpiresAt = (input: {expiresAt?: Date | string; now: Date}) => {
  if (input.expiresAt !== undefined) {
    return input.expiresAt instanceof Date ? input.expiresAt.toISOString() : input.expiresAt
  }

  return new Date(input.now.getTime() + 60 * 60 * 1000).toISOString()
}

const getReviewConfigHashFromRequest = (request: ReviewServingRebuildRequest) => {
  const identity = request.identityJson

  return isRecord(identity) && typeof identity.reviewConfigHash === 'string' ? identity.reviewConfigHash : null
}

const getSummaryPartialCleanupAuthorizationId = (input: {
  chunkId: string
  partialTable: ReviewServingSummaryPartialCleanupAuthorizationTable
  projectId: string
  requestId: string
  reviewConfigHash: string
  snapshotId: string
}) => {
  return `review-partial-cleanup:${createHash('sha256')
    .update(
      getStableReviewServingJson({
        chunkId: input.chunkId,
        partialTable: input.partialTable,
        projectId: input.projectId,
        requestId: input.requestId,
        reviewConfigHash: input.reviewConfigHash,
        snapshotId: input.snapshotId,
      }),
    )
    .digest('hex')
    .slice(0, 32)}`
}

const getSummaryPartialCleanupAuthorizationGuardCounts = async (
  input: {
    chunkId: string
    minimumAgeMinutes: number
    now: Date
    partialTable: ReviewServingSummaryPartialCleanupAuthorizationTable
    projectId: string
    requestId: string
    reviewConfigHash: string
    snapshotId: string
  },
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const updatedAtColumn = getSummaryPartialUpdatedAtColumn(input.partialTable)
  const [row] = await database.queryJson<{
    activeAdmittedRunningPendingOrRunningChunkCount: number | string
    affectedRowCount: number | string
    allChunkCount: number | string
    liveLeaseCount: number | string
    matchingSummaryChunkCount: number | string
    newestDiagnosticCount: number | string
    retryableFailedChunkCount: number | string
    snapshotPinCount: number | string
    snapshotProtectionCount: number | string
    tooNewRowCount: number | string
  }>(`
    WITH scoped_request AS (
      SELECT *
      FROM app.review_rebuild_request
      WHERE request_id = ${getSqlLiteral(input.requestId)}
        AND project_id = ${getSqlLiteral(input.projectId)}
    ), scoped_partial AS (
      SELECT *
      FROM ${input.partialTable}
      WHERE project_id = ${getSqlLiteral(input.projectId)}
        AND review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
        AND request_id = ${getSqlLiteral(input.requestId)}
        AND chunk_id = ${getSqlLiteral(input.chunkId)}
        AND snapshot_id = ${getSqlLiteral(input.snapshotId)}
    ), scoped_summary_chunk AS (
      SELECT *
      FROM app.review_rebuild_chunk_manifest
      WHERE project_id = ${getSqlLiteral(input.projectId)}
        AND request_id = ${getSqlLiteral(input.requestId)}
        AND chunk_id = ${getSqlLiteral(input.chunkId)}
        AND snapshot_id = ${getSqlLiteral(input.snapshotId)}
        AND projection_component = 'summary'
    ), all_request_chunk AS (
      SELECT *
      FROM app.review_rebuild_chunk_manifest
      WHERE request_id = ${getSqlLiteral(input.requestId)}
    )
    SELECT
      CAST((SELECT COUNT(*) FROM scoped_partial) AS INTEGER) AS affectedRowCount,
      CAST((SELECT COUNT(*) FROM all_request_chunk) AS INTEGER) AS allChunkCount,
      CAST((SELECT COUNT(*) FROM scoped_summary_chunk) AS INTEGER) AS matchingSummaryChunkCount,
      CAST((
        SELECT COUNT(*)
        FROM scoped_partial partial
        WHERE partial.${updatedAtColumn} > ${getSqlLiteral(
          new Date(input.now.getTime() - input.minimumAgeMinutes * 60 * 1000).toISOString(),
        )}
      ) AS INTEGER) AS tooNewRowCount,
      CAST((
        SELECT COUNT(*)
        FROM scoped_request request
        WHERE request.lease_owner IS NOT NULL
          OR request.lease_expires_at IS NOT NULL
      ) + (
        SELECT COUNT(*)
        FROM scoped_summary_chunk chunk
        WHERE chunk.lease_owner IS NOT NULL
          OR chunk.lease_expires_at IS NOT NULL
      ) AS INTEGER) AS liveLeaseCount,
      CAST((
        SELECT COUNT(*)
        FROM scoped_request request
        INNER JOIN app.review_rebuild_chunk_manifest chunk
          ON chunk.request_id = request.request_id
          AND chunk.project_id = request.project_id
        WHERE request.status IN ('admitted', 'running')
          AND request.admission_state = 'admitted'
          AND chunk.status IN ('pending', 'running')
      ) AS INTEGER) AS activeAdmittedRunningPendingOrRunningChunkCount,
      CAST((
        SELECT COUNT(*)
        FROM scoped_request request
        INNER JOIN app.review_rebuild_chunk_manifest retryable_chunk
          ON retryable_chunk.request_id = request.request_id
          AND retryable_chunk.project_id = request.project_id
        WHERE retryable_chunk.status = 'failed'
          AND COALESCE(retryable_chunk.retry_count, 0) < COALESCE(
            GREATEST(
              1,
              TRY_CAST(json_extract_string(request.retry_policy_json, '$.maxAttempts') AS INTEGER)
            ),
            3
          )
      ) AS INTEGER) AS retryableFailedChunkCount,
      CAST((
        SELECT COUNT(*)
        FROM app.review_serving_snapshot_manifest active_manifest
        WHERE active_manifest.project_id = ${getSqlLiteral(input.projectId)}
          AND active_manifest.snapshot_status = 'active'
          AND (
            active_manifest.snapshot_id = ${getSqlLiteral(input.snapshotId)}
            OR active_manifest.last_known_good_snapshot_id = ${getSqlLiteral(input.snapshotId)}
            OR active_manifest.selected_import_snapshot_id = ${getSqlLiteral(input.snapshotId)}
          )
      ) AS INTEGER) AS snapshotProtectionCount,
      CAST((
        SELECT COUNT(*)
        FROM app.review_serving_snapshot_pin pin
        WHERE pin.project_id = ${getSqlLiteral(input.projectId)}
          AND pin.snapshot_id = ${getSqlLiteral(input.snapshotId)}
          AND pin.released_at IS NULL
          AND pin.ref_count > 0
          AND pin.expires_at > ${getSqlLiteral(input.now)}
      ) AS INTEGER) AS snapshotPinCount,
      CAST((
        SELECT COUNT(*)
        FROM scoped_request diagnostic_request
        WHERE diagnostic_request.status IN ('failed', 'blocked_over_budget', 'quarantined')
          AND NOT EXISTS (
            SELECT 1
            FROM app.review_rebuild_request newer_diagnostic_request
            WHERE newer_diagnostic_request.project_id = diagnostic_request.project_id
              AND newer_diagnostic_request.status IN ('failed', 'blocked_over_budget', 'quarantined')
              AND (
                newer_diagnostic_request.updated_at > diagnostic_request.updated_at
                OR (
                  newer_diagnostic_request.updated_at = diagnostic_request.updated_at
                  AND newer_diagnostic_request.request_id > diagnostic_request.request_id
                )
              )
          )
      ) AS INTEGER) AS newestDiagnosticCount
  `)

  return {
    activeAdmittedRunningPendingOrRunningChunkCount: Number(row?.activeAdmittedRunningPendingOrRunningChunkCount ?? 0),
    affectedRowCount: Number(row?.affectedRowCount ?? 0),
    allChunkCount: Number(row?.allChunkCount ?? 0),
    liveLeaseCount: Number(row?.liveLeaseCount ?? 0),
    matchingSummaryChunkCount: Number(row?.matchingSummaryChunkCount ?? 0),
    newestDiagnosticCount: Number(row?.newestDiagnosticCount ?? 0),
    retryableFailedChunkCount: Number(row?.retryableFailedChunkCount ?? 0),
    snapshotPinCount: Number(row?.snapshotPinCount ?? 0),
    snapshotProtectionCount: Number(row?.snapshotProtectionCount ?? 0),
    tooNewRowCount: Number(row?.tooNewRowCount ?? 0),
  }
}

const getSummaryPartialCleanupAuthorizationRefusalReasons = (input: {
  expectedRowCount: number
  guardCounts: ReviewServingSummaryPartialCleanupAuthorizationGuardCounts
  operatorAck: string
  projectId: string
  reason: string
  request: ReviewServingRebuildRequest
  reviewConfigHash: string
}) => {
  const reasons: string[] = []

  if (input.request.projectId !== input.projectId) {
    reasons.push('wrong_project')
  }

  const requestReviewConfigHash = getReviewConfigHashFromRequest(input.request)

  if (requestReviewConfigHash !== null && requestReviewConfigHash !== input.reviewConfigHash) {
    reasons.push('review_config_hash_mismatch')
  }

  if (input.operatorAck !== reviewServingSummaryPartialCleanupAuthorizationAck) {
    reasons.push('missing_operator_ack')
  }

  if (input.reason.trim().length === 0) {
    reasons.push('missing_reason')
  }

  if (!Number.isInteger(input.expectedRowCount) || input.expectedRowCount < 0) {
    reasons.push('invalid_expected_row_count')
  }

  if (input.guardCounts.affectedRowCount === 0) {
    reasons.push('no_matching_partial_rows')
  }

  if (input.guardCounts.affectedRowCount !== input.expectedRowCount) {
    reasons.push('expected_row_count_mismatch')
  }

  if (input.guardCounts.tooNewRowCount > 0) {
    reasons.push('partial_rows_too_new')
  }

  if (input.guardCounts.liveLeaseCount > 0) {
    reasons.push('request_or_chunk_has_live_lease')
  }

  if (input.guardCounts.activeAdmittedRunningPendingOrRunningChunkCount > 0) {
    reasons.push('active_request_has_pending_or_running_chunks')
  }

  if (input.guardCounts.retryableFailedChunkCount > 0) {
    reasons.push('retryable_failed_chunks')
  }

  if (input.guardCounts.snapshotProtectionCount > 0) {
    reasons.push('snapshot_protected_by_active_or_lkg')
  }

  if (input.guardCounts.snapshotPinCount > 0) {
    reasons.push('snapshot_protected_by_pin')
  }

  if (input.guardCounts.newestDiagnosticCount > 0) {
    reasons.push('newest_diagnostic_request')
  }

  if (input.guardCounts.allChunkCount > 0 && input.guardCounts.matchingSummaryChunkCount > 0) {
    reasons.push('non_orphan_summary_chunk_exists')
  }

  return reasons
}

const insertSummaryPartialCleanupAuthorization = async (
  input: {
    authorizationId: string
    chunkId: string
    expiresAt: string
    guardCounts: ReviewServingSummaryPartialCleanupAuthorizationGuardCounts
    operatorAck: string
    partialTable: ReviewServingSummaryPartialCleanupAuthorizationTable
    projectId: string
    reason: string
    requestId: string
    reviewConfigHash: string
    snapshotId: string
  },
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  await database.run(`
    UPDATE app.review_rebuild_partial_cleanup_authorization
    SET
      cleanup_mode = ${getSqlLiteral(staleOrphanSummaryPartialCleanupMode)},
      reason = ${getSqlLiteral(input.reason.trim())},
      evidence_json = ${getSqlLiteral(
        getStableReviewServingJson({guardCounts: input.guardCounts, mode: staleOrphanSummaryPartialCleanupMode}),
      )}::JSON,
      expected_row_count = ${getSqlLiteral(input.guardCounts.affectedRowCount)},
      observed_row_count = ${getSqlLiteral(input.guardCounts.affectedRowCount)},
      operator_ack = ${getSqlLiteral(input.operatorAck)},
      authorized_at = current_timestamp,
      expires_at = ${getSqlLiteral(input.expiresAt)},
      applied_at = NULL,
      applied_row_count = NULL,
      updated_at = current_timestamp
    WHERE authorization_id = ${getSqlLiteral(input.authorizationId)};

    INSERT INTO app.review_rebuild_partial_cleanup_authorization (
      authorization_id,
      project_id,
      review_config_hash,
      request_id,
      chunk_id,
      snapshot_id,
      partial_table,
      cleanup_mode,
      reason,
      evidence_json,
      expected_row_count,
      observed_row_count,
      operator_ack,
      authorized_at,
      expires_at,
      updated_at
    )
    SELECT
      ${getSqlLiteral(input.authorizationId)},
      ${getSqlLiteral(input.projectId)},
      ${getSqlLiteral(input.reviewConfigHash)},
      ${getSqlLiteral(input.requestId)},
      ${getSqlLiteral(input.chunkId)},
      ${getSqlLiteral(input.snapshotId)},
      ${getSqlLiteral(input.partialTable)},
      ${getSqlLiteral(staleOrphanSummaryPartialCleanupMode)},
      ${getSqlLiteral(input.reason.trim())},
      ${getSqlLiteral(
        getStableReviewServingJson({guardCounts: input.guardCounts, mode: staleOrphanSummaryPartialCleanupMode}),
      )}::JSON,
      ${getSqlLiteral(input.guardCounts.affectedRowCount)},
      ${getSqlLiteral(input.guardCounts.affectedRowCount)},
      ${getSqlLiteral(input.operatorAck)},
      current_timestamp,
      ${getSqlLiteral(input.expiresAt)},
      current_timestamp
    WHERE NOT EXISTS (
      SELECT 1
      FROM app.review_rebuild_partial_cleanup_authorization existing
      WHERE existing.authorization_id = ${getSqlLiteral(input.authorizationId)}
    )
  `)
}

export const authorizeReviewServingSummaryPartialCleanup = async (
  input: AuthorizeReviewServingSummaryPartialCleanupInput,
  database: ReviewServingChunkManifestRepositoryDatabase = getReviewServingRebuildRequestDatabase(),
): Promise<AuthorizeReviewServingSummaryPartialCleanupResult> => {
  return database.transaction(async (tx) => {
    const now = input.now ?? new Date()
    const minimumAgeMinutes = getMinimumAgeMinutes(input.minimumAgeMinutes)

    if (!summaryPartialCleanupAuthorizationTables.has(input.partialTable)) {
      return {
        applied: false,
        authorizationId: null,
        currentRequest: null,
        expiresAt: null,
        guardCounts: null,
        minimumAgeMinutes,
        refusalReasons: ['unsupported_partial_table'],
        status: 'refused',
      }
    }

    const request = await getReviewServingRebuildRequestScanSafe({requestId: input.requestId}, tx)

    if (request === null) {
      return {
        applied: false,
        authorizationId: null,
        currentRequest: null,
        expiresAt: null,
        guardCounts: null,
        minimumAgeMinutes,
        refusalReasons: ['request_not_found'],
        status: 'not_found',
      }
    }

    const guardCounts = await getSummaryPartialCleanupAuthorizationGuardCounts(
      {
        chunkId: input.chunkId,
        minimumAgeMinutes,
        now,
        partialTable: input.partialTable,
        projectId: input.projectId,
        requestId: input.requestId,
        reviewConfigHash: input.reviewConfigHash,
        snapshotId: input.snapshotId,
      },
      tx,
    )
    const refusalReasons = getSummaryPartialCleanupAuthorizationRefusalReasons({
      expectedRowCount: input.expectedRowCount,
      guardCounts,
      operatorAck: input.operatorAck,
      projectId: input.projectId,
      reason: input.reason,
      request,
      reviewConfigHash: input.reviewConfigHash,
    })

    if (refusalReasons.length > 0) {
      return {
        applied: false,
        authorizationId: null,
        currentRequest: request,
        expiresAt: null,
        guardCounts,
        minimumAgeMinutes,
        refusalReasons,
        status: 'refused',
      }
    }

    const authorizationId = getSummaryPartialCleanupAuthorizationId(input)
    const expiresAt = getAuthorizationExpiresAt({expiresAt: input.expiresAt, now})

    if (input.apply !== true) {
      return {
        applied: false,
        authorizationId,
        currentRequest: request,
        expiresAt,
        guardCounts,
        minimumAgeMinutes,
        refusalReasons: [],
        status: 'dry_run',
      }
    }

    await insertSummaryPartialCleanupAuthorization(
      {
        authorizationId,
        chunkId: input.chunkId,
        expiresAt,
        guardCounts,
        operatorAck: input.operatorAck,
        partialTable: input.partialTable,
        projectId: input.projectId,
        reason: input.reason,
        requestId: input.requestId,
        reviewConfigHash: input.reviewConfigHash,
        snapshotId: input.snapshotId,
      },
      tx,
    )

    return {
      applied: true,
      authorizationId,
      currentRequest: request,
      expiresAt,
      guardCounts,
      minimumAgeMinutes,
      refusalReasons: [],
      status: 'authorized',
    }
  })
}

export const getActiveReviewServingRebuildRequestForProject = async (
  input: {projectId: string; reason?: string},
  database: ReviewServingChunkManifestRepositoryTransaction = getReviewServingRebuildRequestDatabase(),
) => {
  const reasonFilter = input.reason === undefined ? '' : `\n      AND reason = ${getSqlLiteral(input.reason)}`
  const [row] = await database.queryJson<ReviewServingRebuildRequestRow>(`
    ${getRequestSelectSql()}
    WHERE project_id = ${getSqlLiteral(input.projectId)}
      ${reasonFilter}
      AND status = 'admitted'
      AND admission_state = 'admitted'
      AND EXISTS (
        SELECT 1
        FROM app.review_rebuild_chunk_manifest chunk
        WHERE chunk.request_id = app.review_rebuild_request.request_id
          AND chunk.status IN ('pending', 'running', 'failed')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM app.review_rebuild_chunk_manifest chunk
        WHERE chunk.request_id = app.review_rebuild_request.request_id
          AND chunk.status IN ('blocked_over_budget', 'quarantined')
      )
    ORDER BY priority DESC, updated_at ASC, request_id ASC
    LIMIT 1
  `)

  return row === undefined ? null : getRequestFromRow(row)
}

export const boostReviewServingRebuildRequestPriority = async (
  input: {priority: number; requestId: string},
  database: ReviewServingChunkManifestRepositoryTransaction = getReviewServingRebuildRequestDatabase(),
) => {
  const priority = getNormalizedPriority(input.priority)

  await database.run(`
    UPDATE app.review_rebuild_request
    SET priority = CASE
          WHEN priority < ${getSqlLiteral(priority)} THEN ${getSqlLiteral(priority)}
          ELSE priority
        END,
        updated_at = current_timestamp
    WHERE request_id = ${getSqlLiteral(input.requestId)}
      AND status IN ('admitted', 'running')
      AND admission_state = 'admitted'
      AND priority <= ${getSqlLiteral(priority)}
  `)

  return getReviewServingRebuildRequest({requestId: input.requestId}, database)
}

export const boostActiveReviewServingRebuildRequestForProject = async (
  input: {priority: number; projectId: string; reason?: string},
  database: ReviewServingChunkManifestRepositoryTransaction = getReviewServingRebuildRequestDatabase(),
) => {
  const priority = getNormalizedPriority(input.priority)
  const reasonFilter = input.reason === undefined ? '' : `\n        AND reason = ${getSqlLiteral(input.reason)}`
  const activeRequests = await database.queryJson<{requestId: string}>(`
    SELECT request_id AS requestId
    FROM app.review_rebuild_request
    WHERE project_id = ${getSqlLiteral(input.projectId)}
      ${reasonFilter}
      AND status = 'admitted'
      AND admission_state = 'admitted'
      AND priority <= ${getSqlLiteral(priority)}
    ORDER BY priority DESC, updated_at ASC, request_id ASC
    LIMIT 10
  `)
  let activeRequest: {requestId: string} | undefined

  for (const request of activeRequests) {
    const [chunkStateRow] = await database.queryJson<{
      blockedCount: number | string
      progressableCount: number | string
    }>(`
      SELECT
        CAST(COUNT(*) FILTER (WHERE status IN ('blocked_over_budget', 'quarantined')) AS INTEGER) AS blockedCount,
        CAST(COUNT(*) FILTER (WHERE status IN ('pending', 'running', 'failed')) AS INTEGER) AS progressableCount
      FROM app.review_rebuild_chunk_manifest
      WHERE request_id = ${getSqlLiteral(request.requestId)}
    `)

    if (Number(chunkStateRow?.blockedCount ?? 0) === 0 && Number(chunkStateRow?.progressableCount ?? 0) > 0) {
      activeRequest = request
      break
    }
  }

  if (activeRequest === undefined) {
    return false
  }

  await database.run(`
    UPDATE app.review_rebuild_request
    SET priority = CASE
          WHEN priority < ${getSqlLiteral(priority)} THEN ${getSqlLiteral(priority)}
          ELSE priority
        END,
        updated_at = current_timestamp
    WHERE request_id = ${getSqlLiteral(activeRequest.requestId)}
      AND status IN ('admitted', 'running')
      AND admission_state = 'admitted'
      AND priority <= ${getSqlLiteral(priority)}
  `)

  return true
}

export const terminalizeStaleZeroChunkReviewServingRebuildRequest = async (
  input: TerminalizeStaleZeroChunkReviewServingRebuildRequestInput,
  database: ReviewServingChunkManifestRepositoryDatabase = getReviewServingRebuildRequestDatabase(),
): Promise<TerminalizeStaleZeroChunkReviewServingRebuildRequestResult> => {
  const minimumAgeMinutes = getMinimumAgeMinutes(input.minimumAgeMinutes)
  const now = input.now ?? new Date()

  return database.transaction(async (tx) => {
    const request = await getReviewServingRebuildRequest({requestId: input.requestId}, tx)

    if (request === null) {
      return {
        applied: false,
        chunkCount: null,
        currentRequest: null,
        minimumAgeMinutes,
        refusalReasons: ['request_not_found'],
        status: 'not_found',
      }
    }

    const chunkCount = await getReviewServingRebuildRequestChunkCount({requestId: input.requestId}, tx)
    const refusalReasons = getStaleZeroChunkTerminalizationRefusalReasons({
      chunkCount,
      minimumAgeMinutes,
      now,
      projectId: input.projectId,
      request,
    })

    if (refusalReasons.length > 0) {
      return {applied: false, chunkCount, currentRequest: request, minimumAgeMinutes, refusalReasons, status: 'refused'}
    }

    if (input.apply !== true) {
      return {
        applied: false,
        chunkCount,
        currentRequest: request,
        minimumAgeMinutes,
        refusalReasons: [],
        status: 'dry_run',
      }
    }

    await tx.run(`
      UPDATE app.review_rebuild_request
      SET status = 'failed',
          failed_at = current_timestamp,
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = current_timestamp,
          last_error = ${getSqlLiteral(staleZeroChunkTerminalizationLastError)}
      WHERE request_id = ${getSqlLiteral(input.requestId)}
        AND project_id = ${getSqlLiteral(input.projectId)}
        AND admission_state = 'admitted'
        AND status IN ('admitted', 'running')
        AND lease_owner IS NULL
        AND lease_expires_at IS NULL
        AND created_at <= ${getSqlLiteral(now)} - INTERVAL ${minimumAgeMinutes} MINUTE
        AND NOT EXISTS (
          SELECT 1
          FROM app.review_rebuild_chunk_manifest chunk
          WHERE chunk.request_id = app.review_rebuild_request.request_id
        )
    `)

    const currentRequest = await getReviewServingRebuildRequest({requestId: input.requestId}, tx)
    const applied =
      currentRequest?.status === 'failed' && currentRequest.lastError === staleZeroChunkTerminalizationLastError

    return {
      applied,
      chunkCount,
      currentRequest,
      minimumAgeMinutes,
      refusalReasons: applied ? [] : ['terminalization_update_not_applied'],
      status: applied ? 'terminalized' : 'refused',
    }
  })
}

const deleteObsoleteReviewServingRebuildChunks = async (
  input: {chunks: readonly ReviewServingRebuildChunkManifestInput[]; requestId: string},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const chunkIds = input.chunks.map((chunk) => {
    return getReviewServingRebuildChunkId({...chunk, requestId: input.requestId})
  })

  await database.run(`
    DELETE FROM app.review_rebuild_chunk_manifest
    WHERE request_id = ${getSqlLiteral(input.requestId)}
      AND chunk_id NOT IN (${getSqlStringList(chunkIds)})
      AND status <> 'running'
  `)
}

export const createReviewServingRebuildRequestEffect = (
  input: ReviewServingRebuildRequestInput,
  database: ReviewServingChunkManifestRepositoryDatabase = getReviewServingRebuildRequestDatabase(),
) => {
  return Effect.tryPromise({
    catch: (error) => {
      return error
    },
    try: async () => {
      const requestedComponents = getNormalizedComponents(input.requestedComponents)

      if (requestedComponents.length !== input.requestedComponents.length || requestedComponents.length === 0) {
        throw new Error(
          `Review rebuild request must use known components: ${reviewServingProjectionComponents.join(', ')}`,
        )
      }

      const requestId = input.requestId ?? getReviewServingRebuildRequestId(input)
      const nowSql = getSqlLiteral(new Date())

      return database.transaction(async (tx) => {
        const chunks =
          input.chunks
          ?? (await getDefaultReviewServingRebuildChunks(
            {estimate: input.estimate, projectId: input.projectId, requestedComponents},
            tx,
          ))
        const admissionEstimate = getChunkedAdmissionEstimate({chunks, estimate: input.estimate})
        const overBudgetReason = getOverBudgetReason(admissionEstimate, input.budget)
        const admissionState: ReviewServingRebuildRequestAdmissionState =
          overBudgetReason === null ? 'admitted' : 'blocked_over_budget'
        const status: ReviewServingRebuildRequestStatus = overBudgetReason === null ? 'admitted' : 'blocked_over_budget'
        const chunkStatus = overBudgetReason === null ? 'pending' : 'blocked_over_budget'
        const chunkAdmissionState = overBudgetReason === null ? 'admitted' : 'blocked_over_budget'

        if (chunks.length === 0) {
          throw new Error(`Review rebuild request ${requestId} created no rebuild chunks`)
        }

        if (input.chunks !== undefined) {
          await releaseInactiveRequestRebuildChunkManifestsForUpsert(
            chunks.map((chunk) => {
              return getReviewServingRebuildChunkId({...chunk, requestId})
            }),
            tx,
          )
        }

        const requestlessRequest = isRequestlessRebuildRequestId(requestId)
        const existingRequestRows = requestlessRequest
          ? await tx.queryJson<{requestId: string}>(`
              SELECT request.request_id AS requestId
              FROM app.review_rebuild_request request
            `)
          : []
        const requestRowExists = existingRequestRows.some((row) => {
          return row.requestId === requestId
        })

        if (!requestRowExists) {
          if (!requestlessRequest) {
            await tx.run(`
          UPDATE app.review_rebuild_request
          SET
            priority = CASE
              WHEN ${getSqlLiteral(getNormalizedPriority(input.priority))} > priority
                THEN ${getSqlLiteral(getNormalizedPriority(input.priority))}
              ELSE priority
            END,
            status = ${getSqlLiteral(status)},
            admission_state = ${getSqlLiteral(admissionState)},
            retry_after = ${getOptionalTimestampLiteral(null)},
            retry_count = 0,
            oom_category = ${getSqlLiteral(overBudgetReason === null ? null : 'request_over_budget')},
            over_budget_reason = ${getSqlLiteral(overBudgetReason)},
            diagnostics_json = ${getJsonSqlLiteral({
              budget: input.budget ?? {},
              diagnostics: input.diagnostics ?? {},
              estimate: input.estimate ?? {},
            })},
            lease_owner = NULL,
            lease_expires_at = NULL,
            admitted_at = CASE
              WHEN ${getSqlLiteral(status)} = 'admitted' THEN COALESCE(admitted_at, ${nowSql})
              ELSE admitted_at
            END,
            completed_at = NULL,
            failed_at = NULL,
            last_error = NULL,
            updated_at = ${nowSql}
          WHERE request_id = ${getSqlLiteral(requestId)}
        `)
          }

          const requestInsertSql = `
          INSERT INTO app.review_rebuild_request (
          request_id,
          project_id,
          reason,
          requested_components_json,
          source_watermarks_json,
          identity_json,
          priority,
          status,
          admission_state,
          retry_policy_json,
          retry_count,
          retry_after,
          oom_category,
          over_budget_reason,
          diagnostics_json,
          admitted_at,
          updated_at
        )
        SELECT
          ${getSqlLiteral(requestId)},
          ${getSqlLiteral(input.projectId)},
          ${getSqlLiteral(input.reason)},
          ${getJsonSqlLiteral(requestedComponents)},
          ${getJsonSqlLiteral(input.sourceWatermarks)},
          ${getJsonSqlLiteral(input.identity)},
          ${getSqlLiteral(getNormalizedPriority(input.priority))},
          ${getSqlLiteral(status)},
          ${getSqlLiteral(admissionState)},
          ${getJsonSqlLiteral(input.retryPolicy)},
          0,
          ${getOptionalTimestampLiteral(null)},
          ${getSqlLiteral(overBudgetReason === null ? null : 'request_over_budget')},
          ${getSqlLiteral(overBudgetReason)},
          ${getJsonSqlLiteral({
            budget: input.budget ?? {},
            diagnostics: input.diagnostics ?? {},
            estimate: input.estimate ?? {},
          })},
          ${status === 'admitted' ? nowSql : 'NULL'},
          ${nowSql}
        WHERE NOT EXISTS (
          SELECT 1
          FROM app.review_rebuild_request existing
          WHERE (existing.request_id || '') = (${getSqlLiteral(requestId)} || '')
        )
      `
          await tx.run(requestInsertSql)
        }

        if (input.chunks !== undefined) {
          await deleteObsoleteReviewServingRebuildChunks({chunks, requestId}, tx)
        }

        const chunkBudgetFields = {
          admissionState: chunkAdmissionState,
          budgetJson: input.budget ?? {},
          diagnosticsJson: input.diagnostics ?? {},
          estimatedInputRows: input.estimate?.estimatedInputRows,
          estimatedOutputBytes: input.estimate?.estimatedOutputBytes,
          estimatedOutputRows: input.estimate?.estimatedOutputRows,
          estimatedPayloadBytes: input.estimate?.estimatedPayloadBytes,
          estimatedPromptCount: input.estimate?.estimatedPromptCount,
          estimatedTempBytes: input.estimate?.estimatedTempBytes,
          maxInputRows: input.budget?.maxInputRows,
          maxOutputBytes: input.budget?.maxOutputBytes,
          maxOutputRows: input.budget?.maxOutputRows,
          maxPayloadBytes: input.budget?.maxPayloadBytes,
          maxPromptCount: input.budget?.maxPromptCount,
          maxTempBytes: input.budget?.maxTempBytes,
          oomCategory: overBudgetReason === null ? null : 'request_over_budget',
          overBudgetReason,
        } satisfies ReviewServingRebuildChunkBudgetFields

        await upsertReviewServingRebuildChunkManifests(
          chunks.map((chunk) => {
            return {
              ...chunk,
              ...chunkBudgetFields,
              diagnosticsJson: chunk.diagnosticsJson ?? chunkBudgetFields.diagnosticsJson,
              estimatedInputRows: chunk.estimatedInputRows ?? chunkBudgetFields.estimatedInputRows,
              estimatedOutputBytes: chunk.estimatedOutputBytes ?? chunkBudgetFields.estimatedOutputBytes,
              estimatedOutputRows: chunk.estimatedOutputRows ?? chunkBudgetFields.estimatedOutputRows,
              estimatedPayloadBytes: chunk.estimatedPayloadBytes ?? chunkBudgetFields.estimatedPayloadBytes,
              estimatedPromptCount: chunk.estimatedPromptCount ?? chunkBudgetFields.estimatedPromptCount,
              estimatedTempBytes: chunk.estimatedTempBytes ?? chunkBudgetFields.estimatedTempBytes,
              requestId,
              status: chunkStatus,
            }
          }),
          tx,
        )

        const created = await getReviewServingRebuildRequest({requestId}, tx)

        if (created === null) {
          throw new Error(`Failed to create review rebuild request ${requestId}`)
        }

        return created
      })
    },
  })
}

export const createReviewServingRebuildRequest = (
  input: ReviewServingRebuildRequestInput,
  database: ReviewServingChunkManifestRepositoryDatabase = getReviewServingRebuildRequestDatabase(),
) => {
  return Effect.runPromise(createReviewServingRebuildRequestEffect(input, database))
}
