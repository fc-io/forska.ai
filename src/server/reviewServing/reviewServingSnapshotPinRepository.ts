import {createHash} from 'node:crypto'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getJsonValue, getSqlLiteral} from '../services/appQueryHelpers.ts'
import {getStableReviewServingJson, type ReviewServingIdentityValue} from './reviewProjectionIdentity.ts'
import type {ReviewServingSnapshotPinId} from './reviewServingContracts.ts'

export type ReviewServingSnapshotPinRepositoryTransaction = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

export type ReviewServingSnapshotPinRepositoryDatabase = ReviewServingSnapshotPinRepositoryTransaction & {
  transaction: <T>(operation: (tx: ReviewServingSnapshotPinRepositoryTransaction) => Promise<T>) => Promise<T>
}

export type ReviewServingSnapshotPinOwner = {ownerId: string; ownerKind: string}

export type ReviewServingSnapshotPinIdentity = ReviewServingSnapshotPinOwner & {
  composedIdentity: ReviewServingIdentityValue
  projectId: string
  snapshotId: string
}

export type ReviewServingSnapshotPin = ReviewServingSnapshotPinIdentity & {
  createdAt: string
  expiresAt: string
  pinId: ReviewServingSnapshotPinId
  refCount: number
  releasedAt: string | null
  updatedAt: string
}

export type ReviewServingProtectedSnapshotState = {
  componentState: ReviewServingIdentityValue | null
  composedIdentity: ReviewServingIdentityValue
  protectedBy: 'activeManifest' | 'lastKnownGoodManifest' | 'pin'
  projectId: string
  selectedImportSnapshotId: string | null
  snapshotId: string
}

type ReviewServingSnapshotPinRow = {
  composedIdentityJson: unknown
  createdAt: string
  expiresAt: string
  ownerId: string
  ownerKind: string
  pinId: string
  projectId: string
  refCount: number
  releasedAt: string | null
  snapshotId: string
  updatedAt: string
}

type ProtectedSnapshotStateRow = {
  componentStateJson: unknown
  composedIdentityJson: unknown
  protectedBy: ReviewServingProtectedSnapshotState['protectedBy']
  projectId: string
  selectedImportSnapshotId: string | null
  snapshotId: string
}

const getReviewServingSnapshotPinDatabase = () => {
  return getAppDatabaseService() as ReviewServingSnapshotPinRepositoryDatabase
}

const getReviewServingSnapshotPinJsonLiteral = (value: ReviewServingIdentityValue) => {
  return `${getSqlLiteral(getStableReviewServingJson(value))}::JSON`
}

const getReviewServingSnapshotPinTimestampLiteral = (value: Date | string) => {
  return value instanceof Date ? getSqlLiteral(value) : `TIMESTAMPTZ ${getSqlLiteral(value)}`
}

export const getReviewServingSnapshotPinId = (input: ReviewServingSnapshotPinIdentity) => {
  return createHash('sha256')
    .update(
      getStableReviewServingJson({
        composedIdentity: input.composedIdentity,
        ownerId: input.ownerId,
        ownerKind: input.ownerKind,
        projectId: input.projectId,
        snapshotId: input.snapshotId,
      }),
    )
    .digest('hex')
}

const getReviewServingSnapshotPinFromRow = (row: ReviewServingSnapshotPinRow): ReviewServingSnapshotPin => {
  return {
    composedIdentity: getJsonValue(row.composedIdentityJson) as ReviewServingIdentityValue,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    ownerId: row.ownerId,
    ownerKind: row.ownerKind,
    pinId: row.pinId,
    projectId: row.projectId,
    refCount: Number(row.refCount),
    releasedAt: row.releasedAt,
    snapshotId: row.snapshotId,
    updatedAt: row.updatedAt,
  }
}

const getProtectedSnapshotStateFromRow = (row: ProtectedSnapshotStateRow): ReviewServingProtectedSnapshotState => {
  return {
    componentState: getJsonValue(row.componentStateJson) as ReviewServingIdentityValue | null,
    composedIdentity: getJsonValue(row.composedIdentityJson) as ReviewServingIdentityValue,
    projectId: row.projectId,
    protectedBy: row.protectedBy,
    selectedImportSnapshotId: row.selectedImportSnapshotId,
    snapshotId: row.snapshotId,
  }
}

const getReviewServingSnapshotPinSelect = () => {
  return `
    SELECT
      pin_id AS pinId,
      project_id AS projectId,
      snapshot_id AS snapshotId,
      composed_identity_json AS composedIdentityJson,
      owner_kind AS ownerKind,
      owner_id AS ownerId,
      ref_count AS refCount,
      expires_at AS expiresAt,
      released_at AS releasedAt,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM app.review_serving_snapshot_pin
  `
}

const getActivePinPredicate = (now: Date | string) => {
  return `released_at IS NULL AND ref_count > 0 AND expires_at > ${getReviewServingSnapshotPinTimestampLiteral(now)}`
}

export const getReviewServingSnapshotPin = async (
  input: {pinId: ReviewServingSnapshotPinId},
  database: ReviewServingSnapshotPinRepositoryTransaction = getReviewServingSnapshotPinDatabase(),
) => {
  const rows = await database.queryJson<ReviewServingSnapshotPinRow>(`
    ${getReviewServingSnapshotPinSelect()}
    WHERE pin_id = ${getSqlLiteral(input.pinId)}
    LIMIT 1
  `)

  return rows[0] === undefined ? null : getReviewServingSnapshotPinFromRow(rows[0])
}

export const acquireReviewServingSnapshotPin = async (
  input: ReviewServingSnapshotPinIdentity & {expiresAt: Date | string},
  database: ReviewServingSnapshotPinRepositoryDatabase = getReviewServingSnapshotPinDatabase(),
) => {
  const pinId = getReviewServingSnapshotPinId(input)

  return database.transaction(async (tx) => {
    await tx.run(`
      INSERT INTO app.review_serving_snapshot_pin (
        pin_id,
        project_id,
        snapshot_id,
        composed_identity_json,
        owner_kind,
        owner_id,
        ref_count,
        expires_at,
        released_at,
        updated_at
      ) VALUES (
        ${getSqlLiteral(pinId)},
        ${getSqlLiteral(input.projectId)},
        ${getSqlLiteral(input.snapshotId)},
        ${getReviewServingSnapshotPinJsonLiteral(input.composedIdentity)},
        ${getSqlLiteral(input.ownerKind)},
        ${getSqlLiteral(input.ownerId)},
        1,
        ${getReviewServingSnapshotPinTimestampLiteral(input.expiresAt)},
        NULL,
        current_timestamp
      )
      ON CONFLICT(pin_id) DO UPDATE SET
        ref_count = app.review_serving_snapshot_pin.ref_count + 1,
        expires_at = greatest(app.review_serving_snapshot_pin.expires_at, excluded.expires_at),
        released_at = NULL,
        updated_at = current_timestamp
    `)

    return getReviewServingSnapshotPin({pinId}, tx)
  })
}

export const incrementReviewServingSnapshotPin = async (
  input: {expiresAt?: Date | string; pinId: ReviewServingSnapshotPinId},
  database: ReviewServingSnapshotPinRepositoryTransaction = getReviewServingSnapshotPinDatabase(),
) => {
  const expiresAtSql = input.expiresAt
    ? `expires_at = greatest(expires_at, ${getReviewServingSnapshotPinTimestampLiteral(input.expiresAt)}),`
    : ''

  await database.run(`
    UPDATE app.review_serving_snapshot_pin
    SET
      ref_count = ref_count + 1,
      ${expiresAtSql}
      released_at = NULL,
      updated_at = current_timestamp
    WHERE pin_id = ${getSqlLiteral(input.pinId)}
  `)

  return getReviewServingSnapshotPin(input, database)
}

export const releaseReviewServingSnapshotPin = async (
  input: {pinId: ReviewServingSnapshotPinId},
  database: ReviewServingSnapshotPinRepositoryTransaction = getReviewServingSnapshotPinDatabase(),
) => {
  await database.run(`
    UPDATE app.review_serving_snapshot_pin
    SET
      ref_count = greatest(ref_count - 1, 0),
      released_at = CASE WHEN ref_count <= 1 THEN current_timestamp ELSE released_at END,
      updated_at = current_timestamp
    WHERE pin_id = ${getSqlLiteral(input.pinId)}
      AND released_at IS NULL
      AND ref_count > 0
  `)

  return getReviewServingSnapshotPin(input, database)
}

export const expireReviewServingSnapshotPins = async (
  input: {now: Date | string; projectId?: string},
  database: ReviewServingSnapshotPinRepositoryTransaction = getReviewServingSnapshotPinDatabase(),
) => {
  const projectPredicate = input.projectId ? `AND project_id = ${getSqlLiteral(input.projectId)}` : ''

  await database.run(`
    UPDATE app.review_serving_snapshot_pin
    SET
      ref_count = 0,
      released_at = COALESCE(released_at, current_timestamp),
      updated_at = current_timestamp
    WHERE expires_at <= ${getReviewServingSnapshotPinTimestampLiteral(input.now)}
      AND released_at IS NULL
      ${projectPredicate}
  `)
}

export const listActiveReviewServingSnapshotPins = async (
  input: {now: Date | string; owner?: ReviewServingSnapshotPinOwner; projectId?: string; snapshotId?: string},
  database: ReviewServingSnapshotPinRepositoryTransaction = getReviewServingSnapshotPinDatabase(),
) => {
  const projectPredicate = input.projectId ? `AND project_id = ${getSqlLiteral(input.projectId)}` : ''
  const snapshotPredicate = input.snapshotId ? `AND snapshot_id = ${getSqlLiteral(input.snapshotId)}` : ''
  const ownerPredicate = input.owner
    ? `AND owner_kind = ${getSqlLiteral(input.owner.ownerKind)} AND owner_id = ${getSqlLiteral(input.owner.ownerId)}`
    : ''
  const rows = await database.queryJson<ReviewServingSnapshotPinRow>(`
    ${getReviewServingSnapshotPinSelect()}
    WHERE ${getActivePinPredicate(input.now)}
      ${projectPredicate}
      ${snapshotPredicate}
      ${ownerPredicate}
    ORDER BY project_id, snapshot_id, owner_kind, owner_id, pin_id
  `)

  return rows.map(getReviewServingSnapshotPinFromRow)
}

export const listProtectedReviewServingSnapshotStates = async (
  input: {now: Date | string; projectId: string},
  database: ReviewServingSnapshotPinRepositoryTransaction = getReviewServingSnapshotPinDatabase(),
) => {
  const rows = await database.queryJson<ProtectedSnapshotStateRow>(`
    SELECT
      project_id AS projectId,
      snapshot_id AS snapshotId,
      composed_identity_json AS composedIdentityJson,
      component_state_json AS componentStateJson,
      selected_import_snapshot_id AS selectedImportSnapshotId,
      'activeManifest' AS protectedBy
    FROM app.review_serving_snapshot_manifest
    WHERE project_id = ${getSqlLiteral(input.projectId)}
      AND snapshot_status = 'active'
    UNION ALL
    SELECT
      lkg.project_id AS projectId,
      lkg.snapshot_id AS snapshotId,
      lkg.composed_identity_json AS composedIdentityJson,
      lkg.component_state_json AS componentStateJson,
      lkg.selected_import_snapshot_id AS selectedImportSnapshotId,
      'lastKnownGoodManifest' AS protectedBy
    FROM app.review_serving_snapshot_manifest active
    INNER JOIN app.review_serving_snapshot_manifest lkg
      ON lkg.project_id = active.project_id
      AND lkg.snapshot_id = active.last_known_good_snapshot_id
    WHERE active.project_id = ${getSqlLiteral(input.projectId)}
      AND active.snapshot_status = 'active'
      AND active.last_known_good_snapshot_id IS NOT NULL
    UNION ALL
    SELECT
      project_id AS projectId,
      snapshot_id AS snapshotId,
      composed_identity_json AS composedIdentityJson,
      NULL AS componentStateJson,
      NULL AS selectedImportSnapshotId,
      'pin' AS protectedBy
    FROM app.review_serving_snapshot_pin
    WHERE project_id = ${getSqlLiteral(input.projectId)}
      AND ${getActivePinPredicate(input.now)}
    ORDER BY projectId, snapshotId, protectedBy
  `)

  return rows.map(getProtectedSnapshotStateFromRow)
}

export const isReviewServingSnapshotStateCleanupEligible = async (
  input: {composedIdentity?: ReviewServingIdentityValue; now: Date | string; projectId: string; snapshotId: string},
  database: ReviewServingSnapshotPinRepositoryTransaction = getReviewServingSnapshotPinDatabase(),
) => {
  const composedIdentityPredicate = input.composedIdentity
    ? `AND CAST(composedIdentityJson AS VARCHAR) = CAST(${getReviewServingSnapshotPinJsonLiteral(input.composedIdentity)} AS VARCHAR)`
    : ''
  const protectedStates = await listProtectedReviewServingSnapshotStates(input, database)
  const protectedState = protectedStates.find((state) => {
    const sameSnapshot = state.projectId === input.projectId && state.snapshotId === input.snapshotId
    const sameIdentity = input.composedIdentity
      ? getStableReviewServingJson(state.composedIdentity) === getStableReviewServingJson(input.composedIdentity)
      : true

    return sameSnapshot && sameIdentity
  })

  if (protectedState) {
    return false
  }

  const rows = await database.queryJson<{blocked: boolean}>(`
    SELECT TRUE AS blocked
    FROM (
      SELECT project_id AS projectId, snapshot_id AS snapshotId, composed_identity_json AS composedIdentityJson
      FROM app.review_serving_snapshot_pin
      WHERE project_id = ${getSqlLiteral(input.projectId)}
        AND snapshot_id = ${getSqlLiteral(input.snapshotId)}
        AND ${getActivePinPredicate(input.now)}
    ) protected
    WHERE TRUE
      ${composedIdentityPredicate}
    LIMIT 1
  `)

  return rows.length === 0
}
