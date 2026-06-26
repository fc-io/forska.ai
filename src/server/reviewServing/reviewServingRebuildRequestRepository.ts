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

type DefaultRebuildArticleBoundsRow = {
  chunkEndKey: string | null
  chunkStartKey: string | null
  scopedArticleCount: number
}

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
  input: {projectId: string; requestedComponents: readonly ReviewServingProjectionComponent[]},
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

  return selectedStates.map((state) => {
    const manifest = manifestByKey[getProjectionManifestKey(state)]

    if (manifest === undefined) {
      throw new Error(`Review rebuild request for ${input.projectId} skipped requested rebuild manifest`)
    }

    return {
      chunkEndKey: articleBounds.chunkEndKey,
      chunkStartKey: articleBounds.chunkStartKey,
      inputDigest: manifest.inputDigest,
      inputWatermark: Number(manifest.inputWatermark ?? state.inputWatermark),
      outputBaseGeneration: state.baseGeneration,
      projectId: input.projectId,
      projectionComponent: state.projectionComponent,
      projectionIdentity: state.projectionIdentity,
    } satisfies ReviewServingRebuildChunkManifestInput
  })
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

export const getActiveReviewServingRebuildRequestForProject = async (
  input: {projectId: string},
  database: ReviewServingChunkManifestRepositoryTransaction = getReviewServingRebuildRequestDatabase(),
) => {
  const [row] = await database.queryJson<ReviewServingRebuildRequestRow>(`
    ${getRequestSelectSql()}
    WHERE project_id = ${getSqlLiteral(input.projectId)}
      AND status IN ('admitted', 'running')
      AND admission_state = 'admitted'
    ORDER BY priority DESC, updated_at ASC, request_id ASC
    LIMIT 1
  `)

  return row === undefined ? null : getRequestFromRow(row)
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
      const overBudgetReason = getOverBudgetReason(input.estimate, input.budget)
      const admissionState: ReviewServingRebuildRequestAdmissionState =
        overBudgetReason === null ? 'admitted' : 'blocked_over_budget'
      const status: ReviewServingRebuildRequestStatus = overBudgetReason === null ? 'admitted' : 'blocked_over_budget'
      const chunkStatus = overBudgetReason === null ? 'pending' : 'blocked_over_budget'
      const chunkAdmissionState = overBudgetReason === null ? 'admitted' : 'blocked_over_budget'
      const nowSql = getSqlLiteral(new Date())

      return database.transaction(async (tx) => {
        const chunks =
          input.chunks
          ?? (await getDefaultReviewServingRebuildChunks({projectId: input.projectId, requestedComponents}, tx))

        if (chunks.length === 0) {
          throw new Error(`Review rebuild request ${requestId} created no rebuild chunks`)
        }

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
          chunks.map((chunk) => {
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
    },
  })
}

export const createReviewServingRebuildRequest = (
  input: ReviewServingRebuildRequestInput,
  database: ReviewServingChunkManifestRepositoryDatabase = getReviewServingRebuildRequestDatabase(),
) => {
  return Effect.runPromise(createReviewServingRebuildRequestEffect(input, database))
}
