import {writeFileSync} from 'node:fs'

import {DuckDBInstance} from '@duckdb/node-api'
import {Effect} from 'effect'

import {type AppDatabaseSnapshot, getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {getSqlLiteral} from '../src/server/services/appQueryHelpers.ts'
import {createDuckdbSnapshotForCli} from '../src/server/utils/duckdbScriptAccess.ts'
import {getReadOnlyDuckdbRuntimeOptions} from '../src/server/utils/duckdbService.ts'

type ColumnProfile = {
  approxDistinctCount: number | null
  column: string
  nonNullCount: number | null
  nullCount: number | null
  type: string
}
type CliOptions = {
  format: 'json' | 'markdown'
  limit: number
  maxProfileColumns: number
  output: string | null
  projectId: string
}
type EvidenceReport = {
  generatedAt: string
  mode: 'readonly-snapshot'
  options: CliOptions
  retentionCleanupEligibility: RetentionCleanupEligibilityReport
  selectedImportPayloadSlimmingReadiness: SelectedImportPayloadSlimmingReadinessReport
  snapshotPath: string
  tables: TableEvidence[]
}
type QueryRuntime = Awaited<ReturnType<typeof getSnapshotQueryRuntime>>
type RetentionCleanupEligibilityTable = {
  activeOrLastKnownGoodSnapshotProtectedRows: number | null
  completedRequestAndSummaryChunkCandidateRows: number | null
  dependentPartialBlockedRows: number | null
  eligibleRows: number | null
  error: string | null
  newestDiagnosticRequestProtectedRows: number | null
  pinnedSnapshotProtectedRows: number | null
  protectedRebuildRequestRows: number | null
  table: string
  totalScopedRows: number | null
}
type RetentionCleanupEligibilityReport = {
  note: string
  projectId: string
  tables: RetentionCleanupEligibilityTable[]
}
type SelectedImportPayloadColumnEvidence = {
  column: (typeof selectedImportPayloadColumns)[number]
  hotFieldNonNullCount: number | null
  hotFieldNullCount: number | null
  selectedBaseNonNullCount: number | null
  selectedBaseNullCount: number | null
}
type SelectedImportPayloadSlimmingReadinessReport = {
  comparisonStatus: string
  consumerWriterStatus: string
  error: string | null
  hotFieldScopedRows: number | null
  note: string
  projectId: string
  selectedBaseScopedRows: number | null
  verdict: 'not-authorized' | 'blocked'
  columns: SelectedImportPayloadColumnEvidence[]
}
type TableColumn = {column_name: string; data_type: string}
type TableEvidence = {
  columnCount: number
  columnProfiles: ColumnProfile[]
  duplicateProbe: {duplicateCount: number | null; keyColumns: string[]; sql: string | null}
  error: string | null
  indexes: unknown[]
  oldestNewest: Record<string, {max: string | null; min: string | null}>
  rowCount: number | null
  sizeProxies: Record<string, number | null>
  table: string
  whereClause: string | null
}

const defaultProjectId = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'
const defaultLimit = 25
const defaultMaxProfileColumns = 18

const hotReviewServingTables = [
  'app.review_selected_article_import_v4',
  'app.review_selected_import_snapshot',
  'app.review_projection_identity_manifest',
  'app.review_serving_snapshot_manifest',
  'app.review_serving_dirty_work',
  'app.review_serving_projector_watermark',
  'app.review_rebuild_request',
  'app.review_rebuild_chunk_manifest',
  'app.review_serving_retention_mark',
  'mart.review_article_serving_v4',
  'mart.review_article_filter_posting_serving_v4',
  'mart.review_article_judgment_detail_serving_v4',
  'mart.review_article_count_serving_v4',
  'mart.review_filter_facet_serving_v4',
  'mart.review_filter_option_serving_v4',
  'mart.review_filter_posting_stats_v4',
  'mart.review_title_search_serving_v4',
  'mart.review_unassessed_queue_serving_v4',
  'mart.review_article_summary_contribution_v4',
  'mart.review_article_summary_rebuild_partial_v4',
  'mart.review_article_summary_contribution_rebuild_partial_v4',
] as const

const preferredProfileColumns = [
  'project_id',
  'review_config_hash',
  'snapshot_id',
  'selected_import_snapshot_id',
  'projection_component',
  'status',
  'admission_state',
  'list_mode_key',
  'filter_kind',
  'filter_value',
  'queue_kind',
  'payload_kind',
  'article_id',
  'prompt_id',
  'request_id',
  'chunk_id',
  'sort_key',
  'activity_sort_at',
  'updated_at',
] as const

const timestampColumnCandidates = [
  'created_at',
  'updated_at',
  'started_at',
  'completed_at',
  'failed_at',
  'activated_at',
  'retired_at',
  'last_progressed_at',
  'lease_expires_at',
  'sort_key',
  'activity_sort_at',
] as const

const duplicateKeyCandidates: Record<string, string[]> = {
  'app.review_rebuild_chunk_manifest': ['chunk_id'],
  'app.review_selected_article_import_v4': [
    'project_id',
    'project_scope_identity',
    'selected_import_snapshot_id',
    'article_id',
  ],
  'app.review_serving_snapshot_manifest': ['project_id', 'snapshot_id'],
  'mart.review_article_count_serving_v4': [
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'list_mode_key',
    'count_kind',
    'filter_key',
  ],
  'mart.review_article_filter_posting_serving_v4': [
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'filter_kind',
    'filter_value',
    'list_mode_key',
    'article_id',
  ],
  'mart.review_article_judgment_detail_serving_v4': [
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'list_mode_key',
    'article_id',
    'payload_kind',
    'prompt_id',
  ],
  'mart.review_article_serving_v4': [
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'list_mode_key',
    'article_id',
  ],
  'mart.review_filter_facet_serving_v4': [
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'summary_identity',
    'facet_kind',
    'facet_key',
    'facet_value',
  ],
  'mart.review_filter_option_serving_v4': [
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'search_identity',
    'filter_kind',
    'facet_key',
    'option_value_key',
  ],
  'mart.review_filter_posting_stats_v4': [
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'filter_kind',
    'filter_value',
    'list_mode_key',
  ],
  'mart.review_title_search_serving_v4': [
    'project_id',
    'search_identity',
    'project_scope_identity',
    'snapshot_id',
    'token',
    'article_id',
  ],
  'mart.review_unassessed_queue_serving_v4': [
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'queue_kind',
    'priority_bucket',
    'activity_sort_at',
    'article_id',
    'prompt_id',
    'queue_identity',
  ],
}

const retentionCleanupEligibilityTables = [
  'mart.review_article_summary_contribution_rebuild_partial_v4',
  'mart.review_article_summary_rebuild_partial_v4',
  'app.review_rebuild_chunk_manifest',
] as const

const selectedImportPayloadColumns = [
  'import_route_id',
  'source_record_key',
  'selected_rank_key',
  'selected_rank_numeric',
  'publication_year',
  'article_title',
  'journal_title',
  'external_id',
] as const

const getArgValue = (names: string[]) => {
  const matchedArgument = process.argv.slice(2).find((argument) => {
    return names.some((name) => {
      return argument.startsWith(`${name}=`)
    })
  })

  return matchedArgument?.slice(matchedArgument.indexOf('=') + 1).trim()
}

const getPositiveIntegerOption = (value: string | undefined, fallback: number) => {
  const parsedValue = value === undefined ? Number.NaN : Number(value)
  return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : fallback
}

const getCliOptions = (): CliOptions => {
  const format = getArgValue(['--format']) === 'json' ? 'json' : 'markdown'

  return {
    format,
    limit: getPositiveIntegerOption(getArgValue(['--limit']), defaultLimit),
    maxProfileColumns: getPositiveIntegerOption(
      getArgValue(['--max-profile-columns', '--maxProfileColumns']),
      defaultMaxProfileColumns,
    ),
    output: getArgValue(['--output']) ?? null,
    projectId: getArgValue(['--project-id', '--projectId']) ?? defaultProjectId,
  }
}

const deleteSnapshot = (snapshot: AppDatabaseSnapshot) => {
  return Effect.tryPromise(() => {
    return getAppDatabaseService().deleteSnapshot(snapshot.snapshotPath)
  }).pipe(
    Effect.catchAll((error) => {
      return Effect.sync(() => {
        console.error('[inspectReviewServingPhysicalEvidence] failed to delete snapshot', {
          error,
          snapshotPath: snapshot.snapshotPath,
        })
      })
    }),
  )
}

const getSnapshotQueryRuntime = async (snapshotPath: string) => {
  const duckdbInstance = await DuckDBInstance.create(snapshotPath, getReadOnlyDuckdbRuntimeOptions())
  const connection = await duckdbInstance.connect()

  return {connection, duckdbInstance}
}

const closeSnapshotQueryRuntime = (runtime: QueryRuntime) => {
  return Effect.sync(() => {
    runtime.connection.closeSync()
    runtime.duckdbInstance.closeSync()
  })
}

const runReadonlyQuery = async <T>(runtime: QueryRuntime, sql: string): Promise<T[]> => {
  const reader = await runtime.connection.runAndReadAll(sql)
  return reader.getRowObjectsJson() as T[]
}

const getTableParts = (table: string) => {
  const [schemaName, tableName] = table.split('.')

  if (!schemaName || !tableName) {
    throw new Error(`Invalid table name: ${table}`)
  }

  return {schemaName, tableName}
}

const getTableColumns = async (runtime: QueryRuntime, table: string) => {
  const {schemaName, tableName} = getTableParts(table)

  return runReadonlyQuery<TableColumn>(
    runtime,
    `
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = ${getSqlLiteral(schemaName)}
        AND table_name = ${getSqlLiteral(tableName)}
      ORDER BY ordinal_position
    `,
  )
}

const getWhereClause = (columns: TableColumn[], projectId: string) => {
  return columns.some((column) => {
    return column.column_name === 'project_id'
  })
    ? `project_id = ${getSqlLiteral(projectId)}`
    : null
}

const hasColumn = (columns: TableColumn[], columnName: string) => {
  return columns.some((column) => {
    return column.column_name === columnName
  })
}

const getRowCount = async (runtime: QueryRuntime, table: string, whereClause: string | null) => {
  const rows = await runReadonlyQuery<{rowCount: number | string}>(
    runtime,
    `SELECT CAST(COUNT(*) AS BIGINT) AS rowCount FROM ${table}${whereClause ? ` WHERE ${whereClause}` : ''}`,
  )
  return Number(rows[0]?.rowCount ?? 0)
}

const getProfileColumns = (columns: TableColumn[], maxProfileColumns: number) => {
  const preferred = preferredProfileColumns.flatMap((columnName) => {
    const column = columns.find((candidate) => {
      return candidate.column_name === columnName
    })

    return column ? [column] : []
  })
  const remaining = columns.filter((column) => {
    return !preferred.some((candidate) => {
      return candidate.column_name === column.column_name
    })
  })

  return [...preferred, ...remaining].slice(0, maxProfileColumns)
}

const getColumnProfile = async (
  runtime: QueryRuntime,
  table: string,
  column: TableColumn,
  whereClause: string | null,
): Promise<ColumnProfile> => {
  const columnSql = `"${column.column_name}"`
  const rows = await runReadonlyQuery<{
    approxDistinctCount: number | string | null
    nonNullCount: number | string | null
    nullCount: number | string | null
  }>(
    runtime,
    `
      SELECT
        CAST(SUM(CASE WHEN ${columnSql} IS NULL THEN 1 ELSE 0 END) AS BIGINT) AS nullCount,
        CAST(SUM(CASE WHEN ${columnSql} IS NOT NULL THEN 1 ELSE 0 END) AS BIGINT) AS nonNullCount,
        CAST(approx_count_distinct(${columnSql}) AS BIGINT) AS approxDistinctCount
      FROM ${table}
      ${whereClause ? `WHERE ${whereClause}` : ''}
    `,
  )
  const row = rows[0]

  return {
    approxDistinctCount: row?.approxDistinctCount === null ? null : Number(row?.approxDistinctCount ?? 0),
    column: column.column_name,
    nonNullCount: row?.nonNullCount === null ? null : Number(row?.nonNullCount ?? 0),
    nullCount: row?.nullCount === null ? null : Number(row?.nullCount ?? 0),
    type: column.data_type,
  }
}

const getOldestNewest = async (runtime: QueryRuntime, table: string, columns: TableColumn[], whereClause: string | null) => {
  const timestampColumns = timestampColumnCandidates.filter((columnName) => {
    return hasColumn(columns, columnName)
  })
  const result: Record<string, {max: string | null; min: string | null}> = {}

  for (const columnName of timestampColumns) {
    const rows = await runReadonlyQuery<{maxValue: string | null; minValue: string | null}>(
      runtime,
      `
        SELECT MIN("${columnName}") AS minValue, MAX("${columnName}") AS maxValue
        FROM ${table}
        ${whereClause ? `WHERE ${whereClause}` : ''}
      `,
    )
    result[columnName] = {max: rows[0]?.maxValue ?? null, min: rows[0]?.minValue ?? null}
  }

  return result
}

const getIndexes = async (runtime: QueryRuntime, table: string) => {
  const {schemaName, tableName} = getTableParts(table)

  try {
    return await runReadonlyQuery<unknown>(
      runtime,
      `
        SELECT index_name, sql
        FROM duckdb_indexes()
        WHERE schema_name = ${getSqlLiteral(schemaName)}
          AND table_name = ${getSqlLiteral(tableName)}
        ORDER BY index_name
      `,
    )
  } catch {
    return []
  }
}

const getSizeProxies = async (runtime: QueryRuntime, table: string, columns: TableColumn[], whereClause: string | null) => {
  const expressions = columns
    .filter((column) => {
      return column.column_name.endsWith('_json') || column.column_name.endsWith('_payload') || column.column_name === 'payload'
    })
    .slice(0, 8)
    .map((column) => {
      return `SUM(length(CAST("${column.column_name}" AS VARCHAR))) AS "${column.column_name}_stringBytes"`
    })

  if (expressions.length === 0) {
    return {}
  }

  const rows = await runReadonlyQuery<Record<string, number | string | null>>(
    runtime,
    `
      SELECT ${expressions.join(', ')}
      FROM ${table}
      ${whereClause ? `WHERE ${whereClause}` : ''}
    `,
  )
  const row = rows[0] ?? {}

  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      return [key, value === null ? null : Number(value)]
    }),
  )
}

const getDuplicateProbe = async (runtime: QueryRuntime, table: string, columns: TableColumn[], whereClause: string | null) => {
  const keyColumns = (duplicateKeyCandidates[table] ?? []).filter((columnName) => {
    return hasColumn(columns, columnName)
  })

  if (keyColumns.length === 0) {
    return {duplicateCount: null, keyColumns, sql: null}
  }

  const keySql = keyColumns
    .map((columnName) => {
      return `"${columnName}"`
    })
    .join(', ')
  const sql = `
    WITH duplicate_keys AS (
      SELECT ${keySql}
      FROM ${table}
      ${whereClause ? `WHERE ${whereClause}` : ''}
      GROUP BY ${keySql}
      HAVING COUNT(*) > 1
    )
    SELECT CAST(COUNT(*) AS BIGINT) AS duplicateCount
    FROM duplicate_keys
  `
  const rows = await runReadonlyQuery<{duplicateCount: number | string}>(runtime, sql)

  return {duplicateCount: Number(rows[0]?.duplicateCount ?? 0), keyColumns, sql}
}

const getActivePinPredicate = () => {
  return 'pin.released_at IS NULL AND pin.ref_count > 0 AND pin.expires_at > current_timestamp'
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

const getActiveSnapshotPinGuardPredicate = (snapshotColumn: string) => {
  return `EXISTS (
            SELECT 1
            FROM app.review_serving_snapshot_pin pin
            WHERE pin.project_id = candidate.project_id
              AND pin.snapshot_id = candidate.${snapshotColumn}
              AND ${getActivePinPredicate()}
          )`
}

const getProtectedRebuildRequestPredicate = (requestSource: string) => {
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
                    OR protected_request.retry_after <= current_timestamp
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

const getManifestReviewConfigHashPredicate = () => {
  return `EXISTS (
            SELECT 1
            FROM app.review_serving_snapshot_manifest cleanup_snapshot
            WHERE cleanup_snapshot.project_id = candidate.project_id
              AND cleanup_snapshot.snapshot_id = candidate.snapshot_id
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

const getRetentionCleanupEligibilitySql = (table: (typeof retentionCleanupEligibilityTables)[number], projectId: string) => {
  const projectPredicate = `candidate.project_id = ${getSqlLiteral(projectId)}`
  const activeSnapshotPredicate = getActiveSnapshotManifestGuardPredicate('snapshot_id')
  const activePinPredicate = getActiveSnapshotPinGuardPredicate('snapshot_id')
  const protectedRequestPredicate = getProtectedRebuildRequestPredicate('request')
  const newestDiagnosticPredicate = getNewestDiagnosticRebuildRequestPredicate('request')

  if (table === 'app.review_rebuild_chunk_manifest') {
    const terminalCandidatePredicate = `candidate.request_id IS NOT NULL
          AND candidate.snapshot_id IS NOT NULL
          AND candidate.projection_component = 'summary'
          AND ${getManifestReviewConfigHashPredicate()}
          AND request.status = 'completed'
          AND request.admission_state = 'admitted'
          AND ${getTerminalRebuildChunkPredicate('candidate')}`
    const dependentPartialsGonePredicate = getChunkManifestPartialRowsGonePredicate()

    return `
      SELECT
        CAST(COUNT(*) AS BIGINT) AS totalScopedRows,
        CAST(COUNT(*) FILTER (WHERE ${activeSnapshotPredicate}) AS BIGINT) AS activeOrLastKnownGoodSnapshotProtectedRows,
        CAST(COUNT(*) FILTER (WHERE ${activePinPredicate}) AS BIGINT) AS pinnedSnapshotProtectedRows,
        CAST(COUNT(*) FILTER (WHERE ${terminalCandidatePredicate}) AS BIGINT) AS completedRequestAndSummaryChunkCandidateRows,
        CAST(COUNT(*) FILTER (WHERE ${protectedRequestPredicate}) AS BIGINT) AS protectedRebuildRequestRows,
        CAST(COUNT(*) FILTER (WHERE ${newestDiagnosticPredicate}) AS BIGINT) AS newestDiagnosticRequestProtectedRows,
        CAST(COUNT(*) FILTER (WHERE ${terminalCandidatePredicate} AND NOT (${dependentPartialsGonePredicate})) AS BIGINT) AS dependentPartialBlockedRows,
        CAST(COUNT(*) FILTER (
          WHERE ${terminalCandidatePredicate}
            AND NOT (${activeSnapshotPredicate})
            AND NOT (${activePinPredicate})
            AND NOT (${protectedRequestPredicate})
            AND NOT (${newestDiagnosticPredicate})
            AND ${dependentPartialsGonePredicate}
        ) AS BIGINT) AS eligibleRows
      FROM ${table} candidate
      LEFT JOIN app.review_rebuild_request request
        ON request.request_id = candidate.request_id
        AND request.project_id = candidate.project_id
      WHERE ${projectPredicate}
    `
  }

  const terminalCandidatePredicate = `request.status = 'completed'
          AND request.admission_state = 'admitted'
          AND ${getTerminalRebuildChunkPredicate('chunk')}`

  return `
    SELECT
      CAST(COUNT(*) AS BIGINT) AS totalScopedRows,
      CAST(COUNT(*) FILTER (WHERE ${activeSnapshotPredicate}) AS BIGINT) AS activeOrLastKnownGoodSnapshotProtectedRows,
      CAST(COUNT(*) FILTER (WHERE ${activePinPredicate}) AS BIGINT) AS pinnedSnapshotProtectedRows,
      CAST(COUNT(*) FILTER (WHERE ${terminalCandidatePredicate}) AS BIGINT) AS completedRequestAndSummaryChunkCandidateRows,
      CAST(COUNT(*) FILTER (WHERE ${protectedRequestPredicate}) AS BIGINT) AS protectedRebuildRequestRows,
      CAST(COUNT(*) FILTER (WHERE ${newestDiagnosticPredicate}) AS BIGINT) AS newestDiagnosticRequestProtectedRows,
      NULL::BIGINT AS dependentPartialBlockedRows,
      CAST(COUNT(*) FILTER (
        WHERE ${terminalCandidatePredicate}
          AND NOT (${activeSnapshotPredicate})
          AND NOT (${activePinPredicate})
          AND NOT (${protectedRequestPredicate})
          AND NOT (${newestDiagnosticPredicate})
      ) AS BIGINT) AS eligibleRows
    FROM ${table} candidate
    LEFT JOIN app.review_rebuild_request request
      ON request.request_id = candidate.request_id
      AND request.project_id = candidate.project_id
    LEFT JOIN app.review_rebuild_chunk_manifest chunk
      ON chunk.request_id = candidate.request_id
      AND chunk.chunk_id = candidate.chunk_id
      AND chunk.project_id = candidate.project_id
      AND chunk.snapshot_id = candidate.snapshot_id
      AND chunk.projection_component = 'summary'
    WHERE ${projectPredicate}
  `
}

const getNumberOrNull = (value: number | string | null | undefined) => {
  return value === null || value === undefined ? null : Number(value)
}

const getRetentionCleanupEligibilityTable = async (
  runtime: QueryRuntime,
  table: (typeof retentionCleanupEligibilityTables)[number],
  projectId: string,
): Promise<RetentionCleanupEligibilityTable> => {
  try {
    const rows = await runReadonlyQuery<Omit<RetentionCleanupEligibilityTable, 'error' | 'table'>>(
      runtime,
      getRetentionCleanupEligibilitySql(table, projectId),
    )
    const row = rows[0]

    return {
      activeOrLastKnownGoodSnapshotProtectedRows: getNumberOrNull(
        row?.activeOrLastKnownGoodSnapshotProtectedRows,
      ),
      completedRequestAndSummaryChunkCandidateRows: getNumberOrNull(
        row?.completedRequestAndSummaryChunkCandidateRows,
      ),
      dependentPartialBlockedRows: getNumberOrNull(row?.dependentPartialBlockedRows),
      eligibleRows: getNumberOrNull(row?.eligibleRows),
      error: null,
      newestDiagnosticRequestProtectedRows: getNumberOrNull(row?.newestDiagnosticRequestProtectedRows),
      pinnedSnapshotProtectedRows: getNumberOrNull(row?.pinnedSnapshotProtectedRows),
      protectedRebuildRequestRows: getNumberOrNull(row?.protectedRebuildRequestRows),
      table,
      totalScopedRows: getNumberOrNull(row?.totalScopedRows),
    }
  } catch (error) {
    return {
      activeOrLastKnownGoodSnapshotProtectedRows: null,
      completedRequestAndSummaryChunkCandidateRows: null,
      dependentPartialBlockedRows: null,
      eligibleRows: null,
      error: error instanceof Error ? error.message : String(error),
      newestDiagnosticRequestProtectedRows: null,
      pinnedSnapshotProtectedRows: null,
      protectedRebuildRequestRows: null,
      table,
      totalScopedRows: null,
    }
  }
}

const getRetentionCleanupEligibilityReport = async (
  runtime: QueryRuntime,
  projectId: string,
): Promise<RetentionCleanupEligibilityReport> => {
  const tables: RetentionCleanupEligibilityTable[] = []

  for (const table of retentionCleanupEligibilityTables) {
    tables.push(await getRetentionCleanupEligibilityTable(runtime, table, projectId))
  }

  return {
    note: 'Read-only aggregate eligibility evidence for the first storage-slimming cleanup slice. Counts are project-wide aggregates, while runtime cleanup still runs through per-project/per-config retention targets and guardrails; this section does not authorize deletion.',
    projectId,
    tables,
  }
}

const getSelectedImportPayloadSlimmingReadinessReport = async (
  runtime: QueryRuntime,
  projectId: string,
): Promise<SelectedImportPayloadSlimmingReadinessReport> => {
  const selectedBaseExpressions = selectedImportPayloadColumns
    .map((column) => {
      return `CAST(COUNT(*) FILTER (WHERE selected_base.${column} IS NULL) AS BIGINT) AS selectedBase_${column}_nullCount,
        CAST(COUNT(*) FILTER (WHERE selected_base.${column} IS NOT NULL) AS BIGINT) AS selectedBase_${column}_nonNullCount`
    })
    .join(',\n        ')
  const hotFieldExpressions = selectedImportPayloadColumns
    .map((column) => {
      return `CAST(COUNT(*) FILTER (WHERE hot_field.${column} IS NULL) AS BIGINT) AS hotField_${column}_nullCount,
        CAST(COUNT(*) FILTER (WHERE hot_field.${column} IS NOT NULL) AS BIGINT) AS hotField_${column}_nonNullCount`
    })
    .join(',\n        ')

  try {
    const selectedBaseRows = await runReadonlyQuery<Record<string, number | string | null>>(
      runtime,
      `
        SELECT
          CAST(COUNT(*) AS BIGINT) AS selectedBaseScopedRows,
          ${selectedBaseExpressions}
        FROM app.review_selected_article_import_v4 selected_base
        WHERE selected_base.project_id = ${getSqlLiteral(projectId)}
      `,
    )
    const hotFieldRows = await runReadonlyQuery<Record<string, number | string | null>>(
      runtime,
      `
        SELECT
          CAST(COUNT(*) AS BIGINT) AS hotFieldScopedRows,
          ${hotFieldExpressions}
        FROM app.review_import_article_hot_field hot_field
        INNER JOIN app.project_import_route project_route
          ON project_route.import_route_id = hot_field.import_route_id
          AND project_route.project_id = ${getSqlLiteral(projectId)}
      `,
    )
    const selectedBaseRow = selectedBaseRows[0] ?? {}
    const hotFieldRow = hotFieldRows[0] ?? {}

    return {
      columns: selectedImportPayloadColumns.map((column) => {
        return {
          column,
          hotFieldNonNullCount: getNumberOrNull(hotFieldRow[`hotField_${column}_nonNullCount`]),
          hotFieldNullCount: getNumberOrNull(hotFieldRow[`hotField_${column}_nullCount`]),
          selectedBaseNonNullCount: getNumberOrNull(selectedBaseRow[`selectedBase_${column}_nonNullCount`]),
          selectedBaseNullCount: getNumberOrNull(selectedBaseRow[`selectedBase_${column}_nullCount`]),
        }
      }),
      comparisonStatus:
        'Hot-field counts are scoped through app.project_import_route for the same project. Non-null hot-field values with null selected-base values mean source data exists but the selected-base projection did not carry it for this scoped snapshot.',
      consumerWriterStatus:
        'Current code still writes these fields from app.review_import_article_hot_field into selected-import base rows and reads selected-base values in downstream review-serving projection paths. Treat this as evidence for investigation only.',
      error: null,
      hotFieldScopedRows: getNumberOrNull(hotFieldRow.hotFieldScopedRows),
      note: 'This section is not deletion/slimming authorization. Slimming is only safe after runtime non-population is proven across the intended scope and writer/reader/recovery consumers are changed or proven irrelevant.',
      projectId,
      selectedBaseScopedRows: getNumberOrNull(selectedBaseRow.selectedBaseScopedRows),
      verdict: 'not-authorized',
    }
  } catch (error) {
    return {
      columns: [],
      comparisonStatus: 'Blocked before source/hot-field comparison could be collected.',
      consumerWriterStatus:
        'Current code still writes/reads selected-import payload fields; failed evidence collection cannot authorize slimming.',
      error: error instanceof Error ? error.message : String(error),
      hotFieldScopedRows: null,
      note: 'This section is not deletion/slimming authorization.',
      projectId,
      selectedBaseScopedRows: null,
      verdict: 'blocked',
    }
  }
}

const getTableEvidence = async (runtime: QueryRuntime, table: string, options: CliOptions): Promise<TableEvidence> => {
  try {
    const columns = await getTableColumns(runtime, table)
    const whereClause = getWhereClause(columns, options.projectId)
    const columnProfiles: ColumnProfile[] = []

    for (const column of getProfileColumns(columns, options.maxProfileColumns)) {
      columnProfiles.push(await getColumnProfile(runtime, table, column, whereClause))
    }

    return {
      columnCount: columns.length,
      columnProfiles,
      duplicateProbe: await getDuplicateProbe(runtime, table, columns, whereClause),
      error: null,
      indexes: await getIndexes(runtime, table),
      oldestNewest: await getOldestNewest(runtime, table, columns, whereClause),
      rowCount: await getRowCount(runtime, table, whereClause),
      sizeProxies: await getSizeProxies(runtime, table, columns, whereClause),
      table,
      whereClause,
    }
  } catch (error) {
    return {
      columnCount: 0,
      columnProfiles: [],
      duplicateProbe: {duplicateCount: null, keyColumns: [], sql: null},
      error: error instanceof Error ? error.message : String(error),
      indexes: [],
      oldestNewest: {},
      rowCount: null,
      sizeProxies: {},
      table,
      whereClause: null,
    }
  }
}

const formatMarkdownTable = (headers: string[], rows: string[][]) => {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => {
      return `| ${row.join(' | ')} |`
    }),
  ].join('\n')
}

const formatValue = (value: unknown) => {
  return value === null || value === undefined ? '' : String(value).replaceAll('\n', ' ').replaceAll('|', '\\|')
}

const renderMarkdown = (report: EvidenceReport) => {
  const summaryRows = report.tables.map((table) => {
    return [
      `\`${table.table}\``,
      formatValue(table.rowCount),
      formatValue(table.columnCount),
      table.whereClause ? `\`${table.whereClause}\`` : 'global',
      formatValue(table.indexes.length),
      formatValue(table.duplicateProbe.duplicateCount),
      table.error ? `Blocked: ${table.error}` : 'ok',
    ]
  })
  const retentionCleanupEligibilityRows = report.retentionCleanupEligibility.tables.map((table) => {
    return [
      `\`${table.table}\``,
      formatValue(table.totalScopedRows),
      formatValue(table.activeOrLastKnownGoodSnapshotProtectedRows),
      formatValue(table.pinnedSnapshotProtectedRows),
      formatValue(table.completedRequestAndSummaryChunkCandidateRows),
      formatValue(table.protectedRebuildRequestRows),
      formatValue(table.newestDiagnosticRequestProtectedRows),
      formatValue(table.dependentPartialBlockedRows),
      formatValue(table.eligibleRows),
      table.error ? `Blocked: ${table.error}` : 'ok',
    ]
  })
  const selectedImportPayloadRows = report.selectedImportPayloadSlimmingReadiness.columns.map((column) => {
    return [
      `\`${column.column}\``,
      formatValue(column.selectedBaseNullCount),
      formatValue(column.selectedBaseNonNullCount),
      formatValue(column.hotFieldNullCount),
      formatValue(column.hotFieldNonNullCount),
    ]
  })

  const sections = report.tables.map((table) => {
    const timestampRows = Object.entries(table.oldestNewest).map(([column, values]) => {
      return [`\`${column}\``, formatValue(values.min), formatValue(values.max)]
    })
    const profileRows = table.columnProfiles.map((column) => {
      return [
        `\`${column.column}\``,
        `\`${column.type}\``,
        formatValue(column.nullCount),
        formatValue(column.nonNullCount),
        formatValue(column.approxDistinctCount),
      ]
    })
    const sizeRows = Object.entries(table.sizeProxies).map(([key, value]) => {
      return [`\`${key}\``, formatValue(value)]
    })

    return [
      `## ${table.table}`,
      '',
      `- Row count scope: ${table.whereClause ? `\`${table.whereClause}\`` : 'global table count'}`,
      `- Rows: ${formatValue(table.rowCount)}`,
      `- Columns: ${table.columnCount}`,
      `- Indexes observed: ${table.indexes.length}`,
      `- Duplicate key columns: ${table.duplicateProbe.keyColumns.map((column) => `\`${column}\``).join(', ') || 'not probed'}`,
      `- Duplicate key count: ${formatValue(table.duplicateProbe.duplicateCount)}`,
      table.error ? `- Error: ${table.error}` : null,
      '',
      timestampRows.length > 0
        ? formatMarkdownTable(['Timestamp column', 'Oldest', 'Newest'], timestampRows)
        : '_No timestamp columns from the evidence allowlist were present._',
      '',
      profileRows.length > 0
        ? formatMarkdownTable(['Column', 'Type', 'Nulls', 'Non-nulls', 'Approx distinct'], profileRows)
        : '_No column profile rows were collected._',
      '',
      sizeRows.length > 0 ? formatMarkdownTable(['Size proxy', 'Value'], sizeRows) : '_No JSON/payload size proxies collected._',
    ]
      .filter((entry): entry is string => {
        return entry !== null
      })
      .join('\n')
  })

  return [
    '# Review Storage Shape Physical Evidence',
    '',
    `Generated at: ${report.generatedAt}`,
    '',
    `Mode: ${report.mode}`,
    '',
    `Project ID: \`${report.options.projectId}\``,
    '',
    `Snapshot path used during collection: \`${report.snapshotPath}\``,
    '',
    'This file is a small follow-up evidence artifact for the storage-shape audit. It does not update `STORAGE_SHAPE_AUDIT_PLAN.md` and does not authorize deletion, slimming, or migration work by itself.',
    '',
    '## Table Summary',
    '',
    formatMarkdownTable(['Table', 'Rows', 'Columns', 'Scope', 'Indexes', 'Duplicate keys', 'Status'], summaryRows),
    '',
    '## Retention Cleanup Eligibility',
    '',
    report.retentionCleanupEligibility.note,
    '',
    formatMarkdownTable(
      [
        'Table',
        'Scoped rows',
        'Active/LKG protected',
        'Pinned protected',
        'Completed request+chunk candidates',
        'Protected request',
        'Newest diagnostic',
        'Dependent partial blocker',
        'Eligible',
        'Status',
      ],
      retentionCleanupEligibilityRows,
    ),
    '',
    '## Selected-Import Payload Slimming Readiness',
    '',
    `Verdict: ${report.selectedImportPayloadSlimmingReadiness.verdict === 'not-authorized' ? 'not deletion/slimming authorization' : 'blocked'}`,
    '',
    report.selectedImportPayloadSlimmingReadiness.note,
    '',
    `Selected-base scoped rows: ${formatValue(report.selectedImportPayloadSlimmingReadiness.selectedBaseScopedRows)}`,
    '',
    `Hot-field scoped rows: ${formatValue(report.selectedImportPayloadSlimmingReadiness.hotFieldScopedRows)}`,
    '',
    report.selectedImportPayloadSlimmingReadiness.comparisonStatus,
    '',
    report.selectedImportPayloadSlimmingReadiness.consumerWriterStatus,
    '',
    report.selectedImportPayloadSlimmingReadiness.error
      ? `Status: Blocked: ${report.selectedImportPayloadSlimmingReadiness.error}`
      : 'Status: ok',
    '',
    selectedImportPayloadRows.length > 0
      ? formatMarkdownTable(
          ['Column', 'Selected-base nulls', 'Selected-base non-nulls', 'Hot-field nulls', 'Hot-field non-nulls'],
          selectedImportPayloadRows,
        )
      : '_No selected-import payload evidence rows were collected._',
    '',
    ...sections,
    '',
  ].join('\n')
}

const emitReport = (report: EvidenceReport) => {
  const rendered = report.options.format === 'markdown' ? renderMarkdown(report) : JSON.stringify(report, null, 2)

  if (report.options.output) {
    writeFileSync(report.options.output, rendered)
    return
  }

  console.log(rendered)
}

const inspectPhysicalEvidence = (options: CliOptions) => {
  return Effect.acquireRelease(Effect.tryPromise(createDuckdbSnapshotForCli), deleteSnapshot).pipe(
    Effect.flatMap((snapshot) => {
      return Effect.acquireRelease(
        Effect.tryPromise(() => {
          return getSnapshotQueryRuntime(snapshot.snapshotPath)
        }),
        closeSnapshotQueryRuntime,
      ).pipe(
        Effect.flatMap((runtime) => {
          return Effect.tryPromise(async () => {
            const tables: TableEvidence[] = []

            for (const table of hotReviewServingTables) {
              tables.push(await getTableEvidence(runtime, table, options))
            }

            emitReport({
              generatedAt: new Date().toISOString(),
              mode: 'readonly-snapshot',
              options,
              retentionCleanupEligibility: await getRetentionCleanupEligibilityReport(runtime, options.projectId),
              selectedImportPayloadSlimmingReadiness: await getSelectedImportPayloadSlimmingReadinessReport(
                runtime,
                options.projectId,
              ),
              snapshotPath: snapshot.snapshotPath,
              tables,
            })
          })
        }),
      )
    }),
  )
}

if (import.meta.main) {
  await Effect.runPromise(Effect.scoped(inspectPhysicalEvidence(getCliOptions())))
}
