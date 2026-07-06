import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getJsonValue, getSqlLiteral} from '../services/appQueryHelpers.ts'

export type ReviewServingRetentionServiceTransaction = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

export type ReviewServingRetentionServiceDatabase = ReviewServingRetentionServiceTransaction & {
  transaction: <T>(operation: (tx: ReviewServingRetentionServiceTransaction) => Promise<T>) => Promise<T>
}

export type ReviewServingRetentionCleanupInput = {
  batchSize: number
  now: Date | string
  projectId: string
  reviewConfigHash?: string | null
}

export type ReviewServingRetentionCleanupResult = {retentionScope: string}

type RetentionStateRow = {
  baseGeneration: number | null
  cursorJson: unknown
  patchWatermark: number | null
  snapshotId: string | null
}

type CleanupTableSpec = {keyColumn: string; protectedPredicate: string; table: string}
type LegacyDrainTableSpec = {keyColumn: string; reviewConfigScoped?: boolean; table: string}

const defaultRetentionCleanupBatchSize = 512
const defaultRetentionCleanupTargetLimit = 16

const cleanupTableSpecs: readonly CleanupTableSpec[] = [
  {keyColumn: 'snapshot_id', protectedPredicate: 'snapshot_id', table: 'mart.review_article_serving_v4'},
  {keyColumn: 'snapshot_id', protectedPredicate: 'snapshot_id', table: 'mart.review_article_serving_payload_v4'},
  {keyColumn: 'snapshot_id', protectedPredicate: 'snapshot_id', table: 'mart.review_article_filter_posting_serving_v4'},
  {keyColumn: 'snapshot_id', protectedPredicate: 'snapshot_id', table: 'mart.review_filter_posting_stats_v4'},
  {
    keyColumn: 'snapshot_id',
    protectedPredicate: 'snapshot_id',
    table: 'mart.review_article_judgment_detail_serving_v4',
  },
  {keyColumn: 'snapshot_id', protectedPredicate: 'snapshot_id', table: 'mart.review_article_count_serving_v4'},
  {keyColumn: 'snapshot_id', protectedPredicate: 'snapshot_id', table: 'mart.review_filter_facet_serving_v4'},
  {keyColumn: 'snapshot_id', protectedPredicate: 'snapshot_id', table: 'mart.review_filter_option_serving_v4'},
  {keyColumn: 'snapshot_id', protectedPredicate: 'snapshot_id', table: 'mart.review_unassessed_queue_serving_v4'},
  {keyColumn: 'snapshot_id', protectedPredicate: 'snapshot_id', table: 'mart.review_title_search_serving_v4'},
  {
    keyColumn: 'selected_import_snapshot_id',
    protectedPredicate: 'selected_import_snapshot_id',
    table: 'app.review_selected_article_import_v4',
  },
]

const legacyDrainTableSpecs: readonly LegacyDrainTableSpec[] = [
  {keyColumn: 'patch_watermark', table: 'mart.review_article_display_patch_v4'},
  {keyColumn: 'patch_watermark', table: 'mart.review_selected_import_patch_v4'},
  {keyColumn: 'patch_watermark', reviewConfigScoped: true, table: 'mart.review_llm_status_patch_v4'},
  {keyColumn: 'patch_watermark', table: 'mart.review_human_status_patch_v4'},
  {keyColumn: 'patch_watermark', table: 'mart.review_queue_patch_v4'},
  {keyColumn: 'patch_watermark', table: 'mart.review_article_filter_posting_patch_v4'},
  {keyColumn: 'snapshot_id', reviewConfigScoped: true, table: 'mart.review_article_summary_contribution_v4'},
]

const retentionTableSpecCount = cleanupTableSpecs.length + legacyDrainTableSpecs.length

const getReviewServingRetentionDatabase = () => {
  return getAppDatabaseService() as ReviewServingRetentionServiceDatabase
}

const getTimestampLiteral = (value: Date | string) => {
  return value instanceof Date ? getSqlLiteral(value) : `TIMESTAMPTZ ${getSqlLiteral(value)}`
}

const getRetentionScope = (input: {projectId: string; reviewConfigHash?: string | null}) => {
  return `reviewServing:${input.projectId}:${input.reviewConfigHash ?? 'global'}`
}

const getActivePinPredicate = (now: Date | string) => {
  return `released_at IS NULL AND ref_count > 0 AND expires_at > ${getTimestampLiteral(now)}`
}

const writeRetentionMark = async (
  input: {
    baseGeneration: number
    cursor: unknown
    patchWatermark: number
    retentionScope: string
    snapshotId: string | null
  },
  database: ReviewServingRetentionServiceTransaction,
) => {
  await database.run(`
    INSERT INTO app.review_serving_retention_mark (
      retention_scope,
      cutoff_snapshot_id,
      cutoff_base_generation,
      cutoff_patch_watermark,
      cleanup_cursor_json,
      last_cleaned_at,
      updated_at
    ) VALUES (
      ${getSqlLiteral(input.retentionScope)},
      ${getSqlLiteral(input.snapshotId)},
      ${getSqlLiteral(input.baseGeneration)},
      ${getSqlLiteral(input.patchWatermark)},
      ${input.cursor === null ? 'NULL' : `${getSqlLiteral(JSON.stringify(input.cursor))}::JSON`},
      current_timestamp,
      current_timestamp
    )
    ON CONFLICT(retention_scope) DO UPDATE SET
      cutoff_snapshot_id = excluded.cutoff_snapshot_id,
      cutoff_base_generation = excluded.cutoff_base_generation,
      cutoff_patch_watermark = excluded.cutoff_patch_watermark,
      cleanup_cursor_json = excluded.cleanup_cursor_json,
      last_cleaned_at = excluded.last_cleaned_at,
      updated_at = excluded.updated_at
  `)
}

const getRetentionState = async (retentionScope: string, database: ReviewServingRetentionServiceTransaction) => {
  const rows = await database.queryJson<RetentionStateRow>(`
    SELECT
      cutoff_snapshot_id AS snapshotId,
      cutoff_base_generation AS baseGeneration,
      cutoff_patch_watermark AS patchWatermark,
      cleanup_cursor_json AS cursorJson
    FROM app.review_serving_retention_mark
    WHERE retention_scope = ${getSqlLiteral(retentionScope)}
    LIMIT 1
  `)

  return rows[0] ?? null
}

const getSelectedImportProtectedPredicate = (spec: CleanupTableSpec, now: Date | string) => {
  return spec.protectedPredicate !== 'selected_import_snapshot_id'
    ? 'FALSE'
    : `EXISTS (
        SELECT 1
        FROM app.review_serving_snapshot_manifest active_manifest
        LEFT JOIN app.review_serving_snapshot_manifest lkg_manifest
          ON lkg_manifest.project_id = active_manifest.project_id
          AND lkg_manifest.snapshot_id = active_manifest.last_known_good_snapshot_id
        WHERE active_manifest.project_id = candidate.project_id
          AND active_manifest.snapshot_status = 'active'
          AND lkg_manifest.selected_import_snapshot_id = candidate.selected_import_snapshot_id
      )
      OR EXISTS (
        SELECT 1
        FROM app.review_serving_snapshot_pin pin
        INNER JOIN app.review_serving_snapshot_manifest pinned_manifest
          ON pinned_manifest.project_id = pin.project_id
          AND pinned_manifest.snapshot_id = pin.snapshot_id
        WHERE pin.project_id = candidate.project_id
          AND pinned_manifest.selected_import_snapshot_id = candidate.selected_import_snapshot_id
          AND ${getActivePinPredicate(now)}
      )`
}

const getRetentionCursorIndex = (row: RetentionStateRow | null) => {
  const cursor = getJsonValue(row?.cursorJson ?? null) as {tableIndex?: number} | null

  return Math.max(0, Number(cursor?.tableIndex ?? 0))
}

const deleteCleanupBatch = async (
  input: ReviewServingRetentionCleanupInput & {spec: CleanupTableSpec},
  database: ReviewServingRetentionServiceTransaction,
) => {
  await database.run(`
    DELETE FROM ${input.spec.table}
    WHERE rowid IN (
        SELECT candidate.rowid
        FROM ${input.spec.table} candidate
        WHERE candidate.project_id = ${getSqlLiteral(input.projectId)}
          AND NOT EXISTS (
            SELECT 1
            FROM app.review_serving_snapshot_manifest active_manifest
            WHERE active_manifest.project_id = candidate.project_id
              AND active_manifest.snapshot_status = 'active'
              AND (
                active_manifest.snapshot_id = candidate.${input.spec.protectedPredicate}
                OR active_manifest.last_known_good_snapshot_id = candidate.${input.spec.protectedPredicate}
                OR active_manifest.selected_import_snapshot_id = candidate.${input.spec.protectedPredicate}
              )
          )
          AND NOT (${getSelectedImportProtectedPredicate(input.spec, input.now)})
          AND NOT EXISTS (
            SELECT 1
            FROM app.review_serving_snapshot_pin pin
            WHERE pin.project_id = candidate.project_id
              AND pin.snapshot_id = candidate.${input.spec.protectedPredicate}
              AND ${getActivePinPredicate(input.now)}
          )
        ORDER BY candidate.${input.spec.keyColumn}
        LIMIT ${getSqlLiteral(input.batchSize)}
      )
  `)
}

const deleteLegacyDrainBatch = async (
  input: ReviewServingRetentionCleanupInput & {spec: LegacyDrainTableSpec},
  database: ReviewServingRetentionServiceTransaction,
) => {
  const reviewConfigPredicate =
    input.spec.reviewConfigScoped === true && input.reviewConfigHash !== undefined && input.reviewConfigHash !== null
      ? `AND candidate.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}`
      : ''

  await database.run(`
    DELETE FROM ${input.spec.table}
    WHERE rowid IN (
        SELECT candidate.rowid
        FROM ${input.spec.table} candidate
        WHERE candidate.project_id = ${getSqlLiteral(input.projectId)}
          ${reviewConfigPredicate}
        ORDER BY candidate.${input.spec.keyColumn}
        LIMIT ${getSqlLiteral(input.batchSize)}
      )
  `)
}

export const cleanupReviewServingRetentionState = async (
  input: ReviewServingRetentionCleanupInput,
  database: ReviewServingRetentionServiceDatabase = getReviewServingRetentionDatabase(),
): Promise<ReviewServingRetentionCleanupResult> => {
  return database.transaction(async (tx) => {
    const retentionScope = getRetentionScope(input)
    const retentionState = await getRetentionState(retentionScope, tx)
    const tableIndex = getRetentionCursorIndex(retentionState)
    const boundedTableIndex = tableIndex % retentionTableSpecCount
    const spec = cleanupTableSpecs[boundedTableIndex]
    const legacySpec = legacyDrainTableSpecs[boundedTableIndex - cleanupTableSpecs.length]

    if (spec !== undefined) {
      await deleteCleanupBatch({...input, spec}, tx)
    }

    if (legacySpec !== undefined) {
      await deleteLegacyDrainBatch({...input, spec: legacySpec}, tx)
    }

    await writeRetentionMark(
      {
        baseGeneration: Number(retentionState?.baseGeneration ?? 0),
        cursor: {tableIndex: (boundedTableIndex + 1) % retentionTableSpecCount},
        patchWatermark: Number(retentionState?.patchWatermark ?? 0),
        retentionScope,
        snapshotId: retentionState?.snapshotId ?? null,
      },
      tx,
    )

    return {retentionScope}
  })
}

export const getReviewServingRetentionCleanupTargets = async (
  input: {cleanupBatchSize?: number; now?: Date | string; targetLimit?: number} = {},
  database: ReviewServingRetentionServiceTransaction = getReviewServingRetentionDatabase(),
): Promise<readonly ReviewServingRetentionCleanupInput[]> => {
  const cleanupBatchSize = Math.max(1, Math.floor(input.cleanupBatchSize ?? defaultRetentionCleanupBatchSize))
  const targetLimit = Math.max(1, Math.floor(input.targetLimit ?? defaultRetentionCleanupTargetLimit))
  const now = input.now ?? new Date()
  const rows = await database.queryJson<{projectId: string; reviewConfigHash: string | null}>(`
    SELECT
      project_id AS projectId,
      review_config_hash AS reviewConfigHash
    FROM app.review_serving_snapshot_manifest
    WHERE snapshot_status IN ('active', 'retired', 'failed')
    GROUP BY project_id, review_config_hash
    ORDER BY MAX(updated_at) ASC, project_id ASC, review_config_hash ASC NULLS FIRST
    LIMIT ${getSqlLiteral(targetLimit)}
  `)

  return rows.map((row) => {
    return {batchSize: cleanupBatchSize, now, projectId: row.projectId, reviewConfigHash: row.reviewConfigHash}
  })
}
