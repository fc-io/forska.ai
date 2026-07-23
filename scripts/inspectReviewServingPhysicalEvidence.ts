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
  snapshotPath: string
  tables: TableEvidence[]
}
type QueryRuntime = Awaited<ReturnType<typeof getSnapshotQueryRuntime>>
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
  'mart.review_article_display_patch_v4',
  'mart.review_llm_status_patch_v4',
  'mart.review_human_status_patch_v4',
  'mart.review_queue_patch_v4',
  'mart.review_article_filter_posting_patch_v4',
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
