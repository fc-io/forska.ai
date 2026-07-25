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

export type ReviewServingRetentionCleanupSpecKind =
  | 'snapshot'
  | 'terminalRebuildChunkManifest'
  | 'terminalRebuildPartial'

export type ReviewServingRetentionCleanupResult = {
  cleanupBatchSize: number
  cleanupSpecKind: ReviewServingRetentionCleanupSpecKind
  cleanupTable: string
  cleanupTableIndex: number
  nextCleanupTableIndex: number
  retentionScope: string
}

type RetentionStateRow = {
  baseGeneration: number | null
  cursorJson: unknown
  patchWatermark: number | null
  snapshotId: string | null
}

type CleanupTableSpec = {
  kind?: ReviewServingRetentionCleanupSpecKind
  keyColumn: string
  orderBy?: string
  protectedPredicate: string
  table: string
}

type SummaryPartialRebuildSql = {createIndexSql: string; tempTableName: string; uniqueIndexSql: string}

const defaultRetentionCleanupBatchSize = 512
const defaultRetentionCleanupTargetLimit = 16

const cleanupTableSpecs: readonly CleanupTableSpec[] = [
  {keyColumn: 'snapshot_id', protectedPredicate: 'snapshot_id', table: 'mart.review_article_serving_v4'},
  {keyColumn: 'snapshot_id', protectedPredicate: 'snapshot_id', table: 'mart.review_article_serving_payload_v4'},
  {keyColumn: 'snapshot_id', protectedPredicate: 'snapshot_id', table: 'mart.review_article_filter_posting_serving_v4'},
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
  {
    kind: 'terminalRebuildPartial',
    keyColumn: 'request_id, chunk_id, snapshot_id',
    orderBy: 'candidate.request_id, candidate.chunk_id, candidate.snapshot_id',
    protectedPredicate: 'snapshot_id',
    table: 'mart.review_article_summary_contribution_rebuild_partial_v4',
  },
  {
    kind: 'terminalRebuildPartial',
    keyColumn: 'request_id, chunk_id, snapshot_id',
    orderBy: 'candidate.request_id, candidate.chunk_id, candidate.snapshot_id',
    protectedPredicate: 'snapshot_id',
    table: 'mart.review_article_summary_rebuild_partial_v4',
  },
  {
    kind: 'terminalRebuildChunkManifest',
    keyColumn: 'request_id, chunk_id',
    orderBy: 'candidate.request_id, candidate.chunk_id',
    protectedPredicate: 'snapshot_id',
    table: 'app.review_rebuild_chunk_manifest',
  },
]

const retentionTableSpecCount = cleanupTableSpecs.length

const summaryPartialRebuildSqlByTable: Record<string, SummaryPartialRebuildSql> = {
  'mart.review_article_summary_contribution_rebuild_partial_v4': {
    createIndexSql: `
      CREATE INDEX IF NOT EXISTS idx_review_article_summary_contribution_rebuild_partial_v4_publish
      ON mart.review_article_summary_contribution_rebuild_partial_v4(request_id, project_id, review_config_hash, snapshot_id)
    `,
    tempTableName: 'review_serving_contribution_partial_cleanup_rowids',
    uniqueIndexSql: `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_summary_contribution_rebuild_partial_v4_unique
      ON mart.review_article_summary_contribution_rebuild_partial_v4(
        request_id,
        chunk_id,
        project_id,
        review_config_hash,
        snapshot_id,
        article_id,
        component_kind,
        summary_definition_version,
        summary_kind,
        summary_identity,
        COALESCE(list_mode_key, 'global'),
        COALESCE(count_kind, ''),
        COALESCE(filter_key, ''),
        COALESCE(facet_kind, ''),
        COALESCE(facet_key, ''),
        COALESCE(facet_value, '')
      )
    `,
  },
  'mart.review_article_summary_rebuild_partial_v4': {
    createIndexSql: `
      CREATE INDEX IF NOT EXISTS idx_review_article_summary_rebuild_partial_v4_reduce
      ON mart.review_article_summary_rebuild_partial_v4(request_id, project_id, review_config_hash, snapshot_id, summary_kind)
    `,
    tempTableName: 'review_serving_summary_partial_cleanup_rowids',
    uniqueIndexSql: `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_summary_rebuild_partial_v4_unique
      ON mart.review_article_summary_rebuild_partial_v4(
        request_id,
        chunk_id,
        project_id,
        review_config_hash,
        snapshot_id,
        summary_kind,
        summary_identity,
        COALESCE(list_mode_key, 'global'),
        COALESCE(count_kind, ''),
        COALESCE(filter_key, ''),
        COALESCE(facet_kind, ''),
        COALESCE(facet_key, ''),
        COALESCE(facet_value, '')
      )
    `,
  },
}

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
    UPDATE app.review_serving_retention_mark
    SET
      cutoff_snapshot_id = ${getSqlLiteral(input.snapshotId)},
      cutoff_base_generation = ${getSqlLiteral(input.baseGeneration)},
      cutoff_patch_watermark = ${getSqlLiteral(input.patchWatermark)},
      cleanup_cursor_json = ${input.cursor === null ? 'NULL' : `${getSqlLiteral(JSON.stringify(input.cursor))}::JSON`},
      last_cleaned_at = current_timestamp,
      updated_at = current_timestamp
    WHERE (retention_scope || '') = (${getSqlLiteral(input.retentionScope)} || '');

    INSERT INTO app.review_serving_retention_mark (
      retention_scope,
      cutoff_snapshot_id,
      cutoff_base_generation,
      cutoff_patch_watermark,
      cleanup_cursor_json,
      last_cleaned_at,
      updated_at
    )
    SELECT
      ${getSqlLiteral(input.retentionScope)},
      ${getSqlLiteral(input.snapshotId)},
      ${getSqlLiteral(input.baseGeneration)},
      ${getSqlLiteral(input.patchWatermark)},
      ${input.cursor === null ? 'NULL' : `${getSqlLiteral(JSON.stringify(input.cursor))}::JSON`},
      current_timestamp,
      current_timestamp
    WHERE NOT EXISTS (
      SELECT 1
      FROM app.review_serving_retention_mark existing
      WHERE (existing.retention_scope || '') = (${getSqlLiteral(input.retentionScope)} || '')
    )
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

const getCleanupOrderBy = (spec: CleanupTableSpec) => {
  return spec.orderBy ?? `candidate.${spec.keyColumn}`
}

const getReviewConfigHashPredicate = (input: ReviewServingRetentionCleanupInput, source = 'candidate') => {
  return `${source}.review_config_hash IS NOT DISTINCT FROM ${getSqlLiteral(input.reviewConfigHash ?? null)}`
}

const getActiveSnapshotManifestGuardPredicate = (snapshotColumn: string) => {
  return `EXISTS (
            SELECT 1
            FROM app.review_serving_snapshot_manifest active_manifest
            WHERE active_manifest.project_id = candidate.project_id
              AND active_manifest.snapshot_status = 'active'
              AND (
                active_manifest.snapshot_id = candidate.${snapshotColumn}
                OR active_manifest.last_known_good_snapshot_id = candidate.${snapshotColumn}
                OR active_manifest.selected_import_snapshot_id = candidate.${snapshotColumn}
              )
          )`
}

const getActiveSnapshotPinGuardPredicate = (snapshotColumn: string, now: Date | string) => {
  return `EXISTS (
            SELECT 1
            FROM app.review_serving_snapshot_pin pin
            WHERE pin.project_id = candidate.project_id
              AND pin.snapshot_id = candidate.${snapshotColumn}
              AND ${getActivePinPredicate(now)}
          )`
}

const getProtectedRebuildRequestPredicate = (requestSource: string, now: Date | string) => {
  return `EXISTS (
            SELECT 1
            FROM app.review_rebuild_request protected_request
            WHERE protected_request.request_id = ${requestSource}.request_id
              AND protected_request.project_id = ${requestSource}.project_id
              AND (
                protected_request.status IN (
                  'pending_admission',
                  'admitted',
                  'running',
                  'blocked_over_budget',
                  'quarantined'
                )
                OR protected_request.admission_state IN ('pending', 'blocked_over_budget')
                OR (
                  protected_request.status = 'failed'
                  AND protected_request.admission_state = 'admitted'
                  AND (
                    protected_request.retry_after IS NULL
                    OR protected_request.retry_after <= ${getTimestampLiteral(now)}
                  )
                  AND EXISTS (
                    SELECT 1
                    FROM app.review_rebuild_chunk_manifest retryable_chunk
                    WHERE retryable_chunk.request_id = protected_request.request_id
                      AND retryable_chunk.status = 'failed'
                      AND COALESCE(retryable_chunk.retry_count, 0) < COALESCE(
                        GREATEST(
                          1,
                          TRY_CAST(json_extract_string(protected_request.retry_policy_json, '$.maxAttempts') AS INTEGER)
                        ),
                        3
                      )
                  )
                )
              )
          )`
}

const getNewestDiagnosticRebuildRequestPredicate = (requestSource: string) => {
  return `EXISTS (
            SELECT 1
            FROM app.review_rebuild_request diagnostic_request
            WHERE diagnostic_request.request_id = ${requestSource}.request_id
              AND diagnostic_request.project_id = ${requestSource}.project_id
              AND diagnostic_request.status IN ('failed', 'blocked_over_budget', 'quarantined')
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
          )`
}

const getTerminalRebuildChunkPredicate = (chunkSource: string) => {
  return `${chunkSource}.status = 'completed'
          AND ${chunkSource}.admission_state = 'admitted'`
}

const getAuthorizedRebuildPartialCleanupPredicate = (
  input: ReviewServingRetentionCleanupInput & {spec: CleanupTableSpec},
) => {
  return `EXISTS (
            SELECT 1
            FROM app.review_rebuild_partial_cleanup_authorization cleanup_authorization
            WHERE cleanup_authorization.project_id = candidate.project_id
              AND cleanup_authorization.review_config_hash = candidate.review_config_hash
              AND cleanup_authorization.request_id = candidate.request_id
              AND cleanup_authorization.chunk_id = candidate.chunk_id
              AND cleanup_authorization.snapshot_id = candidate.snapshot_id
              AND cleanup_authorization.partial_table = ${getSqlLiteral(input.spec.table)}
              AND cleanup_authorization.cleanup_mode = 'stale_orphan_summary_partial'
              AND cleanup_authorization.operator_ack = 'authorize-stale-orphan-review-serving-summary-partial-cleanup'
              AND cleanup_authorization.expires_at > ${getTimestampLiteral(input.now)}
              AND cleanup_authorization.expected_row_count = (
                SELECT CAST(COUNT(*) AS BIGINT)
                FROM ${input.spec.table} row_count_partial
                WHERE row_count_partial.project_id = candidate.project_id
                  AND row_count_partial.review_config_hash = candidate.review_config_hash
                  AND row_count_partial.request_id = candidate.request_id
                  AND row_count_partial.chunk_id = candidate.chunk_id
                  AND row_count_partial.snapshot_id = candidate.snapshot_id
              )
              AND NOT EXISTS (
                SELECT 1
                FROM app.review_rebuild_chunk_manifest matching_summary_chunk
                WHERE matching_summary_chunk.project_id = candidate.project_id
                  AND matching_summary_chunk.request_id = candidate.request_id
                  AND matching_summary_chunk.chunk_id = candidate.chunk_id
                  AND matching_summary_chunk.snapshot_id = candidate.snapshot_id
                  AND matching_summary_chunk.projection_component = 'summary'
              )
          )`
}

const getTerminalRebuildPartialCleanupCandidateSql = (
  input: ReviewServingRetentionCleanupInput & {spec: CleanupTableSpec},
) => {
  return `
    SELECT
      candidate.rowid AS cleanup_rowid,
      candidate.project_id,
      candidate.review_config_hash,
      candidate.request_id,
      candidate.chunk_id,
      candidate.snapshot_id
    FROM ${input.spec.table} candidate
    INNER JOIN app.review_rebuild_request request
      ON request.request_id = candidate.request_id
      AND request.project_id = candidate.project_id
    LEFT JOIN app.review_rebuild_chunk_manifest chunk
      ON chunk.request_id = candidate.request_id
      AND chunk.chunk_id = candidate.chunk_id
      AND chunk.project_id = candidate.project_id
      AND chunk.snapshot_id = candidate.snapshot_id
      AND chunk.projection_component = 'summary'
    WHERE candidate.project_id = ${getSqlLiteral(input.projectId)}
      AND ${getReviewConfigHashPredicate(input)}
      AND request.lease_owner IS NULL
      AND request.lease_expires_at IS NULL
      AND (chunk.request_id IS NULL OR (chunk.lease_owner IS NULL AND chunk.lease_expires_at IS NULL))
      AND (
        (
          request.status = 'completed'
          AND request.admission_state = 'admitted'
          AND ${getTerminalRebuildChunkPredicate('chunk')}
        )
        OR (${getAuthorizedRebuildPartialCleanupPredicate(input)})
      )
      AND NOT (${getActiveSnapshotManifestGuardPredicate(input.spec.protectedPredicate)})
      AND NOT (${getActiveSnapshotPinGuardPredicate(input.spec.protectedPredicate, input.now)})
      AND NOT (${getProtectedRebuildRequestPredicate('request', input.now)})
      AND NOT (${getNewestDiagnosticRebuildRequestPredicate('request')})
    ORDER BY ${getCleanupOrderBy(input.spec)}
    LIMIT ${getSqlLiteral(input.batchSize)}
  `
}

const markAppliedAuthorizedRebuildPartialCleanup = async (
  input: ReviewServingRetentionCleanupInput & {spec: CleanupTableSpec},
  rebuildSql: SummaryPartialRebuildSql,
  database: ReviewServingRetentionServiceTransaction,
) => {
  await database.run(`
    DROP TABLE IF EXISTS review_serving_partial_cleanup_authorization_receipts;

    CREATE OR REPLACE TEMP TABLE review_serving_partial_cleanup_authorization_receipts AS
      SELECT
        cleanup_authorization.authorization_id,
        CAST(COUNT(*) AS BIGINT) AS applied_row_count
      FROM app.review_rebuild_partial_cleanup_authorization cleanup_authorization
      INNER JOIN ${rebuildSql.tempTableName} cleaned_row
        ON cleaned_row.project_id = cleanup_authorization.project_id
        AND cleaned_row.review_config_hash = cleanup_authorization.review_config_hash
        AND cleaned_row.request_id = cleanup_authorization.request_id
        AND cleaned_row.chunk_id = cleanup_authorization.chunk_id
        AND cleaned_row.snapshot_id = cleanup_authorization.snapshot_id
      WHERE cleanup_authorization.partial_table = ${getSqlLiteral(input.spec.table)}
        AND cleanup_authorization.cleanup_mode = 'stale_orphan_summary_partial'
        AND cleanup_authorization.operator_ack = 'authorize-stale-orphan-review-serving-summary-partial-cleanup'
        AND cleanup_authorization.expires_at > ${getTimestampLiteral(input.now)}
        AND cleanup_authorization.applied_at IS NULL
      GROUP BY cleanup_authorization.authorization_id;

    DROP TABLE IF EXISTS app.review_rebuild_partial_cleanup_authorization_repair;

    CREATE TABLE app.review_rebuild_partial_cleanup_authorization_repair (
      authorization_id VARCHAR PRIMARY KEY,
      project_id VARCHAR NOT NULL,
      review_config_hash VARCHAR NOT NULL,
      request_id VARCHAR NOT NULL,
      chunk_id VARCHAR NOT NULL,
      snapshot_id VARCHAR NOT NULL,
      partial_table VARCHAR NOT NULL,
      cleanup_mode VARCHAR NOT NULL,
      reason VARCHAR NOT NULL,
      evidence_json JSON NOT NULL DEFAULT '{}',
      expected_row_count BIGINT NOT NULL,
      observed_row_count BIGINT NOT NULL,
      operator_ack VARCHAR NOT NULL,
      authorized_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
      expires_at TIMESTAMPTZ NOT NULL,
      applied_at TIMESTAMPTZ,
      applied_row_count BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
      CHECK (length(trim(authorization_id)) > 0),
      CHECK (length(trim(project_id)) > 0),
      CHECK (length(trim(review_config_hash)) > 0),
      CHECK (length(trim(request_id)) > 0),
      CHECK (length(trim(chunk_id)) > 0),
      CHECK (length(trim(snapshot_id)) > 0),
      CHECK (
        partial_table IN (
          'mart.review_article_summary_contribution_rebuild_partial_v4',
          'mart.review_article_summary_rebuild_partial_v4'
        )
      ),
      CHECK (cleanup_mode IN ('stale_orphan_summary_partial')),
      CHECK (length(trim(reason)) > 0),
      CHECK (expected_row_count >= 0),
      CHECK (observed_row_count >= 0),
      CHECK (applied_row_count IS NULL OR applied_row_count >= 0),
      CHECK (length(trim(operator_ack)) > 0),
      CHECK (expires_at > authorized_at)
    );

    INSERT INTO app.review_rebuild_partial_cleanup_authorization_repair
    SELECT
      cleanup_authorization.authorization_id,
      cleanup_authorization.project_id,
      cleanup_authorization.review_config_hash,
      cleanup_authorization.request_id,
      cleanup_authorization.chunk_id,
      cleanup_authorization.snapshot_id,
      cleanup_authorization.partial_table,
      cleanup_authorization.cleanup_mode,
      cleanup_authorization.reason,
      cleanup_authorization.evidence_json,
      cleanup_authorization.expected_row_count,
      cleanup_authorization.observed_row_count,
      cleanup_authorization.operator_ack,
      cleanup_authorization.authorized_at,
      cleanup_authorization.expires_at,
      CASE
        WHEN receipt.authorization_id IS NULL THEN cleanup_authorization.applied_at
        ELSE current_timestamp
      END AS applied_at,
      COALESCE(receipt.applied_row_count, cleanup_authorization.applied_row_count) AS applied_row_count,
      cleanup_authorization.created_at,
      CASE
        WHEN receipt.authorization_id IS NULL THEN cleanup_authorization.updated_at
        ELSE current_timestamp
      END AS updated_at
    FROM app.review_rebuild_partial_cleanup_authorization cleanup_authorization
    LEFT JOIN review_serving_partial_cleanup_authorization_receipts receipt
      ON receipt.authorization_id = cleanup_authorization.authorization_id;

    DROP TABLE app.review_rebuild_partial_cleanup_authorization;

    ALTER TABLE app.review_rebuild_partial_cleanup_authorization_repair
    RENAME TO review_rebuild_partial_cleanup_authorization;

    CREATE INDEX IF NOT EXISTS idx_review_rebuild_partial_cleanup_authorization_lookup
    ON app.review_rebuild_partial_cleanup_authorization(
      project_id,
      review_config_hash,
      request_id,
      chunk_id,
      snapshot_id,
      partial_table,
      expires_at
    );

    DROP TABLE IF EXISTS review_serving_partial_cleanup_authorization_receipts;
  `)
}

const deleteTerminalRebuildPartialCleanupBatch = async (
  input: ReviewServingRetentionCleanupInput & {spec: CleanupTableSpec},
  database: ReviewServingRetentionServiceTransaction,
) => {
  const rebuildSql = summaryPartialRebuildSqlByTable[input.spec.table]

  if (rebuildSql === undefined) {
    throw new Error(`missing summary partial cleanup rebuild SQL for ${input.spec.table}`)
  }

  await database.run(`
    CREATE OR REPLACE TEMP TABLE ${rebuildSql.tempTableName} AS
    ${getTerminalRebuildPartialCleanupCandidateSql(input)}
  `)

  const [row] = await database.queryJson<{cleanupRowCount: number | string}>(`
    SELECT CAST(COUNT(*) AS BIGINT) AS cleanupRowCount
    FROM ${rebuildSql.tempTableName}
  `)
  const cleanupRowCount = Number(row?.cleanupRowCount ?? 0)

  if (cleanupRowCount === 0) {
    await database.run(`DROP TABLE IF EXISTS ${rebuildSql.tempTableName}`)
    return
  }

  await database.run(`
    CREATE OR REPLACE TABLE ${input.spec.table} AS
    SELECT partial.*
    FROM ${input.spec.table} partial
    WHERE NOT EXISTS (
      SELECT 1
      FROM ${rebuildSql.tempTableName} cleanup_row
      WHERE cleanup_row.cleanup_rowid = partial.rowid
    )
  `)
  await database.run(rebuildSql.uniqueIndexSql)
  await database.run(rebuildSql.createIndexSql)
  await markAppliedAuthorizedRebuildPartialCleanup(input, rebuildSql, database)
  await database.run(`DROP TABLE IF EXISTS ${rebuildSql.tempTableName}`)
}

const getManifestReviewConfigHashPredicate = (input: ReviewServingRetentionCleanupInput) => {
  return `EXISTS (
            SELECT 1
            FROM app.review_serving_snapshot_manifest cleanup_snapshot
            WHERE cleanup_snapshot.project_id = candidate.project_id
              AND cleanup_snapshot.snapshot_id = candidate.snapshot_id
              AND cleanup_snapshot.review_config_hash IS NOT DISTINCT FROM ${getSqlLiteral(input.reviewConfigHash ?? null)}
          )`
}

const getChunkManifestPartialRowsGonePredicate = () => {
  return `NOT EXISTS (
            SELECT 1
            FROM mart.review_article_summary_contribution_rebuild_partial_v4 contribution_partial
            WHERE contribution_partial.project_id = candidate.project_id
              AND contribution_partial.request_id = candidate.request_id
              AND contribution_partial.chunk_id = candidate.chunk_id
              AND contribution_partial.snapshot_id = candidate.snapshot_id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM mart.review_article_summary_rebuild_partial_v4 summary_partial
            WHERE summary_partial.project_id = candidate.project_id
              AND summary_partial.request_id = candidate.request_id
              AND summary_partial.chunk_id = candidate.chunk_id
              AND summary_partial.snapshot_id = candidate.snapshot_id
          )`
}

const deleteTerminalRebuildChunkManifestCleanupBatch = async (
  input: ReviewServingRetentionCleanupInput & {spec: CleanupTableSpec},
  database: ReviewServingRetentionServiceTransaction,
) => {
  await database.run(`
    DELETE FROM ${input.spec.table}
    WHERE rowid IN (
        SELECT candidate.rowid
        FROM ${input.spec.table} candidate
        INNER JOIN app.review_rebuild_request request
          ON request.request_id = candidate.request_id
          AND request.project_id = candidate.project_id
        WHERE candidate.project_id = ${getSqlLiteral(input.projectId)}
          AND candidate.request_id IS NOT NULL
          AND candidate.snapshot_id IS NOT NULL
          AND candidate.projection_component = 'summary'
          AND ${getManifestReviewConfigHashPredicate(input)}
          AND request.status = 'completed'
          AND request.admission_state = 'admitted'
          AND ${getTerminalRebuildChunkPredicate('candidate')}
          AND NOT (${getActiveSnapshotManifestGuardPredicate(input.spec.protectedPredicate)})
          AND NOT (${getActiveSnapshotPinGuardPredicate(input.spec.protectedPredicate, input.now)})
          AND NOT (${getProtectedRebuildRequestPredicate('request', input.now)})
          AND NOT (${getNewestDiagnosticRebuildRequestPredicate('request')})
          AND ${getChunkManifestPartialRowsGonePredicate()}
        ORDER BY ${getCleanupOrderBy(input.spec)}
        LIMIT ${getSqlLiteral(input.batchSize)}
      )
  `)
}

const deleteCleanupBatch = async (
  input: ReviewServingRetentionCleanupInput & {spec: CleanupTableSpec},
  database: ReviewServingRetentionServiceTransaction,
) => {
  if (input.spec.kind === 'terminalRebuildPartial') {
    await deleteTerminalRebuildPartialCleanupBatch(input, database)
    return
  }

  if (input.spec.kind === 'terminalRebuildChunkManifest') {
    await deleteTerminalRebuildChunkManifestCleanupBatch(input, database)
    return
  }

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
        ORDER BY ${getCleanupOrderBy(input.spec)}
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

    if (spec === undefined) {
      throw new Error(`missing review-serving retention cleanup table spec at index ${boundedTableIndex}`)
    }

    await deleteCleanupBatch({...input, spec}, tx)

    const nextCleanupTableIndex = (boundedTableIndex + 1) % retentionTableSpecCount

    await writeRetentionMark(
      {
        baseGeneration: Number(retentionState?.baseGeneration ?? 0),
        cursor: {tableIndex: nextCleanupTableIndex},
        patchWatermark: Number(retentionState?.patchWatermark ?? 0),
        retentionScope,
        snapshotId: retentionState?.snapshotId ?? null,
      },
      tx,
    )

    return {
      cleanupBatchSize: input.batchSize,
      cleanupSpecKind: spec.kind ?? 'snapshot',
      cleanupTable: spec.table,
      cleanupTableIndex: boundedTableIndex,
      nextCleanupTableIndex,
      retentionScope,
    }
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
