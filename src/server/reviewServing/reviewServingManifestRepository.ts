import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getJsonValue, getSqlLiteral} from '../services/appQueryHelpers.ts'
import type {DuckdbWorkloadContext} from '../utils/duckdbService.ts'
import {getStableReviewServingJson, type ReviewServingIdentityValue} from './reviewProjectionIdentity.ts'
import {
  isReviewServingProjectionComponent,
  type ReviewServingComponentRequirements,
  type ReviewServingProjectionComponent,
  type ReviewServingSnapshotComponentStates,
  type ReviewServingSnapshotStatus,
} from './reviewServingContracts.ts'
import {
  getReviewServingProjectionComponentIdentityKey,
  type ReviewServingProjectionComponentIdentity,
  type ReviewServingSourcePartitionWatermarks,
} from './reviewServingProjectorDomain.ts'

export type ReviewServingManifestRepositoryDatabase = {
  queryJson: <T>(statement: string, workloadContext?: DuckdbWorkloadContext) => Promise<T[]>
  run: (statement: string) => Promise<void>
  transaction: <T>(operation: (tx: ReviewServingManifestRepositoryTransaction) => Promise<T>) => Promise<T>
}

export type ReviewServingManifestRepositoryTransaction = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

export type ReviewServingManifestReaderDatabase = Pick<ReviewServingManifestRepositoryDatabase, 'queryJson'>

export type ReviewServingProjectionManifestStatus = ReviewServingSnapshotStatus
export type ReviewServingSnapshotComponentStateMode = 'available' | 'raw'

export type ReviewServingProjectionIdentityManifest = ReviewServingProjectionComponentIdentity & {
  baseGeneration: number
  definitionVersion: string
  inputDigest: string | null
  inputWatermark: number
  inputWatermarks: ReviewServingSourcePartitionWatermarks
  invalidationReason: string | null
  manifestId: string
  patchRangeEnd: number | null
  patchRangeStart: number | null
  patchWatermark: number
  promptConfigHash: string | null
  reviewConfigHash: string | null
  status: ReviewServingProjectionManifestStatus
}

export type ReviewServingProjectionIdentityManifestInput = ReviewServingProjectionComponentIdentity & {
  baseGeneration: number
  definitionVersion: string
  inputDigest?: string | null
  inputWatermark: number
  inputWatermarks?: ReviewServingSourcePartitionWatermarks
  invalidationReason?: string | null
  patchRangeEnd?: number | null
  patchRangeStart?: number | null
  patchWatermark: number
  promptConfigHash?: string | null
  reviewConfigHash?: string | null
  status: ReviewServingProjectionManifestStatus
}

export type ReviewServingSnapshotManifest = {
  componentState: ReviewServingSnapshotComponentStates
  composedIdentity: ReviewServingIdentityValue
  lastError: string | null
  lastKnownGoodSnapshotId: string | null
  optionalComponents: readonly ReviewServingProjectionComponent[]
  projectId: string
  requiredComponents: readonly ReviewServingProjectionComponent[]
  reviewConfigHash: string | null
  selectedImportSnapshotId: string | null
  snapshotId: string
  sourceWatermarks: ReviewServingIdentityValue
  status: ReviewServingSnapshotStatus
  validationResult: ReviewServingIdentityValue | null
}

export type ReviewServingSnapshotManifestInput = {
  componentState: ReviewServingSnapshotComponentStates
  componentRequirements: ReviewServingComponentRequirements
  composedIdentity: ReviewServingIdentityValue
  lastKnownGoodSnapshotId?: string | null
  projectId: string
  reviewConfigHash?: string | null
  selectedImportSnapshotId?: string | null
  snapshotId: string
  sourceWatermarks: ReviewServingIdentityValue
  validationResult?: ReviewServingIdentityValue | null
}

type ProjectionIdentityManifestRow = {
  baseGeneration: number
  definitionVersion: string
  inputDigest: string | null
  inputWatermark: number
  inputWatermarksJson: unknown
  invalidationReason: string | null
  manifestId: string
  patchRangeEnd: number | null
  patchRangeStart: number | null
  patchWatermark: number
  projectId: string | null
  projectionComponent: ReviewServingProjectionComponent
  projectionIdentity: string
  promptConfigHash: string | null
  reviewConfigHash: string | null
  status: ReviewServingProjectionManifestStatus
}

type SnapshotManifestRow = {
  componentStateJson: unknown
  composedIdentityJson: unknown
  lastError: string | null
  lastKnownGoodSnapshotId: string | null
  optionalComponentsJson: unknown
  projectId: string
  requiredComponentsJson: unknown
  reviewConfigHash: string | null
  selectedImportSnapshotId: string | null
  snapshotId: string
  snapshotStatus: ReviewServingSnapshotStatus
  sourceWatermarksJson: unknown
  validationResultJson: unknown
}
type SnapshotComponentChunkAvailabilityRow = {
  completedChunkCount: number | string
  component: string | null
  maxChunkUpdatedAt: string | null
  outputBaseGeneration: number | string | null
  projectionIdentity: string | null
  requestCreatedAt: string | null
  requestId: string | null
  requestStatus: string | null
  requestUpdatedAt: string | null
  totalChunkCount: number | string
}
type SnapshotComponentProjectionStatusRow = {
  baseGeneration: number | string | null
  component: string | null
  projectionIdentity: string | null
  projectionStatus: string | null
}

type SnapshotManifestReadOptions = {
  componentStateMode?: ReviewServingSnapshotComponentStateMode
  workloadContext?: DuckdbWorkloadContext
}

const getReviewServingJsonLiteral = (value: ReviewServingIdentityValue) => {
  return `${getSqlLiteral(getStableReviewServingJson(value))}::JSON`
}

const getReviewServingNullableJsonLiteral = (value: ReviewServingIdentityValue | null | undefined) => {
  return value === null || value === undefined ? 'NULL' : getReviewServingJsonLiteral(value)
}

const getProjectionManifestId = (input: ReviewServingProjectionComponentIdentity) => {
  return getReviewServingProjectionComponentIdentityKey(input)
}

const getProjectionManifestFromRow = (row: ProjectionIdentityManifestRow): ReviewServingProjectionIdentityManifest => {
  return {
    baseGeneration: Number(row.baseGeneration),
    definitionVersion: row.definitionVersion,
    inputDigest: row.inputDigest,
    inputWatermark: Number(row.inputWatermark),
    inputWatermarks: getJsonValue(row.inputWatermarksJson) as ReviewServingSourcePartitionWatermarks,
    invalidationReason: row.invalidationReason,
    manifestId: row.manifestId,
    patchRangeEnd: row.patchRangeEnd === null ? null : Number(row.patchRangeEnd),
    patchRangeStart: row.patchRangeStart === null ? null : Number(row.patchRangeStart),
    patchWatermark: Number(row.patchWatermark),
    projectId: row.projectId,
    projectionComponent: row.projectionComponent,
    projectionIdentity: row.projectionIdentity,
    promptConfigHash: row.promptConfigHash,
    reviewConfigHash: row.reviewConfigHash,
    status: row.status,
  }
}

const getProjectionManifestInputWatermarks = (input: ReviewServingProjectionIdentityManifestInput) => {
  return input.inputWatermarks ?? {}
}

const mergeProjectionManifestInputWatermarks = (
  current: ReviewServingSourcePartitionWatermarks,
  next: ReviewServingSourcePartitionWatermarks,
) => {
  const merged = {...current}

  Object.entries(next).forEach(([sourcePartition, watermark]) => {
    const currentWatermark = merged[sourcePartition]

    merged[sourcePartition] =
      typeof currentWatermark === 'number' && Number.isFinite(currentWatermark)
        ? Math.max(currentWatermark, watermark)
        : watermark
  })

  return merged
}

const getEffectiveProjectionManifestInput = (
  current: ReviewServingProjectionIdentityManifest | null,
  input: ReviewServingProjectionIdentityManifestInput,
): ReviewServingProjectionIdentityManifestInput => {
  if (current === null) {
    return input
  }

  return {
    ...input,
    inputWatermark: Math.max(current.inputWatermark, input.inputWatermark),
    inputWatermarks: mergeProjectionManifestInputWatermarks(
      current.inputWatermarks,
      getProjectionManifestInputWatermarks(input),
    ),
  }
}

const getSnapshotManifestFromRow = (row: SnapshotManifestRow): ReviewServingSnapshotManifest => {
  return {
    componentState: getJsonValue(row.componentStateJson) as ReviewServingSnapshotComponentStates,
    composedIdentity: getJsonValue(row.composedIdentityJson) as ReviewServingIdentityValue,
    lastError: row.lastError,
    lastKnownGoodSnapshotId: row.lastKnownGoodSnapshotId,
    optionalComponents: getJsonValue(row.optionalComponentsJson) as readonly ReviewServingProjectionComponent[],
    projectId: row.projectId,
    requiredComponents: getJsonValue(row.requiredComponentsJson) as readonly ReviewServingProjectionComponent[],
    reviewConfigHash: row.reviewConfigHash,
    selectedImportSnapshotId: row.selectedImportSnapshotId,
    snapshotId: row.snapshotId,
    sourceWatermarks: getJsonValue(row.sourceWatermarksJson) as ReviewServingIdentityValue,
    status: row.snapshotStatus,
    validationResult: getJsonValue(row.validationResultJson) as ReviewServingIdentityValue | null,
  }
}

const getNonNegativeFiniteInteger = (value: unknown) => {
  const numberValue = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN

  return Number.isFinite(numberValue) && numberValue >= 0 ? Math.trunc(numberValue) : null
}

const getSnapshotComponentAvailabilityKey = (input: {
  baseGeneration: number
  component: ReviewServingProjectionComponent
  projectionIdentity: string
}) => {
  return `${input.component}\0${input.projectionIdentity}\0${input.baseGeneration}`
}

const getSnapshotManifestComponentStates = (manifest: ReviewServingSnapshotManifest) => {
  return [...manifest.componentState.required, ...manifest.componentState.optional]
}

const isProjectionStatusTrustedWithoutChunks = (manifest: ReviewServingSnapshotManifest, status: string | null) => {
  return manifest.status !== 'candidate' || status === 'active'
}

const snapshotManifestAvailabilityResultRowLimit = 64

const getSnapshotManifestAvailabilityWorkloadContext = (
  manifest: ReviewServingSnapshotManifest,
  workloadContext: DuckdbWorkloadContext | undefined,
): DuckdbWorkloadContext => {
  return {
    allowsTempSpill: false,
    fallbackIntent: workloadContext?.fallbackIntent ?? 'serveStale',
    maxResultRows: snapshotManifestAvailabilityResultRowLimit,
    projectId: manifest.projectId,
    routeOrJobKey: `${workloadContext?.routeOrJobKey ?? 'reviewServing.snapshotManifest'}.componentAvailability`,
    searchMode: workloadContext?.searchMode,
    timeoutMs: Math.min(workloadContext?.timeoutMs ?? 5_000, 5_000),
    timeoutScope: workloadContext?.timeoutScope ?? 'execution',
    workloadClass: workloadContext?.workloadClass ?? 'reviewServingManifest',
  }
}

const getSnapshotComponentStateValuesSql = (
  states: readonly (
    | ReviewServingSnapshotManifest['componentState']['required'][number]
    | ReviewServingSnapshotManifest['componentState']['optional'][number]
  )[],
) => {
  return states
    .map((state) => {
      return `(${getSqlLiteral(state.component)}, ${getSqlLiteral(state.projectionIdentity)}, ${getSqlLiteral(
        getNonNegativeFiniteInteger(state.baseGeneration) ?? -1,
      )})`
    })
    .join(', ')
}

const getAvailableSnapshotManifest = async (
  manifest: ReviewServingSnapshotManifest,
  database: ReviewServingManifestReaderDatabase,
  workloadContext?: DuckdbWorkloadContext,
): Promise<ReviewServingSnapshotManifest> => {
  const componentStates = getSnapshotManifestComponentStates(manifest)
  const validComponentStates = componentStates.filter((state) => {
    return getNonNegativeFiniteInteger(state.baseGeneration) !== null
  })

  if (componentStates.length === 0) {
    return manifest
  }

  if (validComponentStates.length === 0) {
    return {...manifest, componentState: {optional: [], required: []}}
  }

  const stateValuesSql = getSnapshotComponentStateValuesSql(validComponentStates)
  const availabilityWorkloadContext = getSnapshotManifestAvailabilityWorkloadContext(manifest, workloadContext)
  const projectionStatusRows = await database.queryJson<SnapshotComponentProjectionStatusRow>(
    `
    WITH requested_component(component, projectionIdentity, baseGeneration) AS (
      SELECT * FROM (VALUES ${stateValuesSql})
    )
    SELECT
      projection.projection_component AS component,
      projection.projection_identity AS projectionIdentity,
      projection.base_generation AS baseGeneration,
      projection.status AS projectionStatus
    FROM requested_component requested
    INNER JOIN app.review_projection_identity_manifest projection
      ON projection.project_id IS NOT DISTINCT FROM ${getSqlLiteral(manifest.projectId)}
      AND projection.projection_component = requested.component
      AND projection.projection_identity = requested.projectionIdentity
      AND projection.base_generation = requested.baseGeneration
  `,
    availabilityWorkloadContext,
  )
  const rows = await database.queryJson<SnapshotComponentChunkAvailabilityRow>(
    `
    WITH requested_component(component, projectionIdentity, baseGeneration) AS (
      SELECT * FROM (VALUES ${stateValuesSql})
    ), chunk_group AS (
      SELECT
        chunk.projection_component AS component,
        chunk.projection_identity AS projectionIdentity,
        chunk.output_base_generation AS outputBaseGeneration,
        chunk.request_id AS requestId,
        request.status AS requestStatus,
        request.created_at AS requestCreatedAt,
        request.updated_at AS requestUpdatedAt,
        MAX(chunk.updated_at) AS maxChunkUpdatedAt,
        CAST(COUNT(*) AS INTEGER) AS totalChunkCount,
        CAST(COUNT(*) FILTER (WHERE chunk.status = 'completed') AS INTEGER) AS completedChunkCount
      FROM requested_component requested
      INNER JOIN app.review_rebuild_chunk_manifest chunk
        ON chunk.project_id IS NOT DISTINCT FROM ${getSqlLiteral(manifest.projectId)}
        AND chunk.snapshot_id IS NOT DISTINCT FROM ${getSqlLiteral(manifest.snapshotId)}
        AND chunk.projection_component = requested.component
        AND chunk.projection_identity = requested.projectionIdentity
        AND chunk.output_base_generation = requested.baseGeneration
      INNER JOIN app.review_projection_identity_manifest projection
        ON projection.project_id IS NOT DISTINCT FROM chunk.project_id
        AND projection.projection_component = chunk.projection_component
        AND projection.projection_identity = chunk.projection_identity
        AND projection.base_generation = chunk.output_base_generation
      LEFT JOIN app.review_rebuild_request request
        ON chunk.request_id IS NOT NULL
        AND (request.request_id || '') = chunk.request_id
      WHERE chunk.request_id IS NULL
        OR request.status <> 'cancelled'
      GROUP BY
        chunk.projection_component,
        chunk.projection_identity,
        chunk.output_base_generation,
        chunk.request_id,
        request.status,
        request.created_at,
        request.updated_at
    ), ranked_chunk_group AS (
      SELECT
        chunk_group.*,
        ROW_NUMBER() OVER (
          PARTITION BY component, projectionIdentity, outputBaseGeneration
          ORDER BY
            requestCreatedAt DESC NULLS LAST,
            requestUpdatedAt DESC NULLS LAST,
            maxChunkUpdatedAt DESC NULLS LAST,
            CASE
              WHEN requestStatus IN ('admitted', 'running') THEN 3
              WHEN requestStatus = 'completed' THEN 2
              WHEN requestStatus IS NULL THEN 1
              ELSE 0
            END DESC,
            requestId DESC NULLS LAST
        ) AS availabilityRank
      FROM chunk_group
    )
    SELECT
      component,
      projectionIdentity,
      outputBaseGeneration,
      requestId,
      requestStatus,
      requestCreatedAt,
      requestUpdatedAt,
      maxChunkUpdatedAt,
      totalChunkCount,
      completedChunkCount
    FROM ranked_chunk_group
    WHERE availabilityRank = 1
  `,
    availabilityWorkloadContext,
  )

  const projectionStatusByKey = new Map<string, string | null>()
  const chunkAvailabilityByKey = new Map<string, SnapshotComponentChunkAvailabilityRow>()

  projectionStatusRows.forEach((row) => {
    const component = row.component
    const baseGeneration = getNonNegativeFiniteInteger(row.baseGeneration)

    if (
      !component
      || !isReviewServingProjectionComponent(component)
      || baseGeneration === null
      || !row.projectionIdentity
    ) {
      return
    }

    projectionStatusByKey.set(
      getSnapshotComponentAvailabilityKey({baseGeneration, component, projectionIdentity: row.projectionIdentity}),
      row.projectionStatus,
    )
  })

  rows.forEach((row) => {
    const component = row.component
    const outputBaseGeneration = getNonNegativeFiniteInteger(row.outputBaseGeneration)

    if (
      !component
      || !isReviewServingProjectionComponent(component)
      || outputBaseGeneration === null
      || !row.projectionIdentity
    ) {
      return
    }

    const key = getSnapshotComponentAvailabilityKey({
      baseGeneration: outputBaseGeneration,
      component,
      projectionIdentity: row.projectionIdentity,
    })
    chunkAvailabilityByKey.set(key, row)
  })

  const isStateAvailable = (
    state:
      | ReviewServingSnapshotManifest['componentState']['required'][number]
      | ReviewServingSnapshotManifest['componentState']['optional'][number],
  ) => {
    const baseGeneration = getNonNegativeFiniteInteger(state.baseGeneration)

    if (baseGeneration === null) {
      return false
    }

    const key = getSnapshotComponentAvailabilityKey({
      baseGeneration,
      component: state.component,
      projectionIdentity: state.projectionIdentity,
    })
    const chunkAvailability = chunkAvailabilityByKey.get(key)

    if (chunkAvailability === undefined) {
      return isProjectionStatusTrustedWithoutChunks(manifest, projectionStatusByKey.get(key) ?? null)
    }

    const totalChunkCount = getNonNegativeFiniteInteger(chunkAvailability.totalChunkCount)
    const completedChunkCount = getNonNegativeFiniteInteger(chunkAvailability.completedChunkCount)

    return totalChunkCount !== null && totalChunkCount > 0 && totalChunkCount === completedChunkCount
  }

  return {
    ...manifest,
    componentState: {
      optional: manifest.componentState.optional.filter(isStateAvailable),
      required: manifest.componentState.required.filter(isStateAvailable),
    },
  }
}

const getSnapshotManifestForMode = async (
  row: SnapshotManifestRow,
  database: ReviewServingManifestReaderDatabase,
  options: SnapshotManifestReadOptions = {},
) => {
  const manifest = getSnapshotManifestFromRow(row)

  return options.componentStateMode === 'available'
    ? getAvailableSnapshotManifest(manifest, database, options.workloadContext)
    : manifest
}

const getSnapshotManifestSelect = () => {
  return `
    SELECT
      project_id AS projectId,
      snapshot_id AS snapshotId,
      snapshot_status AS snapshotStatus,
      review_config_hash AS reviewConfigHash,
      composed_identity_json AS composedIdentityJson,
      component_state_json AS componentStateJson,
      required_components_json AS requiredComponentsJson,
      optional_components_json AS optionalComponentsJson,
      source_watermarks_json AS sourceWatermarksJson,
      validation_result_json AS validationResultJson,
      selected_import_snapshot_id AS selectedImportSnapshotId,
      last_known_good_snapshot_id AS lastKnownGoodSnapshotId,
      last_error AS lastError
    FROM app.review_serving_snapshot_manifest
  `
}

const getReviewConfigPredicate = (reviewConfigHash: string | null | undefined) => {
  return `review_config_hash IS NOT DISTINCT FROM ${getSqlLiteral(reviewConfigHash ?? null)}`
}

export const upsertReviewServingProjectionIdentityManifest = async (
  input: ReviewServingProjectionIdentityManifestInput,
  database: ReviewServingManifestRepositoryTransaction = getAppDatabaseService(),
) => {
  const manifestId = getProjectionManifestId(input)
  const current = await getReviewServingProjectionIdentityManifest(input, database)
  const effectiveInput = getEffectiveProjectionManifestInput(current, input)

  await database.run(`
    DELETE FROM app.review_projection_identity_manifest
    WHERE manifest_id = ${getSqlLiteral(manifestId)}
  `)
  await database.run(`
    INSERT INTO app.review_projection_identity_manifest (
      manifest_id,
      project_id,
      projection_component,
      projection_identity,
      base_generation,
      patch_watermark,
      patch_range_start,
      patch_range_end,
      input_watermark,
      input_watermarks_json,
      input_digest,
      definition_version,
      review_config_hash,
      prompt_config_hash,
      status,
      invalidation_reason,
      updated_at
    ) VALUES (
      ${getSqlLiteral(manifestId)},
      ${getSqlLiteral(input.projectId)},
      ${getSqlLiteral(input.projectionComponent)},
      ${getSqlLiteral(input.projectionIdentity)},
      ${getSqlLiteral(effectiveInput.baseGeneration)},
      ${getSqlLiteral(effectiveInput.patchWatermark)},
      ${getSqlLiteral(effectiveInput.patchRangeStart ?? null)},
      ${getSqlLiteral(effectiveInput.patchRangeEnd ?? null)},
      ${getSqlLiteral(effectiveInput.inputWatermark)},
      ${getReviewServingJsonLiteral(getProjectionManifestInputWatermarks(effectiveInput))},
      ${getSqlLiteral(effectiveInput.inputDigest ?? null)},
      ${getSqlLiteral(effectiveInput.definitionVersion)},
      ${getSqlLiteral(effectiveInput.reviewConfigHash ?? null)},
      ${getSqlLiteral(effectiveInput.promptConfigHash ?? null)},
      ${getSqlLiteral(effectiveInput.status)},
      ${getSqlLiteral(effectiveInput.invalidationReason ?? null)},
      current_timestamp
    )
  `)

  return {manifestId}
}

export const getReviewServingProjectionIdentityManifest = async (
  identity: ReviewServingProjectionComponentIdentity,
  database: ReviewServingManifestRepositoryTransaction = getAppDatabaseService(),
) => {
  const rows = await database.queryJson<ProjectionIdentityManifestRow>(`
    SELECT
      manifest_id AS manifestId,
      project_id AS projectId,
      projection_component AS projectionComponent,
      projection_identity AS projectionIdentity,
      base_generation AS baseGeneration,
      patch_watermark AS patchWatermark,
      patch_range_start AS patchRangeStart,
      patch_range_end AS patchRangeEnd,
      input_watermark AS inputWatermark,
      input_watermarks_json AS inputWatermarksJson,
      input_digest AS inputDigest,
      definition_version AS definitionVersion,
      review_config_hash AS reviewConfigHash,
      prompt_config_hash AS promptConfigHash,
      status,
      invalidation_reason AS invalidationReason
    FROM app.review_projection_identity_manifest
    WHERE manifest_id = ${getSqlLiteral(getProjectionManifestId(identity))}
    ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
    LIMIT 1
  `)

  return rows[0] === undefined ? null : getProjectionManifestFromRow(rows[0])
}

export const createCandidateReviewServingSnapshotManifest = async (
  input: ReviewServingSnapshotManifestInput,
  database: ReviewServingManifestRepositoryTransaction = getAppDatabaseService(),
) => {
  await database.run(`
    DELETE FROM app.review_serving_snapshot_manifest
    WHERE (project_id || '') = (${getSqlLiteral(input.projectId)} || '')
      AND (snapshot_id || '') = (${getSqlLiteral(input.snapshotId)} || '')
  `)

  await database.run(`
    INSERT INTO app.review_serving_snapshot_manifest (
      project_id,
      snapshot_id,
      snapshot_status,
      review_config_hash,
      composed_identity_json,
      component_state_json,
      required_components_json,
      optional_components_json,
      source_watermarks_json,
      validation_result_json,
      selected_import_snapshot_id,
      last_known_good_snapshot_id,
      updated_at
    )
    VALUES (
      ${getSqlLiteral(input.projectId)},
      ${getSqlLiteral(input.snapshotId)},
      'candidate',
      ${getSqlLiteral(input.reviewConfigHash ?? null)},
      ${getReviewServingJsonLiteral(input.composedIdentity)},
      ${getReviewServingJsonLiteral(input.componentState as unknown as ReviewServingIdentityValue)},
      ${getReviewServingJsonLiteral(input.componentRequirements.requiredComponents)},
      ${getReviewServingJsonLiteral(input.componentRequirements.optionalComponents)},
      ${getReviewServingJsonLiteral(input.sourceWatermarks)},
      ${getReviewServingNullableJsonLiteral(input.validationResult)},
      ${getSqlLiteral(input.selectedImportSnapshotId ?? null)},
      ${getSqlLiteral(input.lastKnownGoodSnapshotId ?? null)},
      current_timestamp
    )
  `)

  return {snapshotId: input.snapshotId}
}

export const markCandidateReviewServingSnapshotManifestFailed = async (
  input: {lastError: string; projectId: string; snapshotId: string},
  database: ReviewServingManifestRepositoryTransaction = getAppDatabaseService(),
) => {
  await database.run(`
    UPDATE app.review_serving_snapshot_manifest
    SET
      snapshot_status = 'failed',
      failed_at = current_timestamp,
      last_error = ${getSqlLiteral(input.lastError)},
      updated_at = current_timestamp
    WHERE project_id = ${getSqlLiteral(input.projectId)}
      AND snapshot_id = ${getSqlLiteral(input.snapshotId)}
      AND snapshot_status = 'candidate'
  `)
}

export type ReviewServingCandidateSnapshotSupersessionRow = {
  createdAt: string | null
  hasInFlightRebuild: boolean
  isOlderThanReference: boolean
  lastError: string | null
  referenceSnapshotId: string
  reviewConfigHash: string | null
  snapshotId: string
}

type CandidateSnapshotSupersessionRow = {
  createdAt: string | null
  hasInFlightRebuild: boolean | number | string | null
  isOlderThanReference: boolean | number | string | null
  lastError: string | null
  referenceSnapshotId: string
  reviewConfigHash: string | null
  snapshotId: string
}

const nonTerminalReviewServingRebuildRequestStatuses = [
  'pending_admission',
  'admitted',
  'running',
  'blocked_over_budget',
  'quarantined',
] as const
const inFlightReviewServingRebuildChunkStatuses = ['pending', 'running'] as const

const getSqlBoolean = (value: boolean | number | string | null | undefined) => {
  return value === true || value === 1 || value === 'true' || value === 't' || value === '1'
}

const getCandidateSnapshotSupersessionRowFromRow = (
  row: CandidateSnapshotSupersessionRow,
): ReviewServingCandidateSnapshotSupersessionRow => {
  return {
    createdAt: row.createdAt === null || row.createdAt === undefined ? null : String(row.createdAt),
    hasInFlightRebuild: getSqlBoolean(row.hasInFlightRebuild),
    isOlderThanReference: getSqlBoolean(row.isOlderThanReference),
    lastError: row.lastError ?? null,
    referenceSnapshotId: row.referenceSnapshotId,
    reviewConfigHash: row.reviewConfigHash ?? null,
    snapshotId: row.snapshotId,
  }
}

/**
 * Lists candidate snapshots for a project next to a reference snapshot that shares the same
 * review config hash. The reference is either an explicit snapshot (typically one that was just
 * promoted) or, when omitted, every active snapshot of the project.
 *
 * `hasInFlightRebuild` is true when any rebuild chunk targeting the candidate snapshot is still
 * pending/running or belongs to a non-terminal rebuild request. Such candidates are still being
 * built (the V4 rebuild service reuses them as bootstrap seeds) and must never be failed
 * automatically. `isOlderThanReference` compares the candidate row creation time with the
 * reference activation (or creation) time.
 */
export const getCandidateReviewServingSnapshotSupersessionRows = async (
  input: {projectId: string; referenceSnapshotId?: string | null; snapshotId?: string | null},
  database: ReviewServingManifestReaderDatabase = getAppDatabaseService(),
): Promise<ReviewServingCandidateSnapshotSupersessionRow[]> => {
  const referencePredicate =
    input.referenceSnapshotId === null || input.referenceSnapshotId === undefined
      ? `snapshot_status = 'active'`
      : `snapshot_id = ${getSqlLiteral(input.referenceSnapshotId)}`
  const candidatePredicate =
    input.snapshotId === null || input.snapshotId === undefined
      ? ''
      : `AND candidate.snapshot_id = ${getSqlLiteral(input.snapshotId)}`
  const nonTerminalRequestStatusSql = nonTerminalReviewServingRebuildRequestStatuses.map(getSqlLiteral).join(', ')
  const inFlightChunkStatusSql = inFlightReviewServingRebuildChunkStatuses.map(getSqlLiteral).join(', ')
  const rows = await database.queryJson<CandidateSnapshotSupersessionRow>(`
    WITH reference_snapshot AS (
      SELECT
        project_id,
        review_config_hash,
        snapshot_id,
        COALESCE(activated_at, created_at) AS reference_at
      FROM app.review_serving_snapshot_manifest
      WHERE project_id = ${getSqlLiteral(input.projectId)}
        AND ${referencePredicate}
    )
    SELECT
      candidate.snapshot_id AS snapshotId,
      candidate.review_config_hash AS reviewConfigHash,
      CAST(candidate.created_at AS VARCHAR) AS createdAt,
      candidate.last_error AS lastError,
      reference.snapshot_id AS referenceSnapshotId,
      CAST(COALESCE(candidate.created_at < reference.reference_at, FALSE) AS BOOLEAN) AS isOlderThanReference,
      CAST(EXISTS (
        SELECT 1
        FROM app.review_rebuild_chunk_manifest chunk
        LEFT JOIN app.review_rebuild_request request
          ON chunk.request_id IS NOT NULL
          AND (request.request_id || '') = chunk.request_id
        WHERE chunk.project_id IS NOT DISTINCT FROM candidate.project_id
          AND chunk.snapshot_id IS NOT DISTINCT FROM candidate.snapshot_id
          AND (
            chunk.status IN (${inFlightChunkStatusSql})
            OR request.status IN (${nonTerminalRequestStatusSql})
          )
      ) AS BOOLEAN) AS hasInFlightRebuild
    FROM app.review_serving_snapshot_manifest candidate
    INNER JOIN reference_snapshot reference
      ON reference.project_id = candidate.project_id
      AND reference.review_config_hash IS NOT DISTINCT FROM candidate.review_config_hash
      AND reference.snapshot_id <> candidate.snapshot_id
    WHERE candidate.project_id = ${getSqlLiteral(input.projectId)}
      AND candidate.snapshot_status = 'candidate'
      ${candidatePredicate}
    ORDER BY candidate.created_at ASC NULLS FIRST, candidate.snapshot_id ASC
  `)

  return rows.map(getCandidateSnapshotSupersessionRowFromRow)
}

export const isSupersededCandidateReviewServingSnapshot = (row: ReviewServingCandidateSnapshotSupersessionRow) => {
  return !row.hasInFlightRebuild && row.isOlderThanReference
}

export const getSupersededCandidateReviewServingSnapshotLastError = (referenceSnapshotId: string) => {
  return `superseded by snapshot ${referenceSnapshotId}`
}

/**
 * Marks candidate snapshots that were superseded by the given (just promoted) snapshot as failed.
 * Only candidates created before the promoted snapshot and without any in-flight rebuild are
 * touched; a newer candidate that is still being built keeps its status.
 */
export const failSupersededCandidateReviewServingSnapshotManifests = async (
  input: {projectId: string; promotedSnapshotId: string},
  database: ReviewServingManifestRepositoryTransaction = getAppDatabaseService(),
) => {
  const rows = await getCandidateReviewServingSnapshotSupersessionRows(
    {projectId: input.projectId, referenceSnapshotId: input.promotedSnapshotId},
    database,
  )
  const supersededSnapshotIds = [
    ...new Set(
      rows.filter(isSupersededCandidateReviewServingSnapshot).map((row) => {
        return row.snapshotId
      }),
    ),
  ]
  const skippedInFlightSnapshotIds = [
    ...new Set(
      rows
        .filter((row) => {
          return row.hasInFlightRebuild
        })
        .map((row) => {
          return row.snapshotId
        }),
    ),
  ]

  await supersededSnapshotIds.reduce<Promise<void>>(async (previous, snapshotId) => {
    await previous
    await markCandidateReviewServingSnapshotManifestFailed(
      {
        lastError: getSupersededCandidateReviewServingSnapshotLastError(input.promotedSnapshotId),
        projectId: input.projectId,
        snapshotId,
      },
      database,
    )
  }, Promise.resolve())

  return {skippedInFlightSnapshotIds, supersededSnapshotIds}
}

export type FailStaleCandidateReviewServingSnapshotManifestsResult = {
  applied: boolean
  failedSnapshotIds: string[]
  projectId: string
  skipped: Array<{reasons: string[]; referenceSnapshotId: string; snapshotId: string}>
  snapshotId: string | null
  staleCandidates: ReviewServingCandidateSnapshotSupersessionRow[]
  status: 'applied' | 'dry_run'
}

export const operatorStaleCandidateReviewServingSnapshotSource = 'operator failStaleReviewServingCandidateSnapshots'

const getStaleCandidateApplyLimit = (limit: number | null | undefined, staleCandidateCount: number) => {
  return limit === null || limit === undefined || !Number.isFinite(limit)
    ? staleCandidateCount
    : Math.max(0, Math.min(staleCandidateCount, Math.trunc(limit)))
}

/**
 * Recovery for candidate snapshots that were left behind (for example after a rebuild request
 * failed validation before the candidate was marked failed). Stale means: still `candidate`, older
 * than the active snapshot with the same review config hash, and not referenced by any in-flight
 * rebuild chunk or non-terminal rebuild request. Dry-run only reports. `limit` bounds how many
 * stale candidates are failed per call (oldest first); `source` is appended to the last_error so
 * operators can tell the operator script apart from the projector worker cleanup.
 */
export const failStaleCandidateReviewServingSnapshotManifests = async (
  input: {apply?: boolean; limit?: number | null; projectId: string; snapshotId?: string | null; source?: string},
  database: ReviewServingManifestRepositoryTransaction = getAppDatabaseService(),
): Promise<FailStaleCandidateReviewServingSnapshotManifestsResult> => {
  const apply = input.apply === true
  const snapshotId = input.snapshotId ?? null
  const source = input.source ?? operatorStaleCandidateReviewServingSnapshotSource
  const rows = await getCandidateReviewServingSnapshotSupersessionRows(
    {projectId: input.projectId, referenceSnapshotId: null, snapshotId},
    database,
  )
  const staleCandidates = rows.filter(isSupersededCandidateReviewServingSnapshot)
  const applyCandidates = staleCandidates.slice(0, getStaleCandidateApplyLimit(input.limit, staleCandidates.length))
  const skipped = rows
    .filter((row) => {
      return !isSupersededCandidateReviewServingSnapshot(row)
    })
    .map((row) => {
      return {
        reasons: [
          ...(row.hasInFlightRebuild ? ['referenced_by_in_flight_rebuild'] : []),
          ...(row.isOlderThanReference ? [] : ['not_older_than_active_snapshot']),
        ],
        referenceSnapshotId: row.referenceSnapshotId,
        snapshotId: row.snapshotId,
      }
    })
  const failedSnapshotIds = apply
    ? await applyCandidates.reduce<Promise<string[]>>(async (previous, row) => {
        const failed = await previous

        if (failed.includes(row.snapshotId)) {
          return failed
        }

        await markCandidateReviewServingSnapshotManifestFailed(
          {
            lastError: `${getSupersededCandidateReviewServingSnapshotLastError(row.referenceSnapshotId)} (${source})`,
            projectId: input.projectId,
            snapshotId: row.snapshotId,
          },
          database,
        )

        return [...failed, row.snapshotId]
      }, Promise.resolve([]))
    : []

  return {
    applied: apply,
    failedSnapshotIds,
    projectId: input.projectId,
    skipped,
    snapshotId,
    staleCandidates,
    status: apply ? 'applied' : 'dry_run',
  }
}

export type ReviewServingQueuedSnapshotProjectRow = {
  activeSnapshotCount: number
  projectId: string
  queuedSnapshotCount: number
  reviewConfigHash: string | null
}

type QueuedSnapshotProjectRow = {
  activeSnapshotCount: number | string
  projectId: string
  queuedSnapshotCount: number | string
  reviewConfigHash: string | null
}

/**
 * Projects (per review config hash) that currently queue more than one candidate/active snapshot
 * next to an active one. Those are the only places a stale candidate can exist, so the worker
 * cleanup scopes its per-project supersession scan to them.
 */
export const getReviewServingProjectsWithMultipleQueuedSnapshots = async (
  input: {limit: number},
  database: ReviewServingManifestReaderDatabase = getAppDatabaseService(),
): Promise<ReviewServingQueuedSnapshotProjectRow[]> => {
  const limit = Math.max(1, Math.trunc(input.limit))
  const rows = await database.queryJson<QueuedSnapshotProjectRow>(`
    SELECT
      project_id AS projectId,
      review_config_hash AS reviewConfigHash,
      CAST(COUNT(DISTINCT snapshot_id) AS INTEGER) AS queuedSnapshotCount,
      CAST(COUNT(DISTINCT snapshot_id) FILTER (WHERE snapshot_status = 'active') AS INTEGER) AS activeSnapshotCount
    FROM app.review_serving_snapshot_manifest
    WHERE snapshot_status IN ('candidate', 'active')
    GROUP BY project_id, review_config_hash
    HAVING COUNT(DISTINCT snapshot_id) > 1
      AND COUNT(DISTINCT snapshot_id) FILTER (WHERE snapshot_status = 'active') > 0
    ORDER BY MIN(updated_at) ASC NULLS FIRST, project_id ASC, review_config_hash ASC NULLS FIRST
    LIMIT ${getSqlLiteral(limit)}
  `)

  return rows.map((row) => {
    return {
      activeSnapshotCount: Number(row.activeSnapshotCount ?? 0),
      projectId: row.projectId,
      queuedSnapshotCount: Number(row.queuedSnapshotCount ?? 0),
      reviewConfigHash: row.reviewConfigHash ?? null,
    }
  })
}

export type CleanupStaleCandidateReviewServingSnapshotManifestsParams = {
  maxProjects?: number
  maxSnapshots?: number
  source: string
}

export type CleanupStaleCandidateReviewServingSnapshotManifestsResult = {
  failedSnapshots: Array<{projectId: string; referenceSnapshotId: string | null; snapshotId: string}>
  projectIds: string[]
  remainingStaleCandidateCount: number
  skippedSnapshotCount: number
}

export const defaultStaleCandidateCleanupProjectLimit = 10
export const defaultStaleCandidateCleanupSnapshotLimit = 25

const getUniqueProjectIds = (rows: readonly ReviewServingQueuedSnapshotProjectRow[]) => {
  return [
    ...new Set(
      rows.map((row) => {
        return row.projectId
      }),
    ),
  ]
}

const getBoundedCleanupLimit = (value: number | undefined, fallback: number) => {
  return value === undefined || !Number.isFinite(value) || value < 1 ? fallback : Math.trunc(value)
}

/**
 * Bounded, automatic variant of `failStaleCandidateReviewServingSnapshotManifests` for the
 * projector worker cleanup cycle: only projects with more than one queued snapshot for the same
 * review config hash are scanned, at most `maxProjects` projects and `maxSnapshots` candidates
 * are touched per call, and each project is applied in its own transaction. The same safety rules
 * apply: the active snapshot and candidates referenced by pending/running chunks or non-terminal
 * requests are never touched.
 */
export const cleanupStaleCandidateReviewServingSnapshotManifests = async (
  params: CleanupStaleCandidateReviewServingSnapshotManifestsParams,
  database: ReviewServingManifestRepositoryDatabase = getAppDatabaseService(),
): Promise<CleanupStaleCandidateReviewServingSnapshotManifestsResult> => {
  const maxProjects = getBoundedCleanupLimit(params.maxProjects, defaultStaleCandidateCleanupProjectLimit)
  const maxSnapshots = getBoundedCleanupLimit(params.maxSnapshots, defaultStaleCandidateCleanupSnapshotLimit)
  const projectRows = await getReviewServingProjectsWithMultipleQueuedSnapshots({limit: maxProjects}, database)
  const projectIds = getUniqueProjectIds(projectRows)

  return projectIds.reduce<Promise<CleanupStaleCandidateReviewServingSnapshotManifestsResult>>(
    async (previous, projectId) => {
      const result = await previous
      const remainingSnapshotBudget = maxSnapshots - result.failedSnapshots.length

      if (remainingSnapshotBudget <= 0) {
        return result
      }

      const applied = await database.transaction((tx) => {
        return failStaleCandidateReviewServingSnapshotManifests(
          {apply: true, limit: remainingSnapshotBudget, projectId, source: params.source},
          tx,
        )
      })
      const failedSnapshots = applied.failedSnapshotIds.map((snapshotId) => {
        const referenceSnapshotId =
          applied.staleCandidates.find((row) => {
            return row.snapshotId === snapshotId
          })?.referenceSnapshotId ?? null

        return {projectId, referenceSnapshotId, snapshotId}
      })

      return {
        failedSnapshots: [...result.failedSnapshots, ...failedSnapshots],
        projectIds: result.projectIds,
        remainingStaleCandidateCount:
          result.remainingStaleCandidateCount + applied.staleCandidates.length - applied.failedSnapshotIds.length,
        skippedSnapshotCount: result.skippedSnapshotCount + applied.skipped.length,
      }
    },
    Promise.resolve({failedSnapshots: [], projectIds, remainingStaleCandidateCount: 0, skippedSnapshotCount: 0}),
  )
}

export const getActiveReviewServingSnapshotManifest = async (
  input: {
    componentStateMode?: ReviewServingSnapshotComponentStateMode
    projectId: string
    reviewConfigHash?: string | null
    workloadContext?: DuckdbWorkloadContext
  },
  database: ReviewServingManifestReaderDatabase = getAppDatabaseService(),
) => {
  const rows = await database.queryJson<SnapshotManifestRow>(
    `
    ${getSnapshotManifestSelect()}
    WHERE project_id = ${getSqlLiteral(input.projectId)}
      AND ${getReviewConfigPredicate(input.reviewConfigHash)}
      AND snapshot_status = 'active'
    ORDER BY activated_at DESC NULLS LAST, updated_at DESC
    LIMIT 1
  `,
    input.workloadContext,
  )

  return rows[0] === undefined ? null : getSnapshotManifestForMode(rows[0], database, input)
}

export const getActiveOrLastKnownGoodReviewServingSnapshotManifest = async (
  input: {
    componentStateMode?: ReviewServingSnapshotComponentStateMode
    projectId: string
    reviewConfigHash?: string | null
    workloadContext?: DuckdbWorkloadContext
  },
  database: ReviewServingManifestReaderDatabase = getAppDatabaseService(),
) => {
  const rows = await database.queryJson<SnapshotManifestRow>(
    `
    ${getSnapshotManifestSelect()}
    WHERE project_id = ${getSqlLiteral(input.projectId)}
      AND ${getReviewConfigPredicate(input.reviewConfigHash)}
      AND snapshot_status IN ('active', 'retired')
    ORDER BY
      CASE WHEN snapshot_status = 'active' THEN 0 ELSE 1 END,
      activated_at DESC NULLS LAST,
      updated_at DESC
    LIMIT 1
  `,
    input.workloadContext,
  )

  return rows[0] === undefined ? null : getSnapshotManifestForMode(rows[0], database, input)
}

export const getReviewServingSnapshotManifest = async (
  input: {
    componentStateMode?: ReviewServingSnapshotComponentStateMode
    projectId: string
    snapshotId: string
    workloadContext?: DuckdbWorkloadContext
  },
  database: ReviewServingManifestReaderDatabase = getAppDatabaseService(),
) => {
  const rows = await database.queryJson<SnapshotManifestRow>(
    `
    ${getSnapshotManifestSelect()}
    WHERE project_id = ${getSqlLiteral(input.projectId)}
      AND snapshot_id = ${getSqlLiteral(input.snapshotId)}
    LIMIT 1
  `,
    input.workloadContext,
  )

  return rows[0] === undefined ? null : getSnapshotManifestForMode(rows[0], database, input)
}

export const getLastKnownGoodReviewServingSnapshotManifest = async (
  input: {
    componentStateMode?: ReviewServingSnapshotComponentStateMode
    projectId: string
    reviewConfigHash?: string | null
    workloadContext?: DuckdbWorkloadContext
  },
  database: ReviewServingManifestReaderDatabase = getAppDatabaseService(),
) => {
  const active = await getActiveReviewServingSnapshotManifest({...input, componentStateMode: 'raw'}, database)
  const snapshotId = active?.lastKnownGoodSnapshotId ?? active?.snapshotId ?? null
  const rows =
    snapshotId === null
      ? await database.queryJson<SnapshotManifestRow>(
          `
          ${getSnapshotManifestSelect()}
          WHERE project_id = ${getSqlLiteral(input.projectId)}
            AND ${getReviewConfigPredicate(input.reviewConfigHash)}
            AND snapshot_status = 'retired'
          ORDER BY activated_at DESC NULLS LAST, updated_at DESC
          LIMIT 1
        `,
          input.workloadContext,
        )
      : await database.queryJson<SnapshotManifestRow>(
          `
          ${getSnapshotManifestSelect()}
          WHERE project_id = ${getSqlLiteral(input.projectId)}
            AND snapshot_id = ${getSqlLiteral(snapshotId)}
          LIMIT 1
        `,
          input.workloadContext,
        )

  return rows[0] === undefined ? null : getSnapshotManifestForMode(rows[0], database, input)
}

export const retireObsoleteReviewServingSnapshotManifests = async (
  input: {keepSnapshotIds: readonly string[]; projectId: string; reviewConfigHash?: string | null},
  database: ReviewServingManifestRepositoryTransaction = getAppDatabaseService(),
) => {
  const keepPredicate =
    input.keepSnapshotIds.length === 0
      ? ''
      : `AND snapshot_id NOT IN (${input.keepSnapshotIds.map(getSqlLiteral).join(', ')})`

  await database.run(`
    UPDATE app.review_serving_snapshot_manifest
    SET
      snapshot_status = 'retired',
      updated_at = current_timestamp
    WHERE project_id = ${getSqlLiteral(input.projectId)}
      AND ${getReviewConfigPredicate(input.reviewConfigHash)}
      AND snapshot_status <> 'active'
      ${keepPredicate}
  `)
}
