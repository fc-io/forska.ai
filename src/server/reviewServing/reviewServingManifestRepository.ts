import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getJsonValue, getSqlLiteral} from '../services/appQueryHelpers.ts'
import {getStableReviewServingJson, type ReviewServingIdentityValue} from './reviewProjectionIdentity.ts'
import {
  type ReviewServingComponentRequirements,
  type ReviewServingProjectionComponent,
  type ReviewServingSnapshotComponentStates,
  type ReviewServingSnapshotStatus,
} from './reviewServingContracts.ts'
import {
  getReviewServingProjectionComponentIdentityKey,
  type ReviewServingProjectionComponentIdentity,
} from './reviewServingProjectorDomain.ts'

export type ReviewServingManifestRepositoryDatabase = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
  transaction: <T>(operation: (tx: ReviewServingManifestRepositoryTransaction) => Promise<T>) => Promise<T>
}

export type ReviewServingManifestRepositoryTransaction = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

export type ReviewServingProjectionManifestStatus = ReviewServingSnapshotStatus

export type ReviewServingProjectionIdentityManifest = ReviewServingProjectionComponentIdentity & {
  baseGeneration: number
  definitionVersion: string
  inputDigest: string | null
  inputWatermark: number
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
      ${getSqlLiteral(input.baseGeneration)},
      ${getSqlLiteral(input.patchWatermark)},
      ${getSqlLiteral(input.patchRangeStart ?? null)},
      ${getSqlLiteral(input.patchRangeEnd ?? null)},
      ${getSqlLiteral(input.inputWatermark)},
      ${getSqlLiteral(input.inputDigest ?? null)},
      ${getSqlLiteral(input.definitionVersion)},
      ${getSqlLiteral(input.reviewConfigHash ?? null)},
      ${getSqlLiteral(input.promptConfigHash ?? null)},
      ${getSqlLiteral(input.status)},
      ${getSqlLiteral(input.invalidationReason ?? null)},
      current_timestamp
    )
    ON CONFLICT(manifest_id) DO UPDATE SET
      base_generation = excluded.base_generation,
      patch_watermark = excluded.patch_watermark,
      patch_range_start = excluded.patch_range_start,
      patch_range_end = excluded.patch_range_end,
      input_watermark = excluded.input_watermark,
      input_digest = excluded.input_digest,
      definition_version = excluded.definition_version,
      review_config_hash = excluded.review_config_hash,
      prompt_config_hash = excluded.prompt_config_hash,
      status = excluded.status,
      invalidation_reason = excluded.invalidation_reason,
      updated_at = current_timestamp
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
      input_digest AS inputDigest,
      definition_version AS definitionVersion,
      review_config_hash AS reviewConfigHash,
      prompt_config_hash AS promptConfigHash,
      status,
      invalidation_reason AS invalidationReason
    FROM app.review_projection_identity_manifest
    WHERE manifest_id = ${getSqlLiteral(getProjectionManifestId(identity))}
    LIMIT 1
  `)

  return rows[0] === undefined ? null : getProjectionManifestFromRow(rows[0])
}

export const createCandidateReviewServingSnapshotManifest = async (
  input: ReviewServingSnapshotManifestInput,
  database: ReviewServingManifestRepositoryTransaction = getAppDatabaseService(),
) => {
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
    ) VALUES (
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
    ON CONFLICT(project_id, snapshot_id) DO UPDATE SET
      snapshot_status = 'candidate',
      review_config_hash = excluded.review_config_hash,
      composed_identity_json = excluded.composed_identity_json,
      component_state_json = excluded.component_state_json,
      required_components_json = excluded.required_components_json,
      optional_components_json = excluded.optional_components_json,
      source_watermarks_json = excluded.source_watermarks_json,
      validation_result_json = excluded.validation_result_json,
      selected_import_snapshot_id = excluded.selected_import_snapshot_id,
      last_known_good_snapshot_id = excluded.last_known_good_snapshot_id,
      failed_at = NULL,
      last_error = NULL,
      updated_at = current_timestamp
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

export const getActiveReviewServingSnapshotManifest = async (
  input: {projectId: string; reviewConfigHash?: string | null},
  database: ReviewServingManifestRepositoryTransaction = getAppDatabaseService(),
) => {
  const rows = await database.queryJson<SnapshotManifestRow>(`
    ${getSnapshotManifestSelect()}
    WHERE project_id = ${getSqlLiteral(input.projectId)}
      AND ${getReviewConfigPredicate(input.reviewConfigHash)}
      AND snapshot_status = 'active'
    ORDER BY activated_at DESC NULLS LAST, updated_at DESC
    LIMIT 1
  `)

  return rows[0] === undefined ? null : getSnapshotManifestFromRow(rows[0])
}

export const getReviewServingSnapshotManifest = async (
  input: {projectId: string; snapshotId: string},
  database: ReviewServingManifestRepositoryTransaction = getAppDatabaseService(),
) => {
  const rows = await database.queryJson<SnapshotManifestRow>(`
    ${getSnapshotManifestSelect()}
    WHERE project_id = ${getSqlLiteral(input.projectId)}
      AND snapshot_id = ${getSqlLiteral(input.snapshotId)}
    LIMIT 1
  `)

  return rows[0] === undefined ? null : getSnapshotManifestFromRow(rows[0])
}

export const getLastKnownGoodReviewServingSnapshotManifest = async (
  input: {projectId: string; reviewConfigHash?: string | null},
  database: ReviewServingManifestRepositoryTransaction = getAppDatabaseService(),
) => {
  const active = await getActiveReviewServingSnapshotManifest(input, database)
  const snapshotId = active?.lastKnownGoodSnapshotId ?? active?.snapshotId ?? null
  const rows =
    snapshotId === null
      ? await database.queryJson<SnapshotManifestRow>(`
          ${getSnapshotManifestSelect()}
          WHERE project_id = ${getSqlLiteral(input.projectId)}
            AND ${getReviewConfigPredicate(input.reviewConfigHash)}
            AND snapshot_status = 'retired'
          ORDER BY activated_at DESC NULLS LAST, updated_at DESC
          LIMIT 1
        `)
      : await database.queryJson<SnapshotManifestRow>(`
          ${getSnapshotManifestSelect()}
          WHERE project_id = ${getSqlLiteral(input.projectId)}
            AND snapshot_id = ${getSqlLiteral(snapshotId)}
          LIMIT 1
        `)

  return rows[0] === undefined ? null : getSnapshotManifestFromRow(rows[0])
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
