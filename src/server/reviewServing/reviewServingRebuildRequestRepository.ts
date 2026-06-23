import {createHash} from 'node:crypto'

import {Effect} from 'effect'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getJsonValue, getSqlLiteral} from '../services/appQueryHelpers.ts'
import {getStableReviewServingJson} from './reviewProjectionIdentity.ts'
import {
  type ReviewServingChunkManifestRepositoryDatabase,
  type ReviewServingChunkManifestRepositoryTransaction,
  type ReviewServingRebuildChunkBudgetFields,
  type ReviewServingRebuildChunkManifestInput,
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

export const createReviewServingRebuildRequestEffect = (
  input: ReviewServingRebuildRequestInput,
  database: ReviewServingChunkManifestRepositoryDatabase = getReviewServingRebuildRequestDatabase(),
) => {
  return Effect.tryPromise(async () => {
    const requestedComponents = getNormalizedComponents(input.requestedComponents)

    if (requestedComponents.length !== input.requestedComponents.length || requestedComponents.length === 0) {
      throw new Error(
        `Review rebuild request must use known components: ${reviewServingProjectionComponents.join(', ')}`,
      )
    }

    const requestId = input.requestId ?? getReviewServingRebuildRequestId(input)
    const overBudgetReason = getOverBudgetReason(input.estimate, input.budget)
    const admissionState: ReviewServingRebuildRequestAdmissionState =
      overBudgetReason === null ? 'admitted' : 'blocked_over_budget'
    const status: ReviewServingRebuildRequestStatus = overBudgetReason === null ? 'admitted' : 'blocked_over_budget'
    const chunkStatus = overBudgetReason === null ? 'pending' : 'blocked_over_budget'
    const chunkAdmissionState = overBudgetReason === null ? 'admitted' : 'blocked_over_budget'
    const nowSql = getSqlLiteral(new Date())

    return database.transaction(async (tx) => {
      await tx.run(`
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
        ) VALUES (
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
        )
        ON CONFLICT(request_id) DO UPDATE SET
          status = excluded.status,
          admission_state = excluded.admission_state,
          retry_after = excluded.retry_after,
          oom_category = excluded.oom_category,
          over_budget_reason = excluded.over_budget_reason,
          diagnostics_json = excluded.diagnostics_json,
          admitted_at = CASE
            WHEN excluded.status = 'admitted' THEN COALESCE(app.review_rebuild_request.admitted_at, ${nowSql})
            ELSE app.review_rebuild_request.admitted_at
          END,
          updated_at = ${nowSql}
      `)

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
        (
          input.chunks
          ?? requestedComponents.map((component) => {
            return {
              chunkEndKey: 'component:all',
              chunkStartKey: 'component:all',
              inputDigest: null,
              inputWatermark: 0,
              outputBaseGeneration: 0,
              projectId: input.projectId,
              projectionComponent: component,
              projectionIdentity: `${component}:request:${requestId}`,
            } satisfies ReviewServingRebuildChunkManifestInput
          })
        ).map((chunk) => {
          return {...chunk, ...chunkBudgetFields, requestId, status: chunkStatus}
        }),
        tx,
      )

      const created = await getReviewServingRebuildRequest({requestId}, tx)

      if (created === null) {
        throw new Error(`Failed to create review rebuild request ${requestId}`)
      }

      return created
    })
  })
}

export const createReviewServingRebuildRequest = (
  input: ReviewServingRebuildRequestInput,
  database: ReviewServingChunkManifestRepositoryDatabase = getReviewServingRebuildRequestDatabase(),
) => {
  return Effect.runPromise(createReviewServingRebuildRequestEffect(input, database))
}
