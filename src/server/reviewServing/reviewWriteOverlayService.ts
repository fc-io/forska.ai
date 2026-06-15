import {createHash} from 'node:crypto'

import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {getStableReviewServingJson, type ReviewServingIdentityValue} from './reviewProjectionIdentity.ts'
import {type ReviewServingDeltaLedgerTransaction} from './reviewServingDeltaLedger.ts'
import {type ReviewServingReadSurface} from './reviewServingReadContracts.ts'

export const reviewWriteOverlayEligibleReadSurfaces = ['row', 'detail'] as const

export const reviewWriteOverlayReconcileStatuses = ['pending', 'reconciled', 'expired'] as const

export type ReviewWriteOverlayEligibleReadSurface = (typeof reviewWriteOverlayEligibleReadSurfaces)[number]

export type ReviewWriteOverlayReconcileStatus = (typeof reviewWriteOverlayReconcileStatuses)[number]

export type ReviewWriteOverlayKey = {
  articleId: string
  humanJudgmentKey?: string | null
  judgmentId?: string | null
  overlayKind: string
  projectId: string
  promptId?: string | null
  reviewConfigHash?: string | null
}

export type ReviewWriteOverlayAppendInput = ReviewWriteOverlayKey & {
  createdAt?: Date | string
  expiresAt?: Date | string
  overlayValueJson: ReviewServingIdentityValue
  readSurface: ReviewWriteOverlayEligibleReadSurface
  sourceHighWaterMark: number
  sourcePartition: string
  ttlMs?: number
}

export type ReviewWriteOverlayScope = {
  articleId: string
  projectId: string
  readSurface: ReviewWriteOverlayEligibleReadSurface
  reviewConfigHash?: string | null
}

export type ReviewWriteOverlayRow = ReviewWriteOverlayKey & {
  createdAt: string
  expiresAt: string
  overlayId: string
  overlayValueJson: unknown
  reconcileStatus: ReviewWriteOverlayReconcileStatus
  reconciledAt: string | null
  sourceHighWaterMark: number
  sourcePartition: string
}

export type ReviewWriteOverlayAppendResult = {overlayId: string; reconcileStatus: ReviewWriteOverlayReconcileStatus}

const maxOverlayValueJsonBytes = 4096

const getReviewWriteOverlayHash = (label: string, value: ReviewServingIdentityValue) => {
  return createHash('sha256')
    .update(`${label}:${getStableReviewServingJson(value)}`)
    .digest('hex')
}

const getReviewWriteOverlayTimestampLiteral = (value: Date | string) => {
  return `${getSqlLiteral(value)}::TIMESTAMPTZ`
}

const getReviewWriteOverlayJsonLiteral = (value: ReviewServingIdentityValue) => {
  return `${getSqlLiteral(value)}::JSON`
}

const getOverlayValueJsonByteLength = (value: ReviewServingIdentityValue) => {
  return Buffer.byteLength(getStableReviewServingJson(value), 'utf8')
}

const getDefaultExpiresAt = (createdAt: Date, ttlMs: number | undefined) => {
  return new Date(createdAt.getTime() + (ttlMs ?? 5 * 60 * 1000))
}

const getOverlayIdentityValue = (
  input: ReviewWriteOverlayKey & {sourceHighWaterMark: number; sourcePartition: string},
) => {
  return {
    articleId: input.articleId,
    humanJudgmentKey: input.humanJudgmentKey ?? null,
    judgmentId: input.judgmentId ?? null,
    overlayKind: input.overlayKind,
    projectId: input.projectId,
    promptId: input.promptId ?? null,
    reviewConfigHash: input.reviewConfigHash ?? null,
    sourceHighWaterMark: input.sourceHighWaterMark,
    sourcePartition: input.sourcePartition,
  }
}

const getReviewWriteOverlayId = (
  input: ReviewWriteOverlayKey & {sourceHighWaterMark: number; sourcePartition: string},
) => {
  return `review-overlay:${getReviewWriteOverlayHash('review-write-overlay-identity', getOverlayIdentityValue(input)).slice(0, 32)}`
}

const assertReviewWriteOverlayInput = (input: ReviewWriteOverlayAppendInput) => {
  if (!canApplyReviewWriteOverlayToReadSurface(input.readSurface)) {
    throw new Error(`review write overlays are not allowed on ${input.readSurface}`)
  }

  if (input.sourceHighWaterMark < 0) {
    throw new Error('review write overlay source high-water mark must be non-negative')
  }

  if (getOverlayValueJsonByteLength(input.overlayValueJson) > maxOverlayValueJsonBytes) {
    throw new Error(`review write overlay value must be ${maxOverlayValueJsonBytes} bytes or smaller`)
  }
}

export const canApplyReviewWriteOverlayToReadSurface = (surface: ReviewServingReadSurface) => {
  return reviewWriteOverlayEligibleReadSurfaces.some((eligibleSurface) => {
    return eligibleSurface === surface
  })
}

export const appendReviewWriteOverlay = async (
  tx: ReviewServingDeltaLedgerTransaction,
  input: ReviewWriteOverlayAppendInput,
): Promise<ReviewWriteOverlayAppendResult> => {
  assertReviewWriteOverlayInput(input)

  const now = input.createdAt ?? new Date()
  const createdAt = typeof now === 'string' ? new Date(now) : now
  const expiresAt = input.expiresAt ?? getDefaultExpiresAt(createdAt, input.ttlMs)
  const overlayId = getReviewWriteOverlayId(input)

  await tx.run(`
    INSERT INTO app.review_write_overlay (
      overlay_id,
      project_id,
      review_config_hash,
      article_id,
      prompt_id,
      judgment_id,
      human_judgment_key,
      overlay_kind,
      overlay_value_json,
      source_partition,
      source_high_water_mark,
      reconcile_status,
      created_at,
      expires_at,
      reconciled_at
    ) VALUES (
      ${getSqlLiteral(overlayId)},
      ${getSqlLiteral(input.projectId)},
      ${getSqlLiteral(input.reviewConfigHash ?? null)},
      ${getSqlLiteral(input.articleId)},
      ${getSqlLiteral(input.promptId ?? null)},
      ${getSqlLiteral(input.judgmentId ?? null)},
      ${getSqlLiteral(input.humanJudgmentKey ?? null)},
      ${getSqlLiteral(input.overlayKind)},
      ${getReviewWriteOverlayJsonLiteral(input.overlayValueJson)},
      ${getSqlLiteral(input.sourcePartition)},
      ${getSqlLiteral(input.sourceHighWaterMark)},
      'pending',
      ${getReviewWriteOverlayTimestampLiteral(createdAt)},
      ${getReviewWriteOverlayTimestampLiteral(expiresAt)},
      NULL
    )
    ON CONFLICT(overlay_id) DO UPDATE SET
      overlay_value_json = excluded.overlay_value_json,
      reconcile_status = 'pending',
      expires_at = excluded.expires_at,
      reconciled_at = NULL
  `)

  return {overlayId, reconcileStatus: 'pending'}
}

export const getActiveReviewWriteOverlays = async (
  tx: ReviewServingDeltaLedgerTransaction,
  scope: ReviewWriteOverlayScope & {now?: Date | string},
) => {
  const now = scope.now ?? new Date()

  return tx.queryJson<ReviewWriteOverlayRow>(`
    SELECT
      overlay_id AS overlayId,
      project_id AS projectId,
      review_config_hash AS reviewConfigHash,
      article_id AS articleId,
      prompt_id AS promptId,
      judgment_id AS judgmentId,
      human_judgment_key AS humanJudgmentKey,
      overlay_kind AS overlayKind,
      overlay_value_json AS overlayValueJson,
      source_partition AS sourcePartition,
      source_high_water_mark AS sourceHighWaterMark,
      reconcile_status AS reconcileStatus,
      created_at AS createdAt,
      expires_at AS expiresAt,
      reconciled_at AS reconciledAt
    FROM app.review_write_overlay
    WHERE project_id = ${getSqlLiteral(scope.projectId)}
      AND article_id = ${getSqlLiteral(scope.articleId)}
      AND reconcile_status = 'pending'
      AND expires_at > ${getReviewWriteOverlayTimestampLiteral(now)}
      AND ${scope.reviewConfigHash === null || scope.reviewConfigHash === undefined ? 'review_config_hash IS NULL' : `review_config_hash = ${getSqlLiteral(scope.reviewConfigHash)}`}
    ORDER BY created_at DESC, overlay_id ASC
  `)
}

export const reconcileReviewWriteOverlays = async (
  tx: ReviewServingDeltaLedgerTransaction,
  input: {completedHighWaterMark: number; now?: Date | string; sourcePartition: string},
) => {
  const now = input.now ?? new Date()

  await tx.run(`
    UPDATE app.review_write_overlay
    SET
      reconcile_status = 'reconciled',
      reconciled_at = ${getReviewWriteOverlayTimestampLiteral(now)}
    WHERE source_partition = ${getSqlLiteral(input.sourcePartition)}
      AND source_high_water_mark <= ${getSqlLiteral(input.completedHighWaterMark)}
      AND reconcile_status = 'pending'
      AND expires_at > ${getReviewWriteOverlayTimestampLiteral(now)}
  `)
}

export const expireReviewWriteOverlays = async (
  tx: ReviewServingDeltaLedgerTransaction,
  input: {now?: Date | string},
) => {
  const now = input.now ?? new Date()

  await tx.run(`
    UPDATE app.review_write_overlay
    SET reconcile_status = 'expired'
    WHERE reconcile_status = 'pending'
      AND expires_at <= ${getReviewWriteOverlayTimestampLiteral(now)}
  `)
}
