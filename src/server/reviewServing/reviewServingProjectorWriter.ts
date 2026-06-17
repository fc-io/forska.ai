import {createHash} from 'node:crypto'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {getStableReviewServingJson, type ReviewServingIdentityValue} from './reviewProjectionIdentity.ts'
import {type ReviewServingProjectionComponent} from './reviewServingContracts.ts'
import {
  advanceReviewServingProjectorWatermark,
  assertReviewServingProjectorWatermarkCanAdvance,
  type ReviewServingProjectorWatermarkAdvanceInput,
} from './reviewServingDeltaReconciliation.ts'
import {
  completeReviewServingDirtyWorkClaims,
  type ReviewServingDirtyWorkClaim,
  type ReviewServingDirtyWorkInput,
  upsertReviewServingDirtyWork,
} from './reviewServingDirtyWorkService.ts'
import {
  getActiveReviewServingSnapshotManifest,
  getReviewServingSnapshotManifest,
  markCandidateReviewServingSnapshotManifestFailed,
  type ReviewServingProjectionIdentityManifestInput,
  type ReviewServingSnapshotManifestInput,
  upsertReviewServingProjectionIdentityManifest,
} from './reviewServingManifestRepository.ts'
import {compactReviewServingCandidateSnapshotPatches} from './reviewServingRetentionService.ts'
import {validateReviewServingCandidateSnapshotManifest} from './reviewServingSnapshotPromotionService.ts'

export type ReviewServingProjectorWriterDatabase = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
  transaction: <T>(operation: (tx: ReviewServingProjectorWriterTransaction) => Promise<T>) => Promise<T>
}

export type ReviewServingProjectorWriterTransaction = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

export type ReviewServingProjectorWritableTable =
  | 'app.review_selected_article_import_v4'
  | 'mart.review_article_filter_posting_patch_v4'
  | 'mart.review_article_display_patch_v4'
  | 'mart.review_human_status_patch_v4'
  | 'mart.review_llm_status_patch_v4'
  | 'mart.review_queue_patch_v4'
  | 'mart.review_selected_import_patch_v4'
  | 'mart.review_article_count_serving_v4'
  | 'mart.review_article_filter_posting_serving_v4'
  | 'mart.review_article_judgment_detail_serving_v4'
  | 'mart.review_article_serving_payload_v4'
  | 'mart.review_article_serving_v4'
  | 'mart.review_article_summary_contribution_v4'
  | 'mart.review_filter_facet_serving_v4'
  | 'mart.review_filter_option_serving_v4'
  | 'mart.review_filter_posting_stats_v4'
  | 'mart.review_title_search_serving_v4'
  | 'mart.review_unassessed_queue_serving_v4'

export type ReviewServingProjectorRecordValue = Date | ReviewServingIdentityValue | readonly string[] | null

export type ReviewServingProjectorRecord = {
  keyColumns: readonly string[]
  table: ReviewServingProjectorWritableTable
  values: Record<string, ReviewServingProjectorRecordValue>
}

export type DeleteReviewServingProjectorRowsInput = {
  predicates: Record<string, ReviewServingProjectorRecordValue | readonly string[]>
  table: ReviewServingProjectorWritableTable
}

export type PromoteReviewServingProjectorSnapshotInput = {
  projectId: string
  reviewConfigHash?: string | null
  snapshotId: string
}

export type PromoteReviewServingProjectorSnapshotResult =
  | {error: string; promoted: false; snapshotId: string}
  | {promoted: true; snapshotId: string}

export type ReviewServingSelectedImportSnapshotCursorInput = {
  cursorJson: ReviewServingIdentityValue | null
  projectId: string
  projectScopeIdentity: string
  selectedImportSnapshotId: string
  sourceDeltaHighWater: number
  status: 'candidate' | 'completed'
}

export type WriteReviewServingProjectorComponentInput = {
  acknowledgements?: readonly ReviewServingDirtyWorkClaim[]
  candidateSnapshot?: ReviewServingSnapshotManifestInput
  component: ReviewServingProjectionComponent
  projectionManifests?: readonly ReviewServingProjectionIdentityManifestInput[]
  records?: readonly ReviewServingProjectorRecord[]
  repairDirtyWork?: readonly ReviewServingDirtyWorkInput[]
  selectedImportSnapshotCursor?: ReviewServingSelectedImportSnapshotCursorInput
  snapshotPromotion?: PromoteReviewServingProjectorSnapshotInput
  statements?: readonly string[]
  watermark?: ReviewServingProjectorWatermarkAdvanceInput
}

const getReviewServingProjectorHash = (label: string, value: ReviewServingIdentityValue) => {
  return createHash('sha256')
    .update(`${label}:${getStableReviewServingJson(value)}`)
    .digest('hex')
}

const getSqlRecordValue = (value: ReviewServingProjectorRecordValue) => {
  if (value instanceof Date) {
    return getSqlLiteral(value.toISOString())
  }

  return Array.isArray(value) ? getSqlLiteral(value) : getSqlLiteral(value)
}

const getReviewServingJsonLiteral = (value: ReviewServingIdentityValue) => {
  return `${getSqlLiteral(getStableReviewServingJson(value))}::JSON`
}

const getReviewServingNullableJsonLiteral = (value: ReviewServingIdentityValue | null | undefined) => {
  return value === null || value === undefined ? 'NULL' : getReviewServingJsonLiteral(value)
}

const getReviewServingDeletePredicate = (
  column: string,
  value: ReviewServingProjectorRecordValue | readonly string[],
) => {
  return Array.isArray(value)
    ? `${column} IN (${value
        .map((entry) => {
          return getSqlLiteral(entry)
        })
        .join(', ')})`
    : `${column} IS NOT DISTINCT FROM ${getSqlRecordValue(value)}`
}

export const getDeleteReviewServingProjectorRowsStatement = (input: DeleteReviewServingProjectorRowsInput) => {
  const predicates = Object.entries(input.predicates).map(([column, value]) => {
    return getReviewServingDeletePredicate(column, value)
  })

  return `DELETE FROM ${input.table} WHERE ${predicates.join(' AND ')}`
}

export const getReviewServingProjectorReplayKey = (input: {
  articleId?: string | null
  baseGeneration: number
  contributionKey?: string | null
  filterKey?: string | null
  patchWatermark: number
  projectionIdentity: string
  promptId?: string | null
  snapshotId: string
}) => {
  return `projectorReplay:${getReviewServingProjectorHash('review-serving-projector-replay', {
    articleId: input.articleId ?? null,
    baseGeneration: input.baseGeneration,
    contributionKey: input.contributionKey ?? null,
    filterKey: input.filterKey ?? null,
    patchWatermark: input.patchWatermark,
    projectionIdentity: input.projectionIdentity,
    promptId: input.promptId ?? null,
    snapshotId: input.snapshotId,
  }).slice(0, 32)}`
}

const writeReviewServingProjectorRecord = async (
  record: ReviewServingProjectorRecord,
  tx: ReviewServingProjectorWriterTransaction,
) => {
  const columns = Object.keys(record.values)
  const assignments = columns
    .filter((column) => {
      return !record.keyColumns.includes(column)
    })
    .map((column) => {
      return `${column} = excluded.${column}`
    })
  const conflictUpdate = assignments.length === 0 ? 'DO NOTHING' : `DO UPDATE SET ${assignments.join(', ')}`

  await tx.run(`
    INSERT INTO ${record.table} (
      ${columns.join(',\n      ')}
    ) VALUES (
      ${columns
        .map((column) => {
          return getSqlRecordValue(record.values[column] ?? null)
        })
        .join(',\n      ')}
    )
    ON CONFLICT(${record.keyColumns.join(', ')}) ${conflictUpdate}
  `)
}

const createCandidateReviewServingSnapshotManifestFromWriter = async (
  input: ReviewServingSnapshotManifestInput,
  tx: ReviewServingProjectorWriterTransaction,
) => {
  await tx.run(`
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
}

const writeReviewServingSelectedImportSnapshotCursor = async (
  input: ReviewServingSelectedImportSnapshotCursorInput,
  tx: ReviewServingProjectorWriterTransaction,
) => {
  await tx.run(`
    INSERT INTO app.review_selected_import_snapshot (
      selected_import_snapshot_id,
      project_id,
      project_scope_identity,
      source_delta_high_water,
      cursor_json,
      status,
      started_at,
      completed_at,
      updated_at
    ) VALUES (
      ${getSqlLiteral(input.selectedImportSnapshotId)},
      ${getSqlLiteral(input.projectId)},
      ${getSqlLiteral(input.projectScopeIdentity)},
      ${getSqlLiteral(input.sourceDeltaHighWater)},
      ${getReviewServingNullableJsonLiteral(input.cursorJson)},
      ${getSqlLiteral(input.status)},
      current_timestamp,
      ${input.status === 'completed' ? 'current_timestamp' : 'NULL'},
      current_timestamp
    )
    ON CONFLICT(selected_import_snapshot_id) DO UPDATE SET
      project_id = excluded.project_id,
      project_scope_identity = excluded.project_scope_identity,
      source_delta_high_water = excluded.source_delta_high_water,
      cursor_json = excluded.cursor_json,
      status = excluded.status,
      completed_at = excluded.completed_at,
      last_error = NULL,
      updated_at = current_timestamp
  `)
}

export const promoteReviewServingProjectorSnapshot = async (
  input: PromoteReviewServingProjectorSnapshotInput,
  database: ReviewServingProjectorWriterDatabase = getAppDatabaseService(),
): Promise<PromoteReviewServingProjectorSnapshotResult> => {
  return database.transaction(async (tx) => {
    const candidate = await getReviewServingSnapshotManifest(
      {projectId: input.projectId, snapshotId: input.snapshotId},
      tx,
    )

    if (candidate === null || candidate.status !== 'candidate') {
      return {error: 'candidate snapshot manifest is missing', promoted: false, snapshotId: input.snapshotId}
    }

    const validation = await validateReviewServingCandidateSnapshotManifest(candidate, tx)

    await tx.run(`
      UPDATE app.review_serving_snapshot_manifest
      SET
        validation_result_json = ${getReviewServingJsonLiteral(validation.validationResult)},
        updated_at = current_timestamp
      WHERE project_id = ${getSqlLiteral(input.projectId)}
        AND snapshot_id = ${getSqlLiteral(input.snapshotId)}
        AND snapshot_status = 'candidate'
    `)

    if (!validation.ok) {
      await markCandidateReviewServingSnapshotManifestFailed(
        {lastError: validation.error, projectId: input.projectId, snapshotId: input.snapshotId},
        tx,
      )

      return {error: validation.error, promoted: false, snapshotId: input.snapshotId}
    }

    await compactReviewServingCandidateSnapshotPatches(
      {candidate},
      {
        queryJson: tx.queryJson,
        run: tx.run,
        transaction: async (operation) => {
          return operation(tx)
        },
      },
    )

    const active = await getActiveReviewServingSnapshotManifest(
      {projectId: input.projectId, reviewConfigHash: input.reviewConfigHash ?? null},
      tx,
    )
    const lastKnownGoodSnapshotId = active?.snapshotId ?? active?.lastKnownGoodSnapshotId ?? null

    await tx.run(`
      UPDATE app.review_serving_snapshot_manifest
      SET
        snapshot_status = 'retired',
        updated_at = current_timestamp
      WHERE project_id = ${getSqlLiteral(input.projectId)}
        AND review_config_hash IS NOT DISTINCT FROM ${getSqlLiteral(input.reviewConfigHash ?? null)}
        AND snapshot_status = 'active'
        AND snapshot_id <> ${getSqlLiteral(input.snapshotId)}
    `)
    await tx.run(`
      UPDATE app.review_serving_snapshot_manifest
      SET
        snapshot_status = 'active',
        last_known_good_snapshot_id = ${getSqlLiteral(lastKnownGoodSnapshotId)},
        activated_at = current_timestamp,
        failed_at = NULL,
        last_error = NULL,
        updated_at = current_timestamp
      WHERE project_id = ${getSqlLiteral(input.projectId)}
        AND snapshot_id = ${getSqlLiteral(input.snapshotId)}
        AND snapshot_status = 'candidate'
    `)

    return {promoted: true, snapshotId: input.snapshotId}
  })
}

export const writeReviewServingProjectorComponent = async (
  input: WriteReviewServingProjectorComponentInput,
  database: ReviewServingProjectorWriterDatabase = getAppDatabaseService(),
) => {
  return database.transaction(async (tx) => {
    if (input.watermark !== undefined) {
      await assertReviewServingProjectorWatermarkCanAdvance(tx, input.watermark)
    }

    if (input.candidateSnapshot !== undefined) {
      await createCandidateReviewServingSnapshotManifestFromWriter(input.candidateSnapshot, tx)
    }

    await (input.projectionManifests ?? []).reduce<Promise<void>>((previous, manifest) => {
      return previous.then(async () => {
        await upsertReviewServingProjectionIdentityManifest(manifest, tx)
      })
    }, Promise.resolve())

    await (input.statements ?? []).reduce<Promise<void>>((previous, statement) => {
      return previous.then(async () => {
        await tx.run(statement)
      })
    }, Promise.resolve())

    await (input.records ?? []).reduce<Promise<void>>((previous, record) => {
      return previous.then(async () => {
        await writeReviewServingProjectorRecord(record, tx)
      })
    }, Promise.resolve())

    if (input.selectedImportSnapshotCursor !== undefined) {
      await writeReviewServingSelectedImportSnapshotCursor(input.selectedImportSnapshotCursor, tx)
    }

    if (input.acknowledgements !== undefined) {
      await completeReviewServingDirtyWorkClaims(input.acknowledgements, tx)
    }

    await (input.repairDirtyWork ?? []).reduce<Promise<void>>((previous, dirtyWork) => {
      return previous.then(async () => {
        await upsertReviewServingDirtyWork(dirtyWork, tx)
      })
    }, Promise.resolve())

    if (input.watermark !== undefined) {
      await advanceReviewServingProjectorWatermark(tx, input.watermark)
    }

    if (input.snapshotPromotion !== undefined) {
      await promoteReviewServingProjectorSnapshot(input.snapshotPromotion, {
        queryJson: tx.queryJson,
        run: tx.run,
        transaction: async (operation) => {
          return operation(tx)
        },
      })
    }

    return {component: input.component, promotedSnapshotId: input.snapshotPromotion?.snapshotId ?? null}
  })
}
