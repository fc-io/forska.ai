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
  summaryContributionServingReadiness: SummaryContributionServingReadinessReport
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
type RetentionCleanupEligibilityReport = {note: string; projectId: string; tables: RetentionCleanupEligibilityTable[]}
type SelectedImportPayloadColumnEvidence = {
  column: (typeof selectedImportPayloadColumns)[number]
  hotFieldNonNullCount: number | null
  hotFieldNullCount: number | null
  selectedBaseColumnStatus: 'active' | 'retired/dropped'
  selectedBaseActiveOrLastKnownGoodNonNullCount: number | null
  selectedBaseActiveOrLastKnownGoodNullCount: number | null
  selectedBaseCandidateNonNullCount: number | null
  selectedBaseCandidateNullCount: number | null
  selectedBaseNonNullCount: number | null
  selectedBaseOtherNonNullCount: number | null
  selectedBaseOtherNullCount: number | null
  selectedBaseNullCount: number | null
}
type SelectedImportDisplayCopyGlobalEvidence = {
  activeOrLastKnownGoodRows: number | null
  candidateRows: number | null
  columns: SelectedImportDisplayCopyGlobalColumnEvidence[]
  otherRows: number | null
  rows: SelectedImportDisplayCopyGlobalStatusRow[]
  totalRows: number | null
}
type SelectedImportDisplayCopyGlobalColumnEvidence = {
  column: (typeof selectedImportDisplayCopyColumns)[number]
  nonNullCount: number | null
  nullCount: number | null
  status: 'active' | 'retired/dropped'
}
type SelectedImportDisplayCopyGlobalStatusRow = {
  activeOrLastKnownGoodProtected: boolean
  candidateRows: number
  nonNullCounts: Record<(typeof selectedImportDisplayCopyColumns)[number], number | null>
  nullCounts: Record<(typeof selectedImportDisplayCopyColumns)[number], number | null>
  otherRows: number
  rowCount: number
  snapshotStatus: string
}
type SelectedImportDuplicateConflictGlobalEvidence = {
  activeOrLastKnownGoodRows: number | null
  candidateRows: number | null
  hotConflictTrueRows: number | null
  hotDuplicateTrueRows: number | null
  hotResolvedRows: number | null
  missingHotRows: number | null
  note: string
  otherRows: number | null
  rows: SelectedImportDuplicateConflictGlobalStatusRow[]
  selectedBaseConflictTrueRows: number | null
  selectedBaseDuplicateTrueRows: number | null
  selectedBaseFalseOrDefaultConflictRowsWithoutHot: number | null
  selectedBaseFalseOrDefaultDuplicateRowsWithoutHot: number | null
  selectedBaseTrueConflictRowsWithoutHot: number | null
  selectedBaseTrueDuplicateRowsWithoutHot: number | null
  totalRows: number | null
  conflictMismatchRows: number | null
  duplicateMismatchRows: number | null
}
type SelectedImportDuplicateConflictGlobalStatusRow = {
  activeOrLastKnownGoodProtected: boolean
  candidateRows: number
  conflictMismatchRows: number
  duplicateMismatchRows: number
  hotConflictTrueRows: number
  hotDuplicateTrueRows: number
  hotResolvedRows: number
  missingHotRows: number
  otherRows: number
  rowCount: number
  selectedBaseConflictTrueRows: number
  selectedBaseDuplicateTrueRows: number
  selectedBaseFalseOrDefaultConflictRowsWithoutHot: number
  selectedBaseFalseOrDefaultDuplicateRowsWithoutHot: number
  selectedBaseTrueConflictRowsWithoutHot: number
  selectedBaseTrueDuplicateRowsWithoutHot: number
  snapshotStatus: string
}
type SelectedImportPayloadSnapshotStatusRow = {label: string; rowCount: number}
type SelectedImportPayloadSlimmingReadinessReport = {
  activeOrLastKnownGoodSelectedImportRows: number | null
  candidateSelectedImportRows: number | null
  comparisonStatus: string
  consumerWriterStatus: string
  error: string | null
  hotFieldScopedRows: number | null
  note: string
  otherSelectedImportRows: number | null
  projectId: string
  selectedBaseScopedRows: number | null
  selectedImportDuplicateConflictGlobalEvidence: SelectedImportDuplicateConflictGlobalEvidence
  selectedImportDisplayCopyGlobalEvidence: SelectedImportDisplayCopyGlobalEvidence
  rowsBySelectedImportSnapshotStatus: SelectedImportPayloadSnapshotStatusRow[]
  verdict: 'not-authorized' | 'blocked'
  columns: SelectedImportPayloadColumnEvidence[]
}
type SummaryContributionServingDuplicateProbe = {duplicateCount: number | null; keyColumns: string[]; label: string}
type SummaryContributionServingAggregateRecoverability = {
  contributionGroups: number | null
  error: string | null
  finalRows: number | null
  finalRowsMissingContributionGroup: number | null
  matchedFinalRows: number | null
  missingFinalRows: number | null
  mismatchedFinalRows: number | null
  note: string
  summaryKind: 'count' | 'facet'
}
type SummaryContributionServingPartialOverlap = {
  contributionRows: number | null
  error: string | null
  exactCommonColumnOverlapRows: number | null
  note: string
  partialRows: number | null
  partialRowsWithExactCommonContribution: number | null
}
type SummaryContributionServingRowCount = {label: string; rowCount: number}
type SummaryContributionServingProjectRowCount = SummaryContributionServingRowCount & {projectId: string}
type SummaryContributionServingReadinessReport = {
  activeOrLastKnownGoodSnapshotProtectedRows: number | null
  columnCount: number | null
  columns: TableColumn[]
  duplicateProbes: SummaryContributionServingDuplicateProbe[]
  error: string | null
  globalRowCount: number | null
  indexes: unknown[]
  missingSnapshotManifestRows: number | null
  nonzeroProjectCount: number | null
  note: string
  partialRebuildOverlap: SummaryContributionServingPartialOverlap
  pinnedSnapshotRows: number | null
  recoverabilityClassification: string
  recoverabilityComparisons: SummaryContributionServingAggregateRecoverability[]
  rowsByComponentKind: SummaryContributionServingRowCount[]
  rowsByProject: SummaryContributionServingProjectRowCount[]
  rowsBySnapshotStatus: SummaryContributionServingRowCount[]
  rowsBySummaryDefinitionVersion: SummaryContributionServingRowCount[]
  table: 'mart.review_article_summary_contribution_v4'
  topContributionKeys: SummaryContributionServingRowCount[]
  topProjects: {projectId: string; rowCount: number}[]
  verdict: 'not-authorized' | 'blocked'
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
  'mart.review_article_summary_contribution_v4': [
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'article_id',
    'component_kind',
    'summary_definition_version',
    'contribution_key',
  ],
  'mart.review_article_serving_v4': ['project_id', 'review_config_hash', 'snapshot_id', 'list_mode_key', 'article_id'],
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

const selectedImportDisplayCopyColumns = ['publication_year', 'article_title', 'journal_title', 'external_id'] as const

const getNullSelectedBaseColumnExpressions = (column: string) => {
  return `NULL::BIGINT AS selectedBase_${column}_nullCount,
        NULL::BIGINT AS selectedBase_${column}_nonNullCount,
        NULL::BIGINT AS selectedBase_${column}_activeOrLastKnownGoodNullCount,
        NULL::BIGINT AS selectedBase_${column}_activeOrLastKnownGoodNonNullCount,
        NULL::BIGINT AS selectedBase_${column}_candidateNullCount,
        NULL::BIGINT AS selectedBase_${column}_candidateNonNullCount,
        NULL::BIGINT AS selectedBase_${column}_otherNullCount,
        NULL::BIGINT AS selectedBase_${column}_otherNonNullCount`
}

const getSelectedBaseColumnExpressions = (column: string, presentColumns: ReadonlySet<string>) => {
  if (!presentColumns.has(column)) {
    return getNullSelectedBaseColumnExpressions(column)
  }

  return `CAST(COUNT(*) FILTER (WHERE selected_base.${column} IS NULL) AS BIGINT) AS selectedBase_${column}_nullCount,
        CAST(COUNT(*) FILTER (WHERE selected_base.${column} IS NOT NULL) AS BIGINT) AS selectedBase_${column}_nonNullCount,
        CAST(COUNT(*) FILTER (WHERE selected_base.protection_bucket = 'active-or-last-known-good' AND selected_base.${column} IS NULL) AS BIGINT) AS selectedBase_${column}_activeOrLastKnownGoodNullCount,
        CAST(COUNT(*) FILTER (WHERE selected_base.protection_bucket = 'active-or-last-known-good' AND selected_base.${column} IS NOT NULL) AS BIGINT) AS selectedBase_${column}_activeOrLastKnownGoodNonNullCount,
        CAST(COUNT(*) FILTER (WHERE selected_base.protection_bucket = 'candidate' AND selected_base.${column} IS NULL) AS BIGINT) AS selectedBase_${column}_candidateNullCount,
        CAST(COUNT(*) FILTER (WHERE selected_base.protection_bucket = 'candidate' AND selected_base.${column} IS NOT NULL) AS BIGINT) AS selectedBase_${column}_candidateNonNullCount,
        CAST(COUNT(*) FILTER (WHERE selected_base.protection_bucket = 'other' AND selected_base.${column} IS NULL) AS BIGINT) AS selectedBase_${column}_otherNullCount,
        CAST(COUNT(*) FILTER (WHERE selected_base.protection_bucket = 'other' AND selected_base.${column} IS NOT NULL) AS BIGINT) AS selectedBase_${column}_otherNonNullCount`
}

const getGlobalDisplayCopyExpressions = (
  column: (typeof selectedImportDisplayCopyColumns)[number],
  presentColumns: ReadonlySet<string>,
) => {
  if (!presentColumns.has(column)) {
    return `NULL::BIGINT AS ${column}_nullCount,
        NULL::BIGINT AS ${column}_nonNullCount`
  }

  return `CAST(COUNT(*) FILTER (WHERE selected_base.${column} IS NULL) AS BIGINT) AS ${column}_nullCount,
        CAST(COUNT(*) FILTER (WHERE selected_base.${column} IS NOT NULL) AS BIGINT) AS ${column}_nonNullCount`
}

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

const getOldestNewest = async (
  runtime: QueryRuntime,
  table: string,
  columns: TableColumn[],
  whereClause: string | null,
) => {
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

const getSizeProxies = async (
  runtime: QueryRuntime,
  table: string,
  columns: TableColumn[],
  whereClause: string | null,
) => {
  const expressions = columns
    .filter((column) => {
      return (
        column.column_name.endsWith('_json')
        || column.column_name.endsWith('_payload')
        || column.column_name === 'payload'
      )
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

const getDuplicateProbe = async (
  runtime: QueryRuntime,
  table: string,
  columns: TableColumn[],
  whereClause: string | null,
) => {
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

const getRetentionCleanupEligibilitySql = (
  table: (typeof retentionCleanupEligibilityTables)[number],
  projectId: string,
) => {
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
      activeOrLastKnownGoodSnapshotProtectedRows: getNumberOrNull(row?.activeOrLastKnownGoodSnapshotProtectedRows),
      completedRequestAndSummaryChunkCandidateRows: getNumberOrNull(row?.completedRequestAndSummaryChunkCandidateRows),
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
  const hotFieldExpressions = selectedImportPayloadColumns
    .map((column) => {
      return `CAST(COUNT(*) FILTER (WHERE hot_field.${column} IS NULL) AS BIGINT) AS hotField_${column}_nullCount,
        CAST(COUNT(*) FILTER (WHERE hot_field.${column} IS NOT NULL) AS BIGINT) AS hotField_${column}_nonNullCount`
    })
    .join(',\n        ')
  const emptyGlobalDisplayCopyEvidence: SelectedImportDisplayCopyGlobalEvidence = {
    activeOrLastKnownGoodRows: null,
    candidateRows: null,
    columns: [],
    otherRows: null,
    rows: [],
    totalRows: null,
  }
  const emptyDuplicateConflictEvidence: SelectedImportDuplicateConflictGlobalEvidence = {
    activeOrLastKnownGoodRows: null,
    candidateRows: null,
    conflictMismatchRows: null,
    duplicateMismatchRows: null,
    hotConflictTrueRows: null,
    hotDuplicateTrueRows: null,
    hotResolvedRows: null,
    missingHotRows: null,
    note: 'Duplicate/conflict fallback evidence was not collected.',
    otherRows: null,
    rows: [],
    selectedBaseConflictTrueRows: null,
    selectedBaseDuplicateTrueRows: null,
    selectedBaseFalseOrDefaultConflictRowsWithoutHot: null,
    selectedBaseFalseOrDefaultDuplicateRowsWithoutHot: null,
    selectedBaseTrueConflictRowsWithoutHot: null,
    selectedBaseTrueDuplicateRowsWithoutHot: null,
    totalRows: null,
  }

  try {
    const selectedBaseColumnRows = await runReadonlyQuery<{columnName: string}>(
      runtime,
      `
        SELECT column_name AS "columnName"
        FROM information_schema.columns
        WHERE table_schema = 'app'
          AND table_name = 'review_selected_article_import_v4'
      `,
    )
    const selectedBaseColumnNames = new Set(
      selectedBaseColumnRows.map((row) => {
        return row.columnName
      }),
    )
    const selectedBaseExpressions = selectedImportPayloadColumns
      .map((column) => {
        return getSelectedBaseColumnExpressions(column, selectedBaseColumnNames)
      })
      .join(',\n        ')
    const globalDisplayCopyExpressions = selectedImportDisplayCopyColumns
      .map((column) => {
        return getGlobalDisplayCopyExpressions(column, selectedBaseColumnNames)
      })
      .join(',\n        ')
    const selectedBaseRows = await runReadonlyQuery<Record<string, number | string | null>>(
      runtime,
      `
        WITH active_manifest AS (
          SELECT
            manifest.project_id,
            manifest.selected_import_snapshot_id,
            manifest.last_known_good_snapshot_id
          FROM app.review_serving_snapshot_manifest manifest
          WHERE manifest.project_id = ${getSqlLiteral(projectId)}
            AND manifest.snapshot_status = 'active'
        ),
        protected_selected_import_snapshot AS (
          SELECT selected_import_snapshot_id
          FROM active_manifest
          WHERE selected_import_snapshot_id IS NOT NULL
          UNION
          SELECT last_known_good_manifest.selected_import_snapshot_id
          FROM active_manifest
          INNER JOIN app.review_serving_snapshot_manifest last_known_good_manifest
            ON last_known_good_manifest.project_id = active_manifest.project_id
            AND last_known_good_manifest.snapshot_id = active_manifest.last_known_good_snapshot_id
          WHERE last_known_good_manifest.selected_import_snapshot_id IS NOT NULL
        ),
        selected_base AS (
          SELECT
            raw_selected_base.*,
            CASE
              WHEN protected_selected_import_snapshot.selected_import_snapshot_id IS NOT NULL
                THEN 'active-or-last-known-good'
              WHEN COALESCE(selected_import_snapshot.status, 'missing-selected-import-snapshot') = 'candidate'
                THEN 'candidate'
              ELSE 'other'
            END AS protection_bucket
          FROM app.review_selected_article_import_v4 raw_selected_base
          LEFT JOIN app.review_selected_import_snapshot selected_import_snapshot
            ON selected_import_snapshot.project_id = raw_selected_base.project_id
            AND selected_import_snapshot.project_scope_identity = raw_selected_base.project_scope_identity
            AND selected_import_snapshot.selected_import_snapshot_id = raw_selected_base.selected_import_snapshot_id
          LEFT JOIN protected_selected_import_snapshot
            ON protected_selected_import_snapshot.selected_import_snapshot_id = raw_selected_base.selected_import_snapshot_id
          WHERE raw_selected_base.project_id = ${getSqlLiteral(projectId)}
        )
        SELECT
          CAST(COUNT(*) AS BIGINT) AS selectedBaseScopedRows,
          CAST(COUNT(*) FILTER (WHERE protection_bucket = 'active-or-last-known-good') AS BIGINT) AS activeOrLastKnownGoodSelectedImportRows,
          CAST(COUNT(*) FILTER (WHERE protection_bucket = 'candidate') AS BIGINT) AS candidateSelectedImportRows,
          CAST(COUNT(*) FILTER (WHERE protection_bucket = 'other') AS BIGINT) AS otherSelectedImportRows,
          ${selectedBaseExpressions}
        FROM selected_base
      `,
    )
    const snapshotStatusRows = await runReadonlyQuery<{rowCount: number | string; snapshotStatus: string | null}>(
      runtime,
      `
        SELECT
          COALESCE(selected_import_snapshot.status, 'missing-selected-import-snapshot') AS snapshotStatus,
          CAST(COUNT(*) AS BIGINT) AS rowCount
        FROM app.review_selected_article_import_v4 selected_base
        LEFT JOIN app.review_selected_import_snapshot selected_import_snapshot
          ON selected_import_snapshot.project_id = selected_base.project_id
          AND selected_import_snapshot.project_scope_identity = selected_base.project_scope_identity
          AND selected_import_snapshot.selected_import_snapshot_id = selected_base.selected_import_snapshot_id
        WHERE selected_base.project_id = ${getSqlLiteral(projectId)}
        GROUP BY 1
        ORDER BY COUNT(*) DESC, snapshotStatus
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
    const globalDisplayCopyRows = await runReadonlyQuery<Record<string, number | string | boolean | null>>(
      runtime,
      `
        WITH active_manifest AS (
          SELECT
            manifest.project_id,
            manifest.selected_import_snapshot_id,
            manifest.last_known_good_snapshot_id
          FROM app.review_serving_snapshot_manifest manifest
          WHERE manifest.snapshot_status = 'active'
        ),
        protected_selected_import_snapshot AS (
          SELECT
            project_id,
            selected_import_snapshot_id
          FROM active_manifest
          WHERE selected_import_snapshot_id IS NOT NULL
          UNION
          SELECT
            active_manifest.project_id,
            last_known_good_manifest.selected_import_snapshot_id
          FROM active_manifest
          INNER JOIN app.review_serving_snapshot_manifest last_known_good_manifest
            ON last_known_good_manifest.project_id = active_manifest.project_id
            AND last_known_good_manifest.snapshot_id = active_manifest.last_known_good_snapshot_id
          WHERE last_known_good_manifest.selected_import_snapshot_id IS NOT NULL
        ),
        selected_base AS (
          SELECT
            raw_selected_base.*,
            COALESCE(selected_import_snapshot.status, 'missing-selected-import-snapshot') AS snapshot_status,
            protected_selected_import_snapshot.selected_import_snapshot_id IS NOT NULL AS active_or_last_known_good_protected
          FROM app.review_selected_article_import_v4 raw_selected_base
          LEFT JOIN app.review_selected_import_snapshot selected_import_snapshot
            ON selected_import_snapshot.project_id = raw_selected_base.project_id
            AND selected_import_snapshot.project_scope_identity = raw_selected_base.project_scope_identity
            AND selected_import_snapshot.selected_import_snapshot_id = raw_selected_base.selected_import_snapshot_id
          LEFT JOIN protected_selected_import_snapshot
            ON protected_selected_import_snapshot.project_id = raw_selected_base.project_id
            AND protected_selected_import_snapshot.selected_import_snapshot_id = raw_selected_base.selected_import_snapshot_id
        )
        SELECT
          snapshot_status AS snapshotStatus,
          active_or_last_known_good_protected AS activeOrLastKnownGoodProtected,
          CAST(COUNT(*) AS BIGINT) AS rowCount,
          CAST(COUNT(*) FILTER (WHERE active_or_last_known_good_protected) AS BIGINT) AS activeOrLastKnownGoodRows,
          CAST(COUNT(*) FILTER (WHERE snapshot_status = 'candidate') AS BIGINT) AS candidateRows,
          CAST(COUNT(*) FILTER (WHERE NOT active_or_last_known_good_protected AND snapshot_status <> 'candidate') AS BIGINT) AS otherRows,
          ${globalDisplayCopyExpressions}
        FROM selected_base
        GROUP BY 1, 2
        ORDER BY COUNT(*) DESC, snapshot_status, active_or_last_known_good_protected DESC
      `,
    )
    const duplicateConflictRows = await runReadonlyQuery<Record<string, number | string | boolean | null>>(
      runtime,
      `
        WITH active_manifest AS (
          SELECT
            manifest.project_id,
            manifest.selected_import_snapshot_id,
            manifest.last_known_good_snapshot_id
          FROM app.review_serving_snapshot_manifest manifest
          WHERE manifest.snapshot_status = 'active'
        ),
        protected_selected_import_snapshot AS (
          SELECT
            project_id,
            selected_import_snapshot_id
          FROM active_manifest
          WHERE selected_import_snapshot_id IS NOT NULL
          UNION
          SELECT
            active_manifest.project_id,
            last_known_good_manifest.selected_import_snapshot_id
          FROM active_manifest
          INNER JOIN app.review_serving_snapshot_manifest last_known_good_manifest
            ON last_known_good_manifest.project_id = active_manifest.project_id
            AND last_known_good_manifest.snapshot_id = active_manifest.last_known_good_snapshot_id
          WHERE last_known_good_manifest.selected_import_snapshot_id IS NOT NULL
        ),
        selected_base AS (
          SELECT
            raw_selected_base.*,
            COALESCE(selected_import_snapshot.status, 'missing-selected-import-snapshot') AS snapshot_status,
            protected_selected_import_snapshot.selected_import_snapshot_id IS NOT NULL AS active_or_last_known_good_protected
          FROM app.review_selected_article_import_v4 raw_selected_base
          LEFT JOIN app.review_selected_import_snapshot selected_import_snapshot
            ON selected_import_snapshot.project_id = raw_selected_base.project_id
            AND selected_import_snapshot.project_scope_identity = raw_selected_base.project_scope_identity
            AND selected_import_snapshot.selected_import_snapshot_id = raw_selected_base.selected_import_snapshot_id
          LEFT JOIN protected_selected_import_snapshot
            ON protected_selected_import_snapshot.project_id = raw_selected_base.project_id
            AND protected_selected_import_snapshot.selected_import_snapshot_id = raw_selected_base.selected_import_snapshot_id
        ),
        selected_with_hot AS (
          SELECT
            selected_base.*,
            hot_field.source_record_key IS NOT NULL AS hot_resolved,
            hot_field.duplicate_flag AS hot_duplicate_flag,
            hot_field.conflict_flag AS hot_conflict_flag
          FROM selected_base
          LEFT JOIN app.review_import_article_hot_field hot_field
            ON hot_field.import_route_id = selected_base.import_route_id
            AND hot_field.article_id = selected_base.article_id
            AND hot_field.source_record_key = selected_base.source_record_key
        )
        SELECT
          snapshot_status AS snapshotStatus,
          active_or_last_known_good_protected AS activeOrLastKnownGoodProtected,
          CAST(COUNT(*) AS BIGINT) AS rowCount,
          CAST(COUNT(*) FILTER (WHERE active_or_last_known_good_protected) AS BIGINT) AS activeOrLastKnownGoodRows,
          CAST(COUNT(*) FILTER (WHERE snapshot_status = 'candidate') AS BIGINT) AS candidateRows,
          CAST(COUNT(*) FILTER (WHERE NOT active_or_last_known_good_protected AND snapshot_status <> 'candidate') AS BIGINT) AS otherRows,
          CAST(COUNT(*) FILTER (WHERE hot_resolved) AS BIGINT) AS hotResolvedRows,
          CAST(COUNT(*) FILTER (WHERE NOT hot_resolved) AS BIGINT) AS missingHotRows,
          CAST(COUNT(*) FILTER (WHERE duplicate_flag = TRUE) AS BIGINT) AS selectedBaseDuplicateTrueRows,
          CAST(COUNT(*) FILTER (WHERE conflict_flag = TRUE) AS BIGINT) AS selectedBaseConflictTrueRows,
          CAST(COUNT(*) FILTER (WHERE hot_duplicate_flag = TRUE) AS BIGINT) AS hotDuplicateTrueRows,
          CAST(COUNT(*) FILTER (WHERE hot_conflict_flag = TRUE) AS BIGINT) AS hotConflictTrueRows,
          CAST(COUNT(*) FILTER (WHERE duplicate_flag IS DISTINCT FROM hot_duplicate_flag) AS BIGINT) AS duplicateMismatchRows,
          CAST(COUNT(*) FILTER (WHERE conflict_flag IS DISTINCT FROM hot_conflict_flag) AS BIGINT) AS conflictMismatchRows,
          CAST(COUNT(*) FILTER (WHERE NOT hot_resolved AND duplicate_flag = TRUE) AS BIGINT) AS selectedBaseTrueDuplicateRowsWithoutHot,
          CAST(COUNT(*) FILTER (WHERE NOT hot_resolved AND conflict_flag = TRUE) AS BIGINT) AS selectedBaseTrueConflictRowsWithoutHot,
          CAST(COUNT(*) FILTER (WHERE NOT hot_resolved AND COALESCE(duplicate_flag, FALSE) = FALSE) AS BIGINT) AS selectedBaseFalseOrDefaultDuplicateRowsWithoutHot,
          CAST(COUNT(*) FILTER (WHERE NOT hot_resolved AND COALESCE(conflict_flag, FALSE) = FALSE) AS BIGINT) AS selectedBaseFalseOrDefaultConflictRowsWithoutHot
        FROM selected_with_hot
        GROUP BY 1, 2
        ORDER BY COUNT(*) DESC, snapshot_status, active_or_last_known_good_protected DESC
      `,
    )
    const selectedBaseRow = selectedBaseRows[0] ?? {}
    const hotFieldRow = hotFieldRows[0] ?? {}
    const globalDisplayCopyTotals = globalDisplayCopyRows.reduce(
      (totals, row) => {
        totals.totalRows += Number(row.rowCount ?? 0)
        totals.activeOrLastKnownGoodRows += Number(row.activeOrLastKnownGoodRows ?? 0)
        totals.candidateRows += Number(row.candidateRows ?? 0)
        totals.otherRows += Number(row.otherRows ?? 0)

        for (const column of selectedImportDisplayCopyColumns) {
          if (selectedBaseColumnNames.has(column)) {
            totals.nullCounts[column] += Number(row[`${column}_nullCount`] ?? 0)
            totals.nonNullCounts[column] += Number(row[`${column}_nonNullCount`] ?? 0)
          }
        }

        return totals
      },
      {
        activeOrLastKnownGoodRows: 0,
        candidateRows: 0,
        nonNullCounts: Object.fromEntries(
          selectedImportDisplayCopyColumns.map((column) => {
            return [column, 0]
          }),
        ) as Record<(typeof selectedImportDisplayCopyColumns)[number], number>,
        nullCounts: Object.fromEntries(
          selectedImportDisplayCopyColumns.map((column) => {
            return [column, 0]
          }),
        ) as Record<(typeof selectedImportDisplayCopyColumns)[number], number>,
        otherRows: 0,
        totalRows: 0,
      },
    )
    const selectedImportDisplayCopyGlobalEvidence: SelectedImportDisplayCopyGlobalEvidence = {
      activeOrLastKnownGoodRows: globalDisplayCopyTotals.activeOrLastKnownGoodRows,
      candidateRows: globalDisplayCopyTotals.candidateRows,
      columns: selectedImportDisplayCopyColumns.map((column) => {
        return {
          column,
          nonNullCount: selectedBaseColumnNames.has(column) ? globalDisplayCopyTotals.nonNullCounts[column] : null,
          nullCount: selectedBaseColumnNames.has(column) ? globalDisplayCopyTotals.nullCounts[column] : null,
          status: selectedBaseColumnNames.has(column) ? 'active' : 'retired/dropped',
        }
      }),
      otherRows: globalDisplayCopyTotals.otherRows,
      rows: globalDisplayCopyRows.map((row) => {
        return {
          activeOrLastKnownGoodProtected: Boolean(row.activeOrLastKnownGoodProtected),
          candidateRows: Number(row.candidateRows ?? 0),
          nonNullCounts: Object.fromEntries(
            selectedImportDisplayCopyColumns.map((column) => {
              return [column, selectedBaseColumnNames.has(column) ? Number(row[`${column}_nonNullCount`] ?? 0) : null]
            }),
          ) as Record<(typeof selectedImportDisplayCopyColumns)[number], number | null>,
          nullCounts: Object.fromEntries(
            selectedImportDisplayCopyColumns.map((column) => {
              return [column, selectedBaseColumnNames.has(column) ? Number(row[`${column}_nullCount`] ?? 0) : null]
            }),
          ) as Record<(typeof selectedImportDisplayCopyColumns)[number], number | null>,
          otherRows: Number(row.otherRows ?? 0),
          rowCount: Number(row.rowCount ?? 0),
          snapshotStatus: String(row.snapshotStatus ?? 'NULL'),
        }
      }),
      totalRows: globalDisplayCopyTotals.totalRows,
    }
    const duplicateConflictTotals = duplicateConflictRows.reduce(
      (totals, row) => {
        totals.totalRows += Number(row.rowCount ?? 0)
        totals.activeOrLastKnownGoodRows += Number(row.activeOrLastKnownGoodRows ?? 0)
        totals.candidateRows += Number(row.candidateRows ?? 0)
        totals.otherRows += Number(row.otherRows ?? 0)
        totals.hotResolvedRows += Number(row.hotResolvedRows ?? 0)
        totals.missingHotRows += Number(row.missingHotRows ?? 0)
        totals.selectedBaseDuplicateTrueRows += Number(row.selectedBaseDuplicateTrueRows ?? 0)
        totals.selectedBaseConflictTrueRows += Number(row.selectedBaseConflictTrueRows ?? 0)
        totals.hotDuplicateTrueRows += Number(row.hotDuplicateTrueRows ?? 0)
        totals.hotConflictTrueRows += Number(row.hotConflictTrueRows ?? 0)
        totals.duplicateMismatchRows += Number(row.duplicateMismatchRows ?? 0)
        totals.conflictMismatchRows += Number(row.conflictMismatchRows ?? 0)
        totals.selectedBaseTrueDuplicateRowsWithoutHot += Number(row.selectedBaseTrueDuplicateRowsWithoutHot ?? 0)
        totals.selectedBaseTrueConflictRowsWithoutHot += Number(row.selectedBaseTrueConflictRowsWithoutHot ?? 0)
        totals.selectedBaseFalseOrDefaultDuplicateRowsWithoutHot += Number(
          row.selectedBaseFalseOrDefaultDuplicateRowsWithoutHot ?? 0,
        )
        totals.selectedBaseFalseOrDefaultConflictRowsWithoutHot += Number(
          row.selectedBaseFalseOrDefaultConflictRowsWithoutHot ?? 0,
        )

        return totals
      },
      {
        activeOrLastKnownGoodRows: 0,
        candidateRows: 0,
        conflictMismatchRows: 0,
        duplicateMismatchRows: 0,
        hotConflictTrueRows: 0,
        hotDuplicateTrueRows: 0,
        hotResolvedRows: 0,
        missingHotRows: 0,
        otherRows: 0,
        selectedBaseConflictTrueRows: 0,
        selectedBaseDuplicateTrueRows: 0,
        selectedBaseFalseOrDefaultConflictRowsWithoutHot: 0,
        selectedBaseFalseOrDefaultDuplicateRowsWithoutHot: 0,
        selectedBaseTrueConflictRowsWithoutHot: 0,
        selectedBaseTrueDuplicateRowsWithoutHot: 0,
        totalRows: 0,
      },
    )
    const selectedImportDuplicateConflictGlobalEvidence: SelectedImportDuplicateConflictGlobalEvidence = {
      ...duplicateConflictTotals,
      note: 'Duplicate/conflict evidence is read-only fallback readiness only. Hot rows are resolved from selected-base identity `(import_route_id, article_id, source_record_key)`. `IS DISTINCT FROM` mismatches include unresolved hot rows where hot flags are NULL while selected-base flags provide TRUE/FALSE or default FALSE fallback values. Selected-base flag writers and selected-base fallback/default semantics remain required when hot rows do not resolve; this is not schema removal authorization.',
      rows: duplicateConflictRows.map((row) => {
        return {
          activeOrLastKnownGoodProtected: Boolean(row.activeOrLastKnownGoodProtected),
          candidateRows: Number(row.candidateRows ?? 0),
          conflictMismatchRows: Number(row.conflictMismatchRows ?? 0),
          duplicateMismatchRows: Number(row.duplicateMismatchRows ?? 0),
          hotConflictTrueRows: Number(row.hotConflictTrueRows ?? 0),
          hotDuplicateTrueRows: Number(row.hotDuplicateTrueRows ?? 0),
          hotResolvedRows: Number(row.hotResolvedRows ?? 0),
          missingHotRows: Number(row.missingHotRows ?? 0),
          otherRows: Number(row.otherRows ?? 0),
          rowCount: Number(row.rowCount ?? 0),
          selectedBaseConflictTrueRows: Number(row.selectedBaseConflictTrueRows ?? 0),
          selectedBaseDuplicateTrueRows: Number(row.selectedBaseDuplicateTrueRows ?? 0),
          selectedBaseFalseOrDefaultConflictRowsWithoutHot: Number(
            row.selectedBaseFalseOrDefaultConflictRowsWithoutHot ?? 0,
          ),
          selectedBaseFalseOrDefaultDuplicateRowsWithoutHot: Number(
            row.selectedBaseFalseOrDefaultDuplicateRowsWithoutHot ?? 0,
          ),
          selectedBaseTrueConflictRowsWithoutHot: Number(row.selectedBaseTrueConflictRowsWithoutHot ?? 0),
          selectedBaseTrueDuplicateRowsWithoutHot: Number(row.selectedBaseTrueDuplicateRowsWithoutHot ?? 0),
          snapshotStatus: String(row.snapshotStatus ?? 'NULL'),
        }
      }),
    }

    return {
      activeOrLastKnownGoodSelectedImportRows: getNumberOrNull(selectedBaseRow.activeOrLastKnownGoodSelectedImportRows),
      candidateSelectedImportRows: getNumberOrNull(selectedBaseRow.candidateSelectedImportRows),
      columns: selectedImportPayloadColumns.map((column) => {
        return {
          column,
          hotFieldNonNullCount: getNumberOrNull(hotFieldRow[`hotField_${column}_nonNullCount`]),
          hotFieldNullCount: getNumberOrNull(hotFieldRow[`hotField_${column}_nullCount`]),
          selectedBaseColumnStatus: selectedBaseColumnNames.has(column) ? 'active' : 'retired/dropped',
          selectedBaseActiveOrLastKnownGoodNonNullCount: getNumberOrNull(
            selectedBaseRow[`selectedBase_${column}_activeOrLastKnownGoodNonNullCount`],
          ),
          selectedBaseActiveOrLastKnownGoodNullCount: getNumberOrNull(
            selectedBaseRow[`selectedBase_${column}_activeOrLastKnownGoodNullCount`],
          ),
          selectedBaseCandidateNonNullCount: getNumberOrNull(
            selectedBaseRow[`selectedBase_${column}_candidateNonNullCount`],
          ),
          selectedBaseCandidateNullCount: getNumberOrNull(selectedBaseRow[`selectedBase_${column}_candidateNullCount`]),
          selectedBaseNonNullCount: getNumberOrNull(selectedBaseRow[`selectedBase_${column}_nonNullCount`]),
          selectedBaseOtherNonNullCount: getNumberOrNull(selectedBaseRow[`selectedBase_${column}_otherNonNullCount`]),
          selectedBaseOtherNullCount: getNumberOrNull(selectedBaseRow[`selectedBase_${column}_otherNullCount`]),
          selectedBaseNullCount: getNumberOrNull(selectedBaseRow[`selectedBase_${column}_nullCount`]),
        }
      }),
      comparisonStatus:
        'Selected-base counts are split into active/LKG protected selected-import rows, candidate selected-import rows, and other rows. Retired/dropped selected-base columns report null counts instead of binding the absent physical columns. Hot-field counts are scoped through app.project_import_route for the same project. Non-null hot-field values with null selected-base values mean source data exists but the selected-base projection did not carry it for this scoped snapshot.',
      consumerWriterStatus:
        'Current code no longer writes or consumes selected-base display-copy values for publication_year, article_title, journal_title, and external_id. Post-drop databases report those columns as retired/dropped. Selected-base identity/rank/source fields remain active runtime state.',
      error: null,
      hotFieldScopedRows: getNumberOrNull(hotFieldRow.hotFieldScopedRows),
      note: 'This section is not broad deletion/slimming authorization. It is a regression/readiness check for selected-base display-copy write suppression and the bounded display-copy schema drop; identity/rank/source fields remain active.',
      otherSelectedImportRows: getNumberOrNull(selectedBaseRow.otherSelectedImportRows),
      projectId,
      rowsBySelectedImportSnapshotStatus: snapshotStatusRows.map((row) => {
        return {label: String(row.snapshotStatus ?? 'NULL'), rowCount: Number(row.rowCount ?? 0)}
      }),
      selectedBaseScopedRows: getNumberOrNull(selectedBaseRow.selectedBaseScopedRows),
      selectedImportDuplicateConflictGlobalEvidence,
      selectedImportDisplayCopyGlobalEvidence,
      verdict: 'not-authorized',
    }
  } catch (error) {
    return {
      activeOrLastKnownGoodSelectedImportRows: null,
      candidateSelectedImportRows: null,
      columns: [],
      comparisonStatus: 'Blocked before source/hot-field comparison could be collected.',
      consumerWriterStatus:
        'Selected-import payload evidence collection failed; this cannot authorize schema slimming or deletion.',
      error: error instanceof Error ? error.message : String(error),
      hotFieldScopedRows: null,
      note: 'This section is not deletion/slimming authorization.',
      otherSelectedImportRows: null,
      projectId,
      rowsBySelectedImportSnapshotStatus: [],
      selectedBaseScopedRows: null,
      selectedImportDuplicateConflictGlobalEvidence: emptyDuplicateConflictEvidence,
      selectedImportDisplayCopyGlobalEvidence: emptyGlobalDisplayCopyEvidence,
      verdict: 'blocked',
    }
  }
}

const getDuplicateCountForColumns = async (
  runtime: QueryRuntime,
  table: string,
  keyColumns: string[],
  whereClause: string | null,
) => {
  const keySql = keyColumns
    .map((columnName) => {
      return `"${columnName}"`
    })
    .join(', ')
  const rows = await runReadonlyQuery<{duplicateCount: number | string}>(
    runtime,
    `
      WITH duplicate_keys AS (
        SELECT ${keySql}
        FROM ${table}
        ${whereClause ? `WHERE ${whereClause}` : ''}
        GROUP BY ${keySql}
        HAVING COUNT(*) > 1
      )
      SELECT CAST(COUNT(*) AS BIGINT) AS duplicateCount
      FROM duplicate_keys
    `,
  )

  return Number(rows[0]?.duplicateCount ?? 0)
}

const getSummaryContributionServingGroupedRows = async (
  runtime: QueryRuntime,
  table: string,
  expression: string,
  alias: string,
  limit: number | null,
) => {
  const rows = await runReadonlyQuery<Record<string, number | string | null>>(
    runtime,
    `
      SELECT ${expression} AS "${alias}", CAST(COUNT(*) AS BIGINT) AS rowCount
      FROM ${table}
      GROUP BY 1
      HAVING COUNT(*) > 0
      ORDER BY COUNT(*) DESC, "${alias}"
      ${limit === null ? '' : `LIMIT ${Math.max(1, limit)}`}
    `,
  )

  return rows.map((row) => {
    return {label: String(row[alias] ?? 'NULL'), rowCount: Number(row.rowCount ?? 0)}
  })
}

const getSummaryContributionServingAggregateRecoverability = async (
  runtime: QueryRuntime,
  summaryKind: 'count' | 'facet',
): Promise<SummaryContributionServingAggregateRecoverability> => {
  const finalRowsCte =
    summaryKind === 'count'
      ? `
        SELECT
          project_id,
          review_config_hash,
          snapshot_id,
          summary_identity,
          COALESCE(list_mode_key, 'global') AS list_mode_key,
          count_kind,
          summary_definition_version,
          filter_key,
          NULL::VARCHAR AS facet_kind,
          NULL::VARCHAR AS facet_key,
          NULL::VARCHAR AS facet_value,
          count_value
        FROM mart.review_article_count_serving_v4
      `
      : `
        SELECT
          project_id,
          review_config_hash,
          snapshot_id,
          summary_identity,
          NULL::VARCHAR AS list_mode_key,
          NULL::VARCHAR AS count_kind,
          summary_definition_version,
          NULL::VARCHAR AS filter_key,
          facet_kind,
          facet_key,
          facet_value,
          count_value
        FROM mart.review_filter_facet_serving_v4
      `
  const joinPredicate =
    summaryKind === 'count'
      ? `contribution_groups.project_id = final_rows.project_id
        AND contribution_groups.review_config_hash = final_rows.review_config_hash
        AND contribution_groups.snapshot_id = final_rows.snapshot_id
        AND contribution_groups.summary_identity = final_rows.summary_identity
        AND contribution_groups.list_mode_key = final_rows.list_mode_key
        AND contribution_groups.count_kind = final_rows.count_kind
        AND contribution_groups.summary_definition_version = final_rows.summary_definition_version
        AND contribution_groups.filter_key = final_rows.filter_key`
      : `contribution_groups.project_id = final_rows.project_id
        AND contribution_groups.review_config_hash = final_rows.review_config_hash
        AND contribution_groups.snapshot_id = final_rows.snapshot_id
        AND contribution_groups.summary_identity = final_rows.summary_identity
        AND contribution_groups.summary_definition_version = final_rows.summary_definition_version
        AND contribution_groups.facet_kind = final_rows.facet_kind
        AND contribution_groups.facet_key = final_rows.facet_key
        AND contribution_groups.facet_value = final_rows.facet_value`

  try {
    const rows = await runReadonlyQuery<{
      contributionGroups: number | string
      finalRows: number | string
      finalRowsMissingContributionGroup: number | string
      matchedFinalRows: number | string
      missingFinalRows: number | string
      mismatchedFinalRows: number | string
    }>(
      runtime,
      `
        WITH contribution_groups AS (
          SELECT
            project_id,
            review_config_hash,
            snapshot_id,
            json_extract_string(contribution_key, '$.summaryIdentity') AS summary_identity,
            COALESCE(json_extract_string(contribution_key, '$.listModeKey'), 'global') AS list_mode_key,
            json_extract_string(contribution_key, '$.countKind') AS count_kind,
            summary_definition_version,
            json_extract_string(contribution_key, '$.filterKey') AS filter_key,
            json_extract_string(contribution_key, '$.facetKind') AS facet_kind,
            json_extract_string(contribution_key, '$.facetKey') AS facet_key,
            json_extract_string(contribution_key, '$.facetValue') AS facet_value,
            SUM(COALESCE(contribution_value, 0)) AS contribution_count_value
          FROM mart.review_article_summary_contribution_v4
          WHERE json_extract_string(contribution_key, '$.summaryKind') = ${getSqlLiteral(summaryKind)}
          GROUP BY
            project_id,
            review_config_hash,
            snapshot_id,
            json_extract_string(contribution_key, '$.summaryIdentity'),
            COALESCE(json_extract_string(contribution_key, '$.listModeKey'), 'global'),
            json_extract_string(contribution_key, '$.countKind'),
            summary_definition_version,
            json_extract_string(contribution_key, '$.filterKey'),
            json_extract_string(contribution_key, '$.facetKind'),
            json_extract_string(contribution_key, '$.facetKey'),
            json_extract_string(contribution_key, '$.facetValue')
        ),
        final_rows AS (${finalRowsCte}),
        joined AS (
          SELECT
            contribution_groups.contribution_count_value,
            final_rows.count_value,
            contribution_groups.project_id IS NOT NULL AS has_contribution_group,
            final_rows.project_id IS NOT NULL AS has_final_row
          FROM contribution_groups
          FULL OUTER JOIN final_rows
            ON ${joinPredicate}
        )
        SELECT
          CAST(COUNT(*) FILTER (WHERE has_contribution_group) AS BIGINT) AS contributionGroups,
          CAST(COUNT(*) FILTER (WHERE has_final_row) AS BIGINT) AS finalRows,
          CAST(COUNT(*) FILTER (
            WHERE has_contribution_group
              AND has_final_row
              AND contribution_count_value IS NOT DISTINCT FROM count_value
          ) AS BIGINT) AS matchedFinalRows,
          CAST(COUNT(*) FILTER (WHERE has_contribution_group AND NOT has_final_row) AS BIGINT) AS missingFinalRows,
          CAST(COUNT(*) FILTER (
            WHERE has_contribution_group
              AND has_final_row
              AND NOT (contribution_count_value IS NOT DISTINCT FROM count_value)
          ) AS BIGINT) AS mismatchedFinalRows,
          CAST(COUNT(*) FILTER (WHERE has_final_row AND NOT has_contribution_group) AS BIGINT) AS finalRowsMissingContributionGroup
        FROM joined
      `,
    )
    const row = rows[0]

    return {
      contributionGroups: getNumberOrNull(row?.contributionGroups),
      error: null,
      finalRows: getNumberOrNull(row?.finalRows),
      finalRowsMissingContributionGroup: getNumberOrNull(row?.finalRowsMissingContributionGroup),
      matchedFinalRows: getNumberOrNull(row?.matchedFinalRows),
      missingFinalRows: getNumberOrNull(row?.missingFinalRows),
      mismatchedFinalRows: getNumberOrNull(row?.mismatchedFinalRows),
      note: 'Read-only aggregate comparison between contribution_key groups and final serving rows. Matches prove only aggregate count parity for this snapshot, not recoverability of exact per-article ledger rows.',
      summaryKind,
    }
  } catch (error) {
    return {
      contributionGroups: null,
      error: error instanceof Error ? error.message : String(error),
      finalRows: null,
      finalRowsMissingContributionGroup: null,
      matchedFinalRows: null,
      missingFinalRows: null,
      mismatchedFinalRows: null,
      note: 'Aggregate serving comparison failed; failed evidence collection is not deletion authorization.',
      summaryKind,
    }
  }
}

const getSummaryContributionPartialOverlap = async (
  runtime: QueryRuntime,
): Promise<SummaryContributionServingPartialOverlap> => {
  try {
    const rows = await runReadonlyQuery<{
      contributionRows: number | string
      exactCommonColumnOverlapRows: number | string
      partialRows: number | string
      partialRowsWithExactCommonContribution: number | string
    }>(
      runtime,
      `
        SELECT
          CAST((SELECT COUNT(*) FROM mart.review_article_summary_contribution_v4) AS BIGINT) AS contributionRows,
          CAST((SELECT COUNT(*) FROM mart.review_article_summary_contribution_rebuild_partial_v4) AS BIGINT) AS partialRows,
          CAST((
            SELECT COUNT(*)
            FROM mart.review_article_summary_contribution_v4 contribution
            WHERE EXISTS (
              SELECT 1
              FROM mart.review_article_summary_contribution_rebuild_partial_v4 partial
              WHERE partial.project_id = contribution.project_id
                AND partial.review_config_hash = contribution.review_config_hash
                AND partial.snapshot_id = contribution.snapshot_id
                AND partial.article_id = contribution.article_id
                AND partial.component_kind = contribution.component_kind
                AND partial.summary_definition_version = contribution.summary_definition_version
                AND partial.contribution_key = contribution.contribution_key
                AND partial.contribution_value = contribution.contribution_value
            )
          ) AS BIGINT) AS exactCommonColumnOverlapRows,
          CAST((
            SELECT COUNT(*)
            FROM mart.review_article_summary_contribution_rebuild_partial_v4 partial
            WHERE EXISTS (
              SELECT 1
              FROM mart.review_article_summary_contribution_v4 contribution
              WHERE contribution.project_id = partial.project_id
                AND contribution.review_config_hash = partial.review_config_hash
                AND contribution.snapshot_id = partial.snapshot_id
                AND contribution.article_id = partial.article_id
                AND contribution.component_kind = partial.component_kind
                AND contribution.summary_definition_version = partial.summary_definition_version
                AND contribution.contribution_key = partial.contribution_key
                AND contribution.contribution_value = partial.contribution_value
            )
          ) AS BIGINT) AS partialRowsWithExactCommonContribution
      `,
    )
    const row = rows[0]

    return {
      contributionRows: getNumberOrNull(row?.contributionRows),
      error: null,
      exactCommonColumnOverlapRows: getNumberOrNull(row?.exactCommonColumnOverlapRows),
      note: 'Exact overlap compares the shared logical contribution identity and value columns, excluding request/chunk ownership and timestamps. The final aggregate count/facet rows do not contain article_id/component_kind/contribution_key rows and cannot reconstruct exact per-article contribution ledger rows.',
      partialRows: getNumberOrNull(row?.partialRows),
      partialRowsWithExactCommonContribution: getNumberOrNull(row?.partialRowsWithExactCommonContribution),
    }
  } catch (error) {
    return {
      contributionRows: null,
      error: error instanceof Error ? error.message : String(error),
      exactCommonColumnOverlapRows: null,
      note: 'Exact rebuild-partial overlap collection failed; failed evidence collection is not deletion authorization.',
      partialRows: null,
      partialRowsWithExactCommonContribution: null,
    }
  }
}

const getSummaryContributionServingReadinessReport = async (
  runtime: QueryRuntime,
  limit: number,
): Promise<SummaryContributionServingReadinessReport> => {
  const table = 'mart.review_article_summary_contribution_v4' as const
  const primaryKeyColumns = [
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'article_id',
    'component_kind',
    'summary_definition_version',
    'contribution_key',
  ]
  const lookupIndexColumns = [
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'component_kind',
    'summary_definition_version',
    'contribution_key',
  ]

  try {
    const columns = await getTableColumns(runtime, table)
    const manifestColumns = await getTableColumns(runtime, 'app.review_serving_snapshot_manifest')
    const hasSnapshotStatus = hasColumn(manifestColumns, 'snapshot_status')
    const countRows = await runReadonlyQuery<{
      activeOrLastKnownGoodSnapshotProtectedRows: number | string
      globalRowCount: number | string
      missingSnapshotManifestRows: number | string
      nonzeroProjectCount: number | string
      pinnedSnapshotRows: number | string
    }>(
      runtime,
      `
        SELECT
          CAST(COUNT(*) FILTER (WHERE ${getActiveSnapshotManifestGuardPredicate('snapshot_id')}) AS BIGINT) AS activeOrLastKnownGoodSnapshotProtectedRows,
          CAST(COUNT(*) FILTER (WHERE ${getActiveSnapshotPinGuardPredicate('snapshot_id')}) AS BIGINT) AS pinnedSnapshotRows,
          CAST(COUNT(*) FILTER (
            WHERE NOT EXISTS (
              SELECT 1
              FROM app.review_serving_snapshot_manifest manifest
              WHERE manifest.project_id = candidate.project_id
                AND manifest.snapshot_id = candidate.snapshot_id
            )
          ) AS BIGINT) AS missingSnapshotManifestRows,
          CAST(COUNT(*) AS BIGINT) AS globalRowCount,
          CAST(COUNT(DISTINCT project_id) AS BIGINT) AS nonzeroProjectCount
        FROM ${table} candidate
      `,
    )
    const topProjects = await runReadonlyQuery<{projectId: string; rowCount: number | string}>(
      runtime,
      `
        SELECT project_id AS projectId, CAST(COUNT(*) AS BIGINT) AS rowCount
        FROM ${table}
        GROUP BY project_id
        HAVING COUNT(*) > 0
        ORDER BY COUNT(*) DESC, project_id
        LIMIT ${Math.max(1, limit)}
      `,
    )
    const rowsBySnapshotStatus = hasSnapshotStatus
      ? await getSummaryContributionServingGroupedRows(
          runtime,
          `
            ${table} contribution
            LEFT JOIN app.review_serving_snapshot_manifest manifest
              ON manifest.project_id = contribution.project_id
              AND manifest.snapshot_id = contribution.snapshot_id
          `,
          "COALESCE(manifest.snapshot_status, 'missing-manifest')",
          'snapshotStatus',
          null,
        )
      : []

    return {
      activeOrLastKnownGoodSnapshotProtectedRows: getNumberOrNull(
        countRows[0]?.activeOrLastKnownGoodSnapshotProtectedRows,
      ),
      columnCount: columns.length,
      columns,
      duplicateProbes: [
        {
          duplicateCount: await getDuplicateCountForColumns(runtime, table, primaryKeyColumns, null),
          keyColumns: primaryKeyColumns,
          label: 'declared primary key',
        },
        {
          duplicateCount: await getDuplicateCountForColumns(runtime, table, lookupIndexColumns, null),
          keyColumns: lookupIndexColumns,
          label: 'lookup index key without article_id',
        },
      ],
      error: null,
      globalRowCount: getNumberOrNull(countRows[0]?.globalRowCount),
      indexes: await getIndexes(runtime, table),
      missingSnapshotManifestRows: getNumberOrNull(countRows[0]?.missingSnapshotManifestRows),
      nonzeroProjectCount: getNumberOrNull(countRows[0]?.nonzeroProjectCount),
      note: 'Read-only current-DB snapshot evidence for the summary contribution serving ledger beyond the default scoped project. This section is not deletion authorization; table removal still requires route parity, benchmark, recovery, and live progress proof.',
      partialRebuildOverlap: await getSummaryContributionPartialOverlap(runtime),
      pinnedSnapshotRows: getNumberOrNull(countRows[0]?.pinnedSnapshotRows),
      recoverabilityClassification:
        'bounded-readonly-aggregate-only: final count/facet serving rows can be compared to contribution_key aggregate groups, but final aggregate rows cannot reconstruct exact per-article contribution ledger rows and this report does not authorize deletion.',
      recoverabilityComparisons: [
        await getSummaryContributionServingAggregateRecoverability(runtime, 'count'),
        await getSummaryContributionServingAggregateRecoverability(runtime, 'facet'),
      ],
      rowsByComponentKind: await getSummaryContributionServingGroupedRows(
        runtime,
        table,
        'component_kind',
        'componentKind',
        null,
      ),
      rowsByProject: topProjects.map((row) => {
        return {label: row.projectId, projectId: row.projectId, rowCount: Number(row.rowCount)}
      }),
      rowsBySnapshotStatus,
      rowsBySummaryDefinitionVersion: await getSummaryContributionServingGroupedRows(
        runtime,
        table,
        'summary_definition_version',
        'summaryDefinitionVersion',
        null,
      ),
      table,
      topContributionKeys: await getSummaryContributionServingGroupedRows(
        runtime,
        table,
        'contribution_key',
        'contributionKey',
        limit,
      ),
      topProjects: topProjects.map((row) => {
        return {projectId: row.projectId, rowCount: Number(row.rowCount)}
      }),
      verdict: 'not-authorized',
    }
  } catch (error) {
    return {
      activeOrLastKnownGoodSnapshotProtectedRows: null,
      columnCount: null,
      columns: [],
      duplicateProbes: [],
      error: error instanceof Error ? error.message : String(error),
      globalRowCount: null,
      indexes: [],
      missingSnapshotManifestRows: null,
      nonzeroProjectCount: null,
      note: 'Read-only current-DB snapshot evidence collection failed. Failed evidence collection is not deletion authorization.',
      partialRebuildOverlap: {
        contributionRows: null,
        error: null,
        exactCommonColumnOverlapRows: null,
        note: 'Not collected because summary contribution serving readiness collection failed.',
        partialRows: null,
        partialRowsWithExactCommonContribution: null,
      },
      pinnedSnapshotRows: null,
      recoverabilityClassification:
        'blocked: failed evidence collection cannot classify recoverability or authorize deletion.',
      recoverabilityComparisons: [],
      rowsByComponentKind: [],
      rowsByProject: [],
      rowsBySnapshotStatus: [],
      rowsBySummaryDefinitionVersion: [],
      table,
      topContributionKeys: [],
      topProjects: [],
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
    `| ${headers
      .map(() => {
        return '---'
      })
      .join(' | ')} |`,
    ...rows.map((row) => {
      return `| ${row.join(' | ')} |`
    }),
  ].join('\n')
}

const formatValue = (value: unknown) => {
  if (value === null || value === undefined) {
    return ''
  }

  const stringValue =
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint'
      ? `${value}`
      : JSON.stringify(value)

  return (stringValue ?? '').replaceAll('\n', ' ').replaceAll('|', '\\|')
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
      column.selectedBaseColumnStatus,
      formatValue(column.selectedBaseNullCount),
      formatValue(column.selectedBaseNonNullCount),
      formatValue(column.selectedBaseActiveOrLastKnownGoodNullCount),
      formatValue(column.selectedBaseActiveOrLastKnownGoodNonNullCount),
      formatValue(column.selectedBaseCandidateNullCount),
      formatValue(column.selectedBaseCandidateNonNullCount),
      formatValue(column.selectedBaseOtherNullCount),
      formatValue(column.selectedBaseOtherNonNullCount),
      formatValue(column.hotFieldNullCount),
      formatValue(column.hotFieldNonNullCount),
    ]
  })
  const selectedImportSnapshotStatusRows =
    report.selectedImportPayloadSlimmingReadiness.rowsBySelectedImportSnapshotStatus.map((row) => {
      return [`\`${row.label}\``, formatValue(row.rowCount)]
    })
  const selectedImportDisplayCopyGlobalColumnRows =
    report.selectedImportPayloadSlimmingReadiness.selectedImportDisplayCopyGlobalEvidence.columns.map((column) => {
      return [`\`${column.column}\``, column.status, formatValue(column.nullCount), formatValue(column.nonNullCount)]
    })
  const selectedImportDisplayCopyGlobalStatusRows =
    report.selectedImportPayloadSlimmingReadiness.selectedImportDisplayCopyGlobalEvidence.rows.map((row) => {
      return [
        `\`${row.snapshotStatus}\``,
        row.activeOrLastKnownGoodProtected ? 'yes' : 'no',
        formatValue(row.rowCount),
        formatValue(row.activeOrLastKnownGoodProtected ? row.rowCount : 0),
        formatValue(row.candidateRows),
        formatValue(row.otherRows),
        ...selectedImportDisplayCopyColumns.flatMap((column) => {
          return [formatValue(row.nullCounts[column]), formatValue(row.nonNullCounts[column])]
        }),
      ]
    })
  const selectedImportDuplicateConflictStatusRows =
    report.selectedImportPayloadSlimmingReadiness.selectedImportDuplicateConflictGlobalEvidence.rows.map((row) => {
      return [
        `\`${row.snapshotStatus}\``,
        row.activeOrLastKnownGoodProtected ? 'yes' : 'no',
        formatValue(row.rowCount),
        formatValue(row.activeOrLastKnownGoodProtected ? row.rowCount : 0),
        formatValue(row.candidateRows),
        formatValue(row.otherRows),
        formatValue(row.hotResolvedRows),
        formatValue(row.missingHotRows),
        formatValue(row.selectedBaseDuplicateTrueRows),
        formatValue(row.hotDuplicateTrueRows),
        formatValue(row.duplicateMismatchRows),
        formatValue(row.selectedBaseFalseOrDefaultDuplicateRowsWithoutHot),
        formatValue(row.selectedBaseTrueDuplicateRowsWithoutHot),
        formatValue(row.selectedBaseConflictTrueRows),
        formatValue(row.hotConflictTrueRows),
        formatValue(row.conflictMismatchRows),
        formatValue(row.selectedBaseFalseOrDefaultConflictRowsWithoutHot),
        formatValue(row.selectedBaseTrueConflictRowsWithoutHot),
      ]
    })
  const summaryContributionDuplicateRows = report.summaryContributionServingReadiness.duplicateProbes.map((probe) => {
    return [
      probe.label,
      probe.keyColumns
        .map((column) => {
          return `\`${column}\``
        })
        .join(', '),
      formatValue(probe.duplicateCount),
    ]
  })
  const summaryContributionColumnRows = report.summaryContributionServingReadiness.columns.map((column) => {
    return [`\`${column.column_name}\``, `\`${column.data_type}\``]
  })
  const summaryContributionTopProjectRows = report.summaryContributionServingReadiness.topProjects.map((project) => {
    return [`\`${project.projectId}\``, formatValue(project.rowCount)]
  })
  const summaryContributionProjectRows = report.summaryContributionServingReadiness.rowsByProject.map((project) => {
    return [`\`${project.projectId}\``, formatValue(project.rowCount)]
  })
  const summaryContributionComponentKindRows = report.summaryContributionServingReadiness.rowsByComponentKind.map(
    (row) => {
      return [`\`${row.label}\``, formatValue(row.rowCount)]
    },
  )
  const summaryContributionDefinitionVersionRows =
    report.summaryContributionServingReadiness.rowsBySummaryDefinitionVersion.map((row) => {
      return [`\`${row.label}\``, formatValue(row.rowCount)]
    })
  const summaryContributionContributionKeyRows = report.summaryContributionServingReadiness.topContributionKeys.map(
    (row) => {
      return [`\`${row.label}\``, formatValue(row.rowCount)]
    },
  )
  const summaryContributionSnapshotStatusRows = report.summaryContributionServingReadiness.rowsBySnapshotStatus.map(
    (row) => {
      return [`\`${row.label}\``, formatValue(row.rowCount)]
    },
  )
  const summaryContributionRecoverabilityRows =
    report.summaryContributionServingReadiness.recoverabilityComparisons.map((comparison) => {
      return [
        comparison.summaryKind,
        formatValue(comparison.contributionGroups),
        formatValue(comparison.finalRows),
        formatValue(comparison.matchedFinalRows),
        formatValue(comparison.missingFinalRows),
        formatValue(comparison.mismatchedFinalRows),
        formatValue(comparison.finalRowsMissingContributionGroup),
        comparison.error ? `Blocked: ${comparison.error}` : 'ok',
      ]
    })
  const summaryContributionIndexRows = report.summaryContributionServingReadiness.indexes.map((index) => {
    return [formatValue(JSON.stringify(index))]
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
      `- Duplicate key columns: ${
        table.duplicateProbe.keyColumns
          .map((column) => {
            return `\`${column}\``
          })
          .join(', ') || 'not probed'
      }`,
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
      sizeRows.length > 0
        ? formatMarkdownTable(['Size proxy', 'Value'], sizeRows)
        : '_No JSON/payload size proxies collected._',
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
    `Active/LKG selected-import rows: ${formatValue(report.selectedImportPayloadSlimmingReadiness.activeOrLastKnownGoodSelectedImportRows)}`,
    '',
    `Candidate selected-import rows: ${formatValue(report.selectedImportPayloadSlimmingReadiness.candidateSelectedImportRows)}`,
    '',
    `Other selected-import rows: ${formatValue(report.selectedImportPayloadSlimmingReadiness.otherSelectedImportRows)}`,
    '',
    `Hot-field scoped rows: ${formatValue(report.selectedImportPayloadSlimmingReadiness.hotFieldScopedRows)}`,
    '',
    report.selectedImportPayloadSlimmingReadiness.comparisonStatus,
    '',
    report.selectedImportPayloadSlimmingReadiness.consumerWriterStatus,
    '',
    'Global/current-DB display-copy evidence is limited to `publication_year`, `article_title`, `journal_title`, and `external_id`. Post-drop databases report those columns as `retired/dropped` instead of binding absent physical columns. `import_route_id`, `source_record_key`, `selected_rank_key`, and `selected_rank_numeric` stay out of this claim and remain active identity/rank/source state.',
    '',
    `Global/current-DB selected-base rows: ${formatValue(report.selectedImportPayloadSlimmingReadiness.selectedImportDisplayCopyGlobalEvidence.totalRows)}`,
    '',
    `Global active/LKG protected selected-import rows: ${formatValue(report.selectedImportPayloadSlimmingReadiness.selectedImportDisplayCopyGlobalEvidence.activeOrLastKnownGoodRows)}`,
    '',
    `Global candidate selected-import rows: ${formatValue(report.selectedImportPayloadSlimmingReadiness.selectedImportDisplayCopyGlobalEvidence.candidateRows)}`,
    '',
    `Global other selected-import rows: ${formatValue(report.selectedImportPayloadSlimmingReadiness.selectedImportDisplayCopyGlobalEvidence.otherRows)}`,
    '',
    selectedImportDisplayCopyGlobalColumnRows.length > 0
      ? formatMarkdownTable(
          ['Global display-copy column', 'Status', 'Selected-base nulls', 'Selected-base non-nulls'],
          selectedImportDisplayCopyGlobalColumnRows,
        )
      : '_No global display-copy column evidence rows were collected._',
    '',
    selectedImportDisplayCopyGlobalStatusRows.length > 0
      ? formatMarkdownTable(
          [
            'Snapshot status',
            'Active/LKG protected',
            'Rows',
            'Protected rows',
            'Candidate rows',
            'Other rows',
            ...selectedImportDisplayCopyColumns.flatMap((column) => {
              return [`${column} nulls`, `${column} non-nulls`]
            }),
          ],
          selectedImportDisplayCopyGlobalStatusRows,
        )
      : '_No global selected-import display-copy status/protection rows were collected._',
    '',
    'Global/current-DB duplicate/conflict flag fallback evidence is read-only and uses retained selected-base identity `(import_route_id, article_id, source_record_key)` to resolve hot-field rows. It does not authorize removing selected-base flag writers or columns.',
    '',
    report.selectedImportPayloadSlimmingReadiness.selectedImportDuplicateConflictGlobalEvidence.note,
    '',
    `Duplicate/conflict selected-base rows: ${formatValue(report.selectedImportPayloadSlimmingReadiness.selectedImportDuplicateConflictGlobalEvidence.totalRows)}`,
    '',
    `Duplicate/conflict active/LKG protected selected-import rows: ${formatValue(report.selectedImportPayloadSlimmingReadiness.selectedImportDuplicateConflictGlobalEvidence.activeOrLastKnownGoodRows)}`,
    '',
    `Duplicate/conflict candidate selected-import rows: ${formatValue(report.selectedImportPayloadSlimmingReadiness.selectedImportDuplicateConflictGlobalEvidence.candidateRows)}`,
    '',
    `Duplicate/conflict other selected-import rows: ${formatValue(report.selectedImportPayloadSlimmingReadiness.selectedImportDuplicateConflictGlobalEvidence.otherRows)}`,
    '',
    `Hot rows resolved by selected-base identity: ${formatValue(report.selectedImportPayloadSlimmingReadiness.selectedImportDuplicateConflictGlobalEvidence.hotResolvedRows)}`,
    '',
    `Selected-base rows without resolved hot rows: ${formatValue(report.selectedImportPayloadSlimmingReadiness.selectedImportDuplicateConflictGlobalEvidence.missingHotRows)}`,
    '',
    `Selected-base duplicate TRUE rows: ${formatValue(report.selectedImportPayloadSlimmingReadiness.selectedImportDuplicateConflictGlobalEvidence.selectedBaseDuplicateTrueRows)}`,
    '',
    `Hot duplicate TRUE rows: ${formatValue(report.selectedImportPayloadSlimmingReadiness.selectedImportDuplicateConflictGlobalEvidence.hotDuplicateTrueRows)}`,
    '',
    `Duplicate flag mismatches by IS DISTINCT FROM: ${formatValue(report.selectedImportPayloadSlimmingReadiness.selectedImportDuplicateConflictGlobalEvidence.duplicateMismatchRows)}`,
    '',
    `Selected-base duplicate false/default rows without hot fallback source: ${formatValue(report.selectedImportPayloadSlimmingReadiness.selectedImportDuplicateConflictGlobalEvidence.selectedBaseFalseOrDefaultDuplicateRowsWithoutHot)}`,
    '',
    `Selected-base duplicate TRUE rows without hot fallback source: ${formatValue(report.selectedImportPayloadSlimmingReadiness.selectedImportDuplicateConflictGlobalEvidence.selectedBaseTrueDuplicateRowsWithoutHot)}`,
    '',
    `Selected-base conflict TRUE rows: ${formatValue(report.selectedImportPayloadSlimmingReadiness.selectedImportDuplicateConflictGlobalEvidence.selectedBaseConflictTrueRows)}`,
    '',
    `Hot conflict TRUE rows: ${formatValue(report.selectedImportPayloadSlimmingReadiness.selectedImportDuplicateConflictGlobalEvidence.hotConflictTrueRows)}`,
    '',
    `Conflict flag mismatches by IS DISTINCT FROM: ${formatValue(report.selectedImportPayloadSlimmingReadiness.selectedImportDuplicateConflictGlobalEvidence.conflictMismatchRows)}`,
    '',
    `Selected-base conflict false/default rows without hot fallback source: ${formatValue(report.selectedImportPayloadSlimmingReadiness.selectedImportDuplicateConflictGlobalEvidence.selectedBaseFalseOrDefaultConflictRowsWithoutHot)}`,
    '',
    `Selected-base conflict TRUE rows without hot fallback source: ${formatValue(report.selectedImportPayloadSlimmingReadiness.selectedImportDuplicateConflictGlobalEvidence.selectedBaseTrueConflictRowsWithoutHot)}`,
    '',
    selectedImportDuplicateConflictStatusRows.length > 0
      ? formatMarkdownTable(
          [
            'Snapshot status',
            'Active/LKG protected',
            'Rows',
            'Protected rows',
            'Candidate rows',
            'Other rows',
            'Hot resolved',
            'Hot missing',
            'Selected dup TRUE',
            'Hot dup TRUE',
            'Dup mismatches',
            'Missing-hot dup false/default',
            'Missing-hot dup TRUE',
            'Selected conflict TRUE',
            'Hot conflict TRUE',
            'Conflict mismatches',
            'Missing-hot conflict false/default',
            'Missing-hot conflict TRUE',
          ],
          selectedImportDuplicateConflictStatusRows,
        )
      : '_No global duplicate/conflict status/protection rows were collected._',
    '',
    report.selectedImportPayloadSlimmingReadiness.error
      ? `Status: Blocked: ${report.selectedImportPayloadSlimmingReadiness.error}`
      : 'Status: ok',
    '',
    selectedImportPayloadRows.length > 0
      ? formatMarkdownTable(
          [
            'Column',
            'Selected-base status',
            'Selected-base nulls',
            'Selected-base non-nulls',
            'Active/LKG nulls',
            'Active/LKG non-nulls',
            'Candidate nulls',
            'Candidate non-nulls',
            'Other nulls',
            'Other non-nulls',
            'Hot-field nulls',
            'Hot-field non-nulls',
          ],
          selectedImportPayloadRows,
        )
      : '_No selected-import payload evidence rows were collected._',
    '',
    selectedImportSnapshotStatusRows.length > 0
      ? formatMarkdownTable(['Selected-import snapshot status', 'Rows'], selectedImportSnapshotStatusRows)
      : '_No selected-import snapshot status rows were collected._',
    '',
    '## Summary Contribution Serving Readiness',
    '',
    `Verdict: ${report.summaryContributionServingReadiness.verdict === 'not-authorized' ? 'not-authorized (not deletion authorization)' : 'blocked'}`,
    '',
    report.summaryContributionServingReadiness.note,
    '',
    `Table: \`${report.summaryContributionServingReadiness.table}\``,
    '',
    `Global rows: ${formatValue(report.summaryContributionServingReadiness.globalRowCount)}`,
    '',
    `Projects with nonzero rows: ${formatValue(report.summaryContributionServingReadiness.nonzeroProjectCount)}`,
    '',
    `Active/LKG snapshot protected rows: ${formatValue(report.summaryContributionServingReadiness.activeOrLastKnownGoodSnapshotProtectedRows)}`,
    '',
    `Pinned snapshot rows: ${formatValue(report.summaryContributionServingReadiness.pinnedSnapshotRows)}`,
    '',
    `Rows with missing snapshot manifest: ${formatValue(report.summaryContributionServingReadiness.missingSnapshotManifestRows)}`,
    '',
    `Recoverability classification: ${report.summaryContributionServingReadiness.recoverabilityClassification}`,
    '',
    report.summaryContributionServingReadiness.partialRebuildOverlap.note,
    '',
    `Contribution ledger rows: ${formatValue(report.summaryContributionServingReadiness.partialRebuildOverlap.contributionRows)}`,
    '',
    `Rebuild partial contribution rows: ${formatValue(report.summaryContributionServingReadiness.partialRebuildOverlap.partialRows)}`,
    '',
    `Contribution rows with exact common-column rebuild-partial overlap: ${formatValue(report.summaryContributionServingReadiness.partialRebuildOverlap.exactCommonColumnOverlapRows)}`,
    '',
    `Rebuild partial rows with exact common-column contribution overlap: ${formatValue(report.summaryContributionServingReadiness.partialRebuildOverlap.partialRowsWithExactCommonContribution)}`,
    '',
    report.summaryContributionServingReadiness.partialRebuildOverlap.error
      ? `Partial overlap status: Blocked: ${report.summaryContributionServingReadiness.partialRebuildOverlap.error}`
      : 'Partial overlap status: ok',
    '',
    `Column count: ${formatValue(report.summaryContributionServingReadiness.columnCount)}`,
    '',
    `Index count: ${formatValue(report.summaryContributionServingReadiness.indexes.length)}`,
    '',
    report.summaryContributionServingReadiness.error
      ? `Status: Blocked: ${report.summaryContributionServingReadiness.error}`
      : 'Status: ok',
    '',
    summaryContributionTopProjectRows.length > 0
      ? formatMarkdownTable(['Project', 'Rows'], summaryContributionTopProjectRows)
      : '_No projects with nonzero summary contribution serving rows were observed._',
    '',
    summaryContributionProjectRows.length > 0
      ? formatMarkdownTable(['Rows by project', 'Rows'], summaryContributionProjectRows)
      : '_No summary contribution project classification rows were collected._',
    '',
    summaryContributionComponentKindRows.length > 0
      ? formatMarkdownTable(['Component kind', 'Rows'], summaryContributionComponentKindRows)
      : '_No summary contribution component-kind classification rows were collected._',
    '',
    summaryContributionDefinitionVersionRows.length > 0
      ? formatMarkdownTable(['Summary definition version', 'Rows'], summaryContributionDefinitionVersionRows)
      : '_No summary contribution definition-version classification rows were collected._',
    '',
    summaryContributionContributionKeyRows.length > 0
      ? formatMarkdownTable(['Contribution key', 'Rows'], summaryContributionContributionKeyRows)
      : '_No summary contribution key classification rows were collected._',
    '',
    summaryContributionSnapshotStatusRows.length > 0
      ? formatMarkdownTable(['Snapshot status', 'Rows'], summaryContributionSnapshotStatusRows)
      : '_No summary contribution snapshot-status classification rows were collected._',
    '',
    summaryContributionRecoverabilityRows.length > 0
      ? formatMarkdownTable(
          [
            'Summary kind',
            'Contribution groups',
            'Final rows',
            'Matched final rows',
            'Missing final rows',
            'Mismatched final rows',
            'Final rows missing contribution group',
            'Status',
          ],
          summaryContributionRecoverabilityRows,
        )
      : '_No summary contribution recoverability comparisons were collected._',
    '',
    summaryContributionDuplicateRows.length > 0
      ? formatMarkdownTable(['Probe', 'Key columns', 'Duplicate keys'], summaryContributionDuplicateRows)
      : '_No summary contribution duplicate probes were collected._',
    '',
    summaryContributionColumnRows.length > 0
      ? formatMarkdownTable(['Column', 'Type'], summaryContributionColumnRows)
      : '_No summary contribution column shape was collected._',
    '',
    summaryContributionIndexRows.length > 0
      ? formatMarkdownTable(['Index metadata'], summaryContributionIndexRows)
      : '_No summary contribution indexes were observed._',
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
              summaryContributionServingReadiness: await getSummaryContributionServingReadinessReport(
                runtime,
                options.limit,
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
