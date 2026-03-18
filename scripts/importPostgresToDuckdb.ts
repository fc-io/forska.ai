import {appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'

import {Client} from 'pg'

import {migrateDuckdb} from '../src/db/migrateDuckdb.ts'
import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {getDuckdbMartService} from '../src/server/services/getDuckdbMartService.ts'
import {withDuckdbMaintenanceAccess} from '../src/server/utils/duckdbScriptAccess.ts'
import {env} from '../src/server/utils/env.ts'
import {localUserDefaults} from '../src/utils/localUser.ts'

type ImportOptions = {
  batchSize: number
  batchSizeExplicit: boolean
  clear: boolean
  importThreads: number
  reportPath: string
  rebuildMarts: boolean
  resume: boolean
  skipTables: string[]
  tables: string[] | null
}

type TableConfig = {
  batchSize?: number
  dedupeKey?: string[]
  defaultSelected?: boolean
  extraColumns?: Record<string, string>
  maxBatchBytes?: number
  maxBatchRows?: number
  ndjsonMaximumObjectSizeBytes?: number
  rename?: Record<string, string>
  sourceComputedColumns?: string[]
  sourceRelationSql?: string
  sourceTable: string
  targetSchema: 'app'
  targetTable: string
  transforms?: Record<string, string>
}

type EncodedBatchRow = {bytes: number; text: string}

type TableReport = {
  finalRows: number
  importedRows: number
  mapping: {
    dedupeKey: string[]
    droppedSourceColumns: string[]
    extraColumns: string[]
    importedColumns: string[]
    renamedColumns: Record<string, string>
    sourceTable: string
    transformedColumns: string[]
  }
  missing: boolean
  skippedRows: number
  sourceRows: number
}

type ImportReport = {
  currentTable: string | null
  duckdbPath: string
  finishedAt: string | null
  martCounts: Record<string, number> | null
  selectedTables: string[]
  sourceDatabaseUrl: string
  startedAt: string
  status: 'completed' | 'running'
  tables: Record<string, TableReport>
  userBootstrap: {
    email: string
    envKeysUsed: string[]
    id: string
    name: string
    unpaywallEmail: string | null
    role: string | null
    sourceUserCount: number
  } | null
}

const importTableConfigs: TableConfig[] = [
  {
    batchSize: 5000,
    sourceTable: 'models',
    targetSchema: 'app',
    targetTable: 'model',
    transforms: {worker_urls: 'CAST(__SOURCE__ AS VARCHAR[])'},
  },
  {batchSize: 5000, sourceTable: 'datasource', targetSchema: 'app', targetTable: 'data_source'},
  {batchSize: 5000, sourceTable: 'import_route', targetSchema: 'app', targetTable: 'import_route'},
  {
    batchSize: 10000,
    rename: {data_source_id: 'datasource_id'},
    sourceTable: 'datasource_route_link',
    targetSchema: 'app',
    targetTable: 'data_source_import_route',
  },
  {batchSize: 5000, sourceTable: 'prompts', targetSchema: 'app', targetTable: 'prompt'},
  {batchSize: 5000, sourceTable: 'projects', targetSchema: 'app', targetTable: 'project'},
  {
    batchSize: 5000,
    rename: {prompt_order: 'order'},
    sourceTable: 'project_prompts',
    targetSchema: 'app',
    targetTable: 'project_prompt',
  },
  {batchSize: 10000, sourceTable: 'project_route_link', targetSchema: 'app', targetTable: 'project_import_route'},
  {
    batchSize: 1000,
    maxBatchBytes: 67108864,
    maxBatchRows: 100,
    ndjsonMaximumObjectSizeBytes: 134217728,
    sourceTable: 'articles',
    targetSchema: 'app',
    targetTable: 'article',
    transforms: {
      article_authors: 'CAST(__SOURCE__ AS VARCHAR[])',
      full_text_assets: 'CASE WHEN __SOURCE__ IS NULL THEN NULL ELSE TO_JSON(__SOURCE__) END',
      original_data: 'CASE WHEN __SOURCE__ IS NULL THEN NULL ELSE TO_JSON(__SOURCE__) END',
    },
  },
  {batchSize: 10000, sourceTable: 'article_route_link', targetSchema: 'app', targetTable: 'article_import_route'},
  {batchSize: 10000, sourceTable: 'project_articles', targetSchema: 'app', targetTable: 'project_article'},
  {
    batchSize: 5000,
    sourceTable: 'comparison_project',
    targetSchema: 'app',
    targetTable: 'comparison_project',
    transforms: {model_ids: 'CAST(__SOURCE__ AS VARCHAR[])'},
  },
  {
    batchSize: 5000,
    rename: {prompt_order: 'order'},
    sourceTable: 'comparison_project_prompt',
    targetSchema: 'app',
    targetTable: 'comparison_project_prompt',
  },
  {
    batchSize: 10000,
    sourceTable: 'comparison_project_route_link',
    targetSchema: 'app',
    targetTable: 'comparison_project_import_route',
  },
  {
    batchSize: 5000,
    extraColumns: {delete_generation: 'source_row.delete_generation'},
    sourceComputedColumns: ['delete_generation'],
    sourceRelationSql: `(
      SELECT
        base.*,
        CASE
          WHEN base.deleted_at IS NULL THEN 0
          ELSE ROW_NUMBER() OVER (
            PARTITION BY base.article_id, base.prompt_id, base.model_id, base.use_title, base.use_abstract, base.use_fulltext, base.use_fulltext_no_images
            ORDER BY base.deleted_at DESC NULLS LAST, base.updated_at DESC NULLS LAST, base.created_at DESC NULLS LAST, base.id DESC
          )
        END AS delete_generation
      FROM "judgments" base
    ) source_row`,
    sourceTable: 'judgments',
    targetSchema: 'app',
    targetTable: 'judgment',
    transforms: {
      answered_original_as_array: 'CAST(__SOURCE__ AS VARCHAR[])',
      quotes: 'CASE WHEN __SOURCE__ IS NULL THEN NULL ELSE TO_JSON(__SOURCE__) END',
    },
  },
  {
    batchSize: 5000,
    rename: {cursor_last_article_id: 'ch_cursor_last_article_id', cursor_last_created_at: 'ch_cursor_last_date'},
    sourceTable: 'judgments_jobs',
    targetSchema: 'app',
    targetTable: 'judgment_job',
    transforms: {error: 'CASE WHEN __SOURCE__ IS NULL THEN NULL ELSE TO_JSON(__SOURCE__) END'},
  },
  {batchSize: 5000, sourceTable: 'judgments_jobs_prompts', targetSchema: 'app', targetTable: 'judgment_job_prompt'},
  {
    batchSize: 5000,
    dedupeKey: ['project_id', 'article_id', 'prompt_id'],
    sourceTable: 'judgments_human',
    targetSchema: 'app',
    targetTable: 'judgment_human',
  },
  {
    batchSize: 5000,
    dedupeKey: ['project_id', 'article_id'],
    sourceTable: 'reviews',
    targetSchema: 'app',
    targetTable: 'review',
  },
  {
    batchSize: 20000,
    defaultSelected: false,
    sourceTable: 'token_use',
    targetSchema: 'app',
    targetTable: 'token_use',
    transforms: {failed_requests_details: 'CASE WHEN __SOURCE__ IS NULL THEN NULL ELSE TO_JSON(__SOURCE__) END'},
  },
  {
    batchSize: 5000,
    dedupeKey: ['judgment_id'],
    sourceTable: 'judgment_assessments',
    targetSchema: 'app',
    targetTable: 'judgment_assessment',
  },
  {
    batchSize: 20000,
    sourceTable: 'llm_status',
    targetSchema: 'app',
    targetTable: 'llm_status',
    transforms: {
      e2e_request_latency_seconds: 'CASE WHEN __SOURCE__ IS NULL THEN NULL ELSE TO_JSON(__SOURCE__) END',
      inter_token_latency_seconds: 'CASE WHEN __SOURCE__ IS NULL THEN NULL ELSE TO_JSON(__SOURCE__) END',
      per_stage_req_latency_seconds: 'CASE WHEN __SOURCE__ IS NULL THEN NULL ELSE TO_JSON(__SOURCE__) END',
      queue_time_seconds: 'CASE WHEN __SOURCE__ IS NULL THEN NULL ELSE TO_JSON(__SOURCE__) END',
      time_to_first_token_seconds: 'CASE WHEN __SOURCE__ IS NULL THEN NULL ELSE TO_JSON(__SOURCE__) END',
    },
  },
  {batchSize: 20000, sourceTable: 'nvidia_smi', targetSchema: 'app', targetTable: 'nvidia_smi'},
]

const martTableNames = [
  ['mart', 'review_article_rollup'],
  ['mart', 'prompt_answer_fact'],
  ['mart', 'judgment_fact'],
  ['mart', 'project_scope_article'],
] as const

const getTableSelectionFromArg = (value: string | undefined) => {
  return (value ?? '')
    .split(',')
    .map((entry) => {
      return entry.trim()
    })
    .filter((entry) => {
      return entry !== ''
    })
}

const getArgs = (): ImportOptions => {
  const args = process.argv.slice(2)
  const batchArg = args.find((arg) => {
    return arg.startsWith('--batch-size=')
  })
  const threadsArg = args.find((arg) => {
    return arg.startsWith('--threads=')
  })
  const reportArg = args.find((arg) => {
    return arg.startsWith('--report=')
  })
  const tableArgs = args.filter((arg) => {
    return arg.startsWith('--table=')
  })
  const skipTableArgs = args.filter((arg) => {
    return arg.startsWith('--skip-table=')
  })
  const selectedTables = [
    ...new Set(
      tableArgs.flatMap((arg) => {
        return getTableSelectionFromArg(arg.split('=')[1])
      }),
    ),
  ]
  const skippedTables = [
    ...new Set(
      skipTableArgs.flatMap((arg) => {
        return getTableSelectionFromArg(arg.split('=')[1])
      }),
    ),
  ]
  const batchSize = Number.parseInt(batchArg?.split('=')[1] ?? '5000', 10)
  const importThreads = Number.parseInt(threadsArg?.split('=')[1] ?? '2', 10)

  return {
    batchSize: Number.isFinite(batchSize) && batchSize > 0 ? batchSize : 5000,
    batchSizeExplicit: batchArg !== undefined,
    clear: args.includes('--clear'),
    importThreads: Number.isFinite(importThreads) && importThreads > 0 ? importThreads : 2,
    reportPath: reportArg?.split('=')[1] ?? './data/native-duck-import-report.json',
    rebuildMarts: args.includes('--rebuild-marts'),
    resume: args.includes('--resume'),
    skipTables: skippedTables,
    tables: selectedTables.length > 0 ? selectedTables : null,
  }
}

const getImportTargetName = (config: TableConfig) => {
  return `${config.targetSchema}.${config.targetTable}`
}

const getImportTargetNames = () => {
  return importTableConfigs.map((config) => {
    return getImportTargetName(config)
  })
}

const quoteIdentifier = (value: string) => {
  return `"${value.replaceAll('"', '""')}"`
}

const quoteQualifiedName = (schemaName: string, tableName: string) => {
  return `${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`
}

const escapeSqlString = (value: string) => {
  return value.replaceAll("'", "''")
}

const getSqlLiteral = (value: string | null) => {
  return value === null ? 'NULL' : `'${escapeSqlString(value)}'`
}

const getSourceDatabaseUrl = () => {
  const databaseUrl = String(process.env['DATABASE_URL'] ?? '').trim()
  return databaseUrl === ''
    ? (() => {
        throw new Error('DATABASE_URL is required to import from PostgreSQL')
      })()
    : databaseUrl
}

const getRedactedDatabaseUrl = (databaseUrl: string) => {
  const parsedUrl = new URL(databaseUrl)
  parsedUrl.password = parsedUrl.password === '' ? '' : '***'
  return parsedUrl.toString()
}

const getSelectedTableConfigs = (options: ImportOptions) => {
  const selectedTableSet = options.tables ? new Set(options.tables) : null
  const skippedTableSet = new Set(options.skipTables)
  const targetNames = getImportTargetNames()
  const unknownSelectedTables = (options.tables ?? []).filter((tableName) => {
    return !targetNames.includes(tableName)
  })
  const unknownSkippedTables = options.skipTables.filter((tableName) => {
    return !targetNames.includes(tableName)
  })

  const selectedConfigs =
    unknownSelectedTables.length > 0
      ? (() => {
          throw new Error(`Unknown --table value(s): ${unknownSelectedTables.join(', ')}`)
        })()
      : unknownSkippedTables.length > 0
        ? (() => {
            throw new Error(`Unknown --skip-table value(s): ${unknownSkippedTables.join(', ')}`)
          })()
        : importTableConfigs.filter((config) => {
            const targetName = getImportTargetName(config)
            const selectedMatch =
              selectedTableSet === null ? config.defaultSelected !== false : selectedTableSet.has(targetName)
            return selectedMatch && !skippedTableSet.has(targetName)
          })

  return selectedConfigs.length === 0
    ? (() => {
        throw new Error('No tables selected for import.')
      })()
    : selectedConfigs
}

const validateOptions = (options: ImportOptions) => {
  if (options.clear && options.resume) {
    throw new Error('Use either --clear or --resume, not both in the same run.')
  }

  if (options.resume && (options.tables !== null || options.skipTables.length > 0)) {
    throw new Error('Use --resume by itself; do not combine it with --table or --skip-table.')
  }
}

const getConfigMapByTargetName = () => {
  return new Map(
    importTableConfigs.map((config) => {
      return [getImportTargetName(config), config]
    }),
  )
}

const getTableConfigsFromNames = (tableNames: string[]) => {
  const configMap = getConfigMapByTargetName()

  return tableNames.map((tableName) => {
    const config = configMap.get(tableName)

    if (!config) {
      throw new Error(`Unknown table in import report: ${tableName}`)
    }

    return config
  })
}

const createReport = (sourceDatabaseUrl: string, selectedTables: TableConfig[], reportPath: string): ImportReport => {
  mkdirSync(dirname(reportPath), {recursive: true})

  return {
    currentTable: null,
    duckdbPath: env.DUCKDB_PATH,
    finishedAt: null,
    martCounts: null,
    selectedTables: selectedTables.map((config) => {
      return getImportTargetName(config)
    }),
    sourceDatabaseUrl: getRedactedDatabaseUrl(sourceDatabaseUrl),
    startedAt: new Date().toISOString(),
    status: 'running',
    tables: {},
    userBootstrap: null,
  }
}

const loadReport = async (reportPath: string) => {
  const reportFile = globalThis.Bun.file(reportPath)
  return (await reportFile.exists()) ? ((await reportFile.json()) as ImportReport) : null
}

const getResumeReport = async (reportPath: string, sourceDatabaseUrl: string) => {
  const report = await loadReport(reportPath)

  if (!report) {
    throw new Error(`Cannot resume without an import report at ${reportPath}`)
  }

  if (report.sourceDatabaseUrl !== getRedactedDatabaseUrl(sourceDatabaseUrl)) {
    throw new Error('Cannot resume import because DATABASE_URL does not match the saved report.')
  }

  if (report.duckdbPath !== env.DUCKDB_PATH) {
    throw new Error('Cannot resume import because DUCKDB_PATH does not match the saved report.')
  }

  if (report.status === 'completed') {
    throw new Error('Import report is already completed. Use --clear to start from an empty DuckDB database.')
  }

  return {...report, finishedAt: null, status: 'running' as const}
}

const getResumeTableConfigs = (report: ImportReport) => {
  const selectedConfigs = getTableConfigsFromNames(report.selectedTables)
  const firstIncompleteConfig = selectedConfigs.find((config) => {
    return report.tables[getImportTargetName(config)] == null
  })
  const resumeTableName =
    report.currentTable ?? (firstIncompleteConfig ? getImportTargetName(firstIncompleteConfig) : null)
  return resumeTableName == null
    ? []
    : selectedConfigs.slice(
        selectedConfigs.findIndex((config) => {
          return getImportTargetName(config) === resumeTableName
        }),
      )
}

const writeReport = async (reportPath: string, report: ImportReport) => {
  await globalThis.Bun.write(reportPath, JSON.stringify(report, null, 2))
}

const getSourceTableExists = async (client: Client, config: TableConfig) => {
  const result = await client.query<{exists: string | null}>(`SELECT to_regclass($1) AS exists`, [
    `public.${config.sourceTable}`,
  ])
  return result.rows[0]?.exists !== null
}

const getTargetColumnNames = async (config: TableConfig) => {
  const rows = await getAppDatabaseService().queryJson<{column_name: string}>(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = '${escapeSqlString(config.targetSchema)}'
      AND table_name = '${escapeSqlString(config.targetTable)}'
    ORDER BY ordinal_position
  `)

  return rows.map((row) => {
    return row.column_name
  })
}

const getSourceColumnNames = async (client: Client, config: TableConfig) => {
  const result = await client.query<{column_name: string}>(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
    `,
    [config.sourceTable],
  )

  return [
    ...result.rows.map((row) => {
      return row.column_name
    }),
    ...(config.sourceComputedColumns ?? []),
  ]
}

const getTableMappingReport = (
  config: TableConfig,
  mappedColumns: Array<{expression: string; targetColumn: string}>,
  sourceColumnNames: string[],
) => {
  const importedColumns = mappedColumns.map((mapping) => {
    return mapping.targetColumn
  })
  const extraColumns = Object.keys(config.extraColumns ?? {})
  const renamedColumns = Object.fromEntries(
    Object.entries(config.rename ?? {})
      .map(([targetColumn, sourceColumn]) => {
        return sourceColumn === targetColumn ? null : [targetColumn, sourceColumn]
      })
      .filter((entry): entry is [string, string] => {
        return entry !== null
      }),
  )
  const transformedColumns = Object.keys(config.transforms ?? {}).filter((targetColumn) => {
    return importedColumns.includes(targetColumn)
  })
  const importedSourceColumns = importedColumns.reduce<Set<string>>((sourceColumns, targetColumn) => {
    return extraColumns.includes(targetColumn)
      ? sourceColumns
      : sourceColumns.add(config.rename?.[targetColumn] ?? targetColumn)
  }, new Set<string>())

  return {
    dedupeKey: config.dedupeKey ?? [],
    droppedSourceColumns: sourceColumnNames.filter((sourceColumnName) => {
      return !importedSourceColumns.has(sourceColumnName)
    }),
    extraColumns,
    importedColumns,
    renamedColumns,
    sourceTable: config.sourceTable,
    transformedColumns,
  }
}

const getMappedExpression = (config: TableConfig, targetColumn: string, sourceColumns: Set<string>) => {
  const extraExpression = config.extraColumns?.[targetColumn]
  const sourceColumn = config.rename?.[targetColumn] ?? targetColumn
  const sourceReference = `source_row.${quoteIdentifier(sourceColumn)}`
  const transformTemplate = config.transforms?.[targetColumn]
  const transformedExpression = transformTemplate
    ? transformTemplate.replaceAll('__SOURCE__', sourceReference)
    : sourceReference

  return extraExpression
    ? {targetColumn, expression: extraExpression}
    : sourceColumns.has(sourceColumn)
      ? {targetColumn, expression: transformedExpression}
      : null
}

const getMappedColumns = async (config: TableConfig, sourceColumnNames: string[]) => {
  const targetColumns = await getTargetColumnNames(config)
  const sourceColumnSet = new Set(sourceColumnNames)

  return targetColumns
    .map((targetColumn) => {
      return getMappedExpression(config, targetColumn, sourceColumnSet)
    })
    .filter((mapping): mapping is {expression: string; targetColumn: string} => {
      return mapping !== null
    })
}

const getCount = async (sql: string) => {
  const rows = await getAppDatabaseService().queryJson<{count: number}>(sql)
  return Number(rows[0]?.count ?? 0)
}

const getSourceRowCount = async (client: Client, config: TableConfig) => {
  const result = await client.query<{count: string}>(
    `SELECT COUNT(*)::text AS count FROM ${quoteIdentifier(config.sourceTable)}`,
  )
  return Number.parseInt(result.rows[0]?.count ?? '0', 10)
}

const getTargetRowCount = async (config: TableConfig) => {
  return getCount(`SELECT COUNT(*) AS count FROM ${quoteQualifiedName(config.targetSchema, config.targetTable)}`)
}

const getHasExistingImportData = async (configs: TableConfig[]): Promise<boolean> => {
  if (configs.length === 0) {
    return false
  }

  const [currentConfig, ...remainingConfigs] = configs
  const currentCount = currentConfig ? await getTargetRowCount(currentConfig) : 0
  return currentCount > 0 ? true : getHasExistingImportData(remainingConfigs)
}

const clearQualifiedTables = async (qualifiedTables: Array<readonly [string, string]>): Promise<void> => {
  if (qualifiedTables.length === 0) {
    return
  }

  const [currentTable, ...remainingTables] = qualifiedTables

  if (!currentTable) {
    return clearQualifiedTables(remainingTables)
  }

  await getAppDatabaseService().run(`DELETE FROM ${quoteQualifiedName(currentTable[0], currentTable[1])}`)
  return clearQualifiedTables(remainingTables)
}

const clearTargetTables = async (configs: TableConfig[]) => {
  const appTablesInReverseOrder = [...configs].reverse().map((config): readonly [string, string] => {
    return [config.targetSchema, config.targetTable]
  })
  await clearQualifiedTables([...martTableNames, ...appTablesInReverseOrder, ['app', 'user_config'] as const])
}

const recreateDuckdbDatabase = async () => {
  await closeImporterServices()

  if (env.DUCKDB_PATH !== ':memory:') {
    rmSync(env.DUCKDB_PATH, {force: true})
  }

  await migrateDuckdb()
  await closeImporterServices()
}

const setDuckdbImportSettings = async (importThreads: number) => {
  await getAppDatabaseService().run('SET preserve_insertion_order = false')
  await getAppDatabaseService().run(`SET threads = ${String(importThreads)}`)
}

const resetDuckdbImportSettings = async () => {
  await getAppDatabaseService().run('SET preserve_insertion_order = true')
}

const getSourceSelectColumns = (
  config: TableConfig,
  mappedColumns: Array<{expression: string; targetColumn: string}>,
  sourceColumnNames: string[],
) => {
  const requiredColumns = mappedColumns.reduce<string[]>((columns, mapping) => {
    const sourceColumn = config.rename?.[mapping.targetColumn] ?? mapping.targetColumn

    if (config.extraColumns?.[mapping.targetColumn]) {
      return columns
    }

    return columns.includes(sourceColumn) ? columns : [...columns, sourceColumn]
  }, [])
  const dedupeColumns = (config.dedupeKey ?? []).reduce<string[]>((columns, columnName) => {
    return columns.includes(columnName) ? columns : [...columns, columnName]
  }, requiredColumns)
  const orderingColumns = ['updated_at', 'created_at', 'id'].reduce<string[]>((columns, columnName) => {
    return config.dedupeKey && sourceColumnNames.includes(columnName) && !columns.includes(columnName)
      ? [...columns, columnName]
      : columns
  }, dedupeColumns)

  return (config.sourceComputedColumns ?? []).reduce<string[]>((columns, columnName) => {
    return columns.includes(columnName) ? columns : [...columns, columnName]
  }, orderingColumns)
}

const getSourceOrderByClause = (config: TableConfig, sourceColumnNames: string[]) => {
  if (!config.dedupeKey || config.dedupeKey.length === 0) {
    return ''
  }

  const orderColumns = (config.dedupeKey ?? []).reduce<string[]>((columns, columnName) => {
    return sourceColumnNames.includes(columnName) && !columns.includes(columnName) ? [...columns, columnName] : columns
  }, [])
  const timestampColumns = ['updated_at', 'created_at'].reduce<string[]>((columns, columnName) => {
    return sourceColumnNames.includes(columnName)
      ? [...columns, `${quoteIdentifier(columnName)} DESC NULLS LAST`]
      : columns
  }, orderColumns.map(quoteIdentifier))
  const idColumns = sourceColumnNames.includes('id')
    ? [...timestampColumns, `${quoteIdentifier('id')} DESC`]
    : timestampColumns

  return idColumns.length === 0 ? '' : ` ORDER BY ${idColumns.join(', ')}`
}

const getSelectList = (columnNames: string[]) => {
  return columnNames
    .map((columnName) => {
      return quoteIdentifier(columnName)
    })
    .join(', ')
}

const getSourceRelationSql = (config: TableConfig) => {
  return config.sourceRelationSql ?? quoteIdentifier(config.sourceTable)
}

const getCursorName = (tableName: string) => {
  return `duck_import_${tableName.replaceAll(/[^a-zA-Z0-9_]/g, '_')}_${Date.now()}`
}

const declareCursor = async (client: Client, config: TableConfig, selectList: string, cursorName: string) => {
  const sourceColumnNames = await getSourceColumnNames(client, config)
  const orderByClause = getSourceOrderByClause(config, sourceColumnNames)

  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  await client.query('SET LOCAL statement_timeout TO 0')
  await client.query(
    `DECLARE ${quoteIdentifier(cursorName)} NO SCROLL CURSOR FOR SELECT ${selectList} FROM ${getSourceRelationSql(config)}${orderByClause}`,
  )
}

const getCursorBatchRows = async (client: Client, cursorName: string, batchSize: number) => {
  const result = await client.query<Record<string, unknown>>(
    `FETCH FORWARD ${Math.max(1, Math.trunc(batchSize))} FROM ${quoteIdentifier(cursorName)}`,
  )
  return result.rows
}

const closeCursor = async (client: Client, cursorName: string) => {
  try {
    await client.query(`CLOSE ${quoteIdentifier(cursorName)}`)
  } finally {
    await client.query('COMMIT')
  }
}

const getCollisionKey = (row: Record<string, unknown>, columns: string[]) => {
  return JSON.stringify(
    columns.map((columnName) => {
      return row[columnName] ?? null
    }),
  )
}

const getCollisionRows = (rows: Record<string, unknown>[], columns: string[]) => {
  return rows.reduce<{collisions: number; dedupedRows: Record<string, unknown>[]}>(
    (result, row) => {
      const key = getCollisionKey(row, columns)
      const previousRow = result.dedupedRows[result.dedupedRows.length - 1]
      const previousKey = previousRow ? getCollisionKey(previousRow, columns) : null

      return previousKey !== key
        ? {...result, dedupedRows: [...result.dedupedRows, row]}
        : {...result, collisions: result.collisions + 1}
    },
    {collisions: 0, dedupedRows: []},
  )
}

const getBatchFilePath = (tempDirectory: string, config: TableConfig, batchNumber: number) => {
  const fileName = `${config.targetSchema}_${config.targetTable}_${String(batchNumber).padStart(8, '0')}.jsonl`
  return join(tempDirectory, fileName)
}

const getEncodedBatchRow = (row: Record<string, unknown>): EncodedBatchRow => {
  const text = JSON.stringify(row)
  return {bytes: Buffer.byteLength(text, 'utf8') + 1, text}
}

const getEncodedBatchRows = (rows: Record<string, unknown>[]) => {
  return rows.map(getEncodedBatchRow)
}

const getEffectiveBatchSize = (config: TableConfig, options: ImportOptions) => {
  const requestedBatchSize = options.batchSizeExplicit ? options.batchSize : (config.batchSize ?? options.batchSize)
  return config.maxBatchRows == null ? requestedBatchSize : Math.min(requestedBatchSize, config.maxBatchRows)
}

const splitEncodedRowsByBytes = (
  encodedRows: EncodedBatchRow[],
  maxBatchBytes: number | null,
  currentBatch: EncodedBatchRow[] = [],
  currentBytes = 0,
  completedBatches: EncodedBatchRow[][] = [],
): EncodedBatchRow[][] => {
  if (encodedRows.length === 0) {
    return currentBatch.length === 0 ? completedBatches : [...completedBatches, currentBatch]
  }

  const [currentRow, ...remainingRows] = encodedRows

  if (!currentRow) {
    return currentBatch.length === 0 ? completedBatches : [...completedBatches, currentBatch]
  }

  const exceedsLimit =
    maxBatchBytes !== null && currentBatch.length > 0 && currentBytes + currentRow.bytes > maxBatchBytes

  return exceedsLimit
    ? splitEncodedRowsByBytes(encodedRows, maxBatchBytes, [], 0, [...completedBatches, currentBatch])
    : splitEncodedRowsByBytes(
        remainingRows,
        maxBatchBytes,
        [...currentBatch, currentRow],
        currentBytes + currentRow.bytes,
        completedBatches,
      )
}

const ndjsonChunkSize = 25

const getCurrentBatchChunk = (rows: EncodedBatchRow[]) => {
  return rows.slice(0, ndjsonChunkSize)
}

const getRemainingBatchRows = (rows: EncodedBatchRow[]) => {
  return rows.slice(ndjsonChunkSize)
}

const getBatchChunkText = (rows: EncodedBatchRow[]) => {
  return `${rows
    .map((row) => {
      return row.text
    })
    .join('\n')}\n`
}

const writeBatchRows = async (filePath: string, rows: EncodedBatchRow[]): Promise<void> => {
  if (rows.length === 0) {
    return
  }

  appendFileSync(filePath, getBatchChunkText(getCurrentBatchChunk(rows)), 'utf8')
  return writeBatchRows(filePath, getRemainingBatchRows(rows))
}

const writeBatchFile = async (filePath: string, rows: EncodedBatchRow[]) => {
  writeFileSync(filePath, '', 'utf8')
  return writeBatchRows(filePath, rows)
}

const insertBatchRows = async (
  config: TableConfig,
  mappedColumns: Array<{expression: string; targetColumn: string}>,
  rows: EncodedBatchRow[],
  tempDirectory: string,
  batchNumber: number,
) => {
  if (rows.length === 0) {
    return 0
  }

  const filePath = getBatchFilePath(tempDirectory, config, batchNumber)
  const ndjsonOptions =
    config.ndjsonMaximumObjectSizeBytes == null
      ? ''
      : `, maximum_object_size = ${String(config.ndjsonMaximumObjectSizeBytes)}`
  await writeBatchFile(filePath, rows)

  try {
    await getAppDatabaseService().run(`
      INSERT INTO ${quoteQualifiedName(config.targetSchema, config.targetTable)} (
        ${mappedColumns
          .map((mapping) => {
            return quoteIdentifier(mapping.targetColumn)
          })
          .join(', ')}
      )
      SELECT
        ${mappedColumns
          .map((mapping) => {
            return `${mapping.expression} AS ${quoteIdentifier(mapping.targetColumn)}`
          })
          .join(',\n        ')}
      FROM read_ndjson_auto(${getSqlLiteral(filePath)}${ndjsonOptions}) source_row
    `)
    return rows.length
  } finally {
    rmSync(filePath, {force: true})
  }
}

const withDuckdbTransaction = async <T>(run: () => Promise<T>): Promise<T> => {
  await getAppDatabaseService().run('BEGIN TRANSACTION')

  try {
    const result = await run()
    await getAppDatabaseService().run('COMMIT')
    return result
  } catch (error) {
    try {
      await getAppDatabaseService().run('ROLLBACK')
    } catch {
      throw error
    }
    throw error
  }
}

const insertEncodedRowBatches = async (params: {
  batchNumber: number
  config: TableConfig
  encodedBatches: EncodedBatchRow[][]
  importedRows: number
  mappedColumns: Array<{expression: string; targetColumn: string}>
  tempDirectory: string
}): Promise<{batchNumber: number; importedRows: number}> => {
  if (params.encodedBatches.length === 0) {
    return {batchNumber: params.batchNumber, importedRows: params.importedRows}
  }

  const [currentBatch, ...remainingBatches] = params.encodedBatches

  if (!currentBatch) {
    return {batchNumber: params.batchNumber, importedRows: params.importedRows}
  }

  const insertedRows = await insertBatchRows(
    params.config,
    params.mappedColumns,
    currentBatch,
    params.tempDirectory,
    params.batchNumber,
  )

  return insertEncodedRowBatches({
    ...params,
    batchNumber: params.batchNumber + 1,
    encodedBatches: remainingBatches,
    importedRows: params.importedRows + insertedRows,
  })
}

const logImportProgress = (config: TableConfig, processedRows: number, batchNumber: number) => {
  if (batchNumber % 50 === 0) {
    console.log(`[import:duckdb] ${getImportTargetName(config)} scanned ${processedRows}`)
  }
}

const importCursorBatches = async (params: {
  batchNumber: number
  batchSize: number
  client: Client
  collisionKey: string[] | null
  config: TableConfig
  cursorName: string
  importedRows: number
  mappedColumns: Array<{expression: string; targetColumn: string}>
  pendingRows: Record<string, unknown>[]
  processedRows: number
  skippedRows: number
  tempDirectory: string
}): Promise<{importedRows: number; skippedRows: number}> => {
  const batchRows = await getCursorBatchRows(params.client, params.cursorName, params.batchSize)

  if (batchRows.length === 0) {
    if (params.collisionKey === null || params.pendingRows.length === 0) {
      return {importedRows: params.importedRows, skippedRows: params.skippedRows}
    }

    const deduped = getCollisionRows(params.pendingRows, params.collisionKey)
    const insertedResult = await insertEncodedRowBatches({
      batchNumber: params.batchNumber,
      config: params.config,
      encodedBatches: splitEncodedRowsByBytes(
        getEncodedBatchRows(deduped.dedupedRows),
        params.config.maxBatchBytes ?? null,
      ),
      importedRows: 0,
      mappedColumns: params.mappedColumns,
      tempDirectory: params.tempDirectory,
    })

    return {
      importedRows: params.importedRows + insertedResult.importedRows,
      skippedRows: params.skippedRows + deduped.collisions,
    }
  }

  logImportProgress(params.config, params.processedRows + batchRows.length, params.batchNumber)

  if (params.collisionKey === null) {
    const insertedResult = await insertEncodedRowBatches({
      batchNumber: params.batchNumber,
      config: params.config,
      encodedBatches: splitEncodedRowsByBytes(getEncodedBatchRows(batchRows), params.config.maxBatchBytes ?? null),
      importedRows: 0,
      mappedColumns: params.mappedColumns,
      tempDirectory: params.tempDirectory,
    })

    return importCursorBatches({
      ...params,
      batchNumber: insertedResult.batchNumber,
      importedRows: params.importedRows + insertedResult.importedRows,
      processedRows: params.processedRows + batchRows.length,
    })
  }

  const combinedRows = [...params.pendingRows, ...batchRows]
  const lastRow = combinedRows[combinedRows.length - 1] ?? null
  const boundaryKey = lastRow ? getCollisionKey(lastRow, params.collisionKey) : null
  const committedRows =
    boundaryKey === null
      ? combinedRows
      : combinedRows.filter((row) => {
          return getCollisionKey(row, params.collisionKey ?? []) !== boundaryKey
        })
  const nextPendingRows =
    boundaryKey === null
      ? []
      : combinedRows.filter((row) => {
          return getCollisionKey(row, params.collisionKey ?? []) === boundaryKey
        })
  const deduped = getCollisionRows(committedRows, params.collisionKey)
  const insertedResult = await insertEncodedRowBatches({
    batchNumber: params.batchNumber,
    config: params.config,
    encodedBatches: splitEncodedRowsByBytes(
      getEncodedBatchRows(deduped.dedupedRows),
      params.config.maxBatchBytes ?? null,
    ),
    importedRows: 0,
    mappedColumns: params.mappedColumns,
    tempDirectory: params.tempDirectory,
  })

  return importCursorBatches({
    ...params,
    batchNumber: insertedResult.batchNumber,
    importedRows: params.importedRows + insertedResult.importedRows,
    pendingRows: nextPendingRows,
    processedRows: params.processedRows + batchRows.length,
    skippedRows: params.skippedRows + deduped.collisions,
  })
}

const importTable = async (
  client: Client,
  config: TableConfig,
  options: ImportOptions,
  tempDirectory: string,
): Promise<TableReport> => {
  const exists = await getSourceTableExists(client, config)

  if (!exists) {
    const finalRows = await getTargetRowCount(config)
    return {
      finalRows,
      importedRows: 0,
      mapping: getTableMappingReport(config, [], []),
      missing: true,
      skippedRows: 0,
      sourceRows: 0,
    }
  }

  const sourceRows = await getSourceRowCount(client, config)
  const sourceColumnNames = await getSourceColumnNames(client, config)
  const mappedColumns = await getMappedColumns(config, sourceColumnNames)
  const mapping = getTableMappingReport(config, mappedColumns, sourceColumnNames)

  if (mappedColumns.length === 0) {
    const finalRows = await getTargetRowCount(config)
    return {
      finalRows,
      importedRows: 0,
      mapping,
      missing: false,
      skippedRows: Math.max(0, sourceRows - finalRows),
      sourceRows,
    }
  }

  const batchSize = getEffectiveBatchSize(config, options)
  const cursorName = getCursorName(config.sourceTable)
  const sourceSelectColumns = getSourceSelectColumns(config, mappedColumns, sourceColumnNames)

  await declareCursor(client, config, getSelectList(sourceSelectColumns), cursorName)

  try {
    const batchBytesSuffix =
      config.maxBatchBytes == null ? '' : `, max batch bytes ${Math.round(config.maxBatchBytes / 1024 / 1024)}MB`
    console.log(`[import:duckdb] ${getImportTargetName(config)} using batch size ${batchSize}${batchBytesSuffix}`)
    const result = await withDuckdbTransaction(async () => {
      return importCursorBatches({
        batchNumber: 1,
        batchSize,
        client,
        collisionKey: config.dedupeKey ?? null,
        config,
        cursorName,
        importedRows: 0,
        mappedColumns,
        pendingRows: [],
        processedRows: 0,
        skippedRows: 0,
        tempDirectory,
      })
    })

    const finalRows = await getTargetRowCount(config)
    return {
      finalRows,
      importedRows: result.importedRows,
      mapping,
      missing: false,
      skippedRows: result.skippedRows,
      sourceRows,
    }
  } finally {
    await closeCursor(client, cursorName)
  }
}

const getBootstrapLocalUser = () => {
  const envEntries = [
    ['LOCAL_USER_NAME', process.env['LOCAL_USER_NAME']],
    ['LOCAL_USER_EMAIL', process.env['LOCAL_USER_EMAIL']],
    ['LOCAL_USER_ROLE', process.env['LOCAL_USER_ROLE']],
  ].filter((entry): entry is [string, string] => {
    return typeof entry[1] === 'string' && entry[1].trim() !== ''
  })
  const envValues = Object.fromEntries(envEntries)

  return {
    email: envValues['LOCAL_USER_EMAIL']?.trim() || localUserDefaults.email,
    envKeysUsed: envEntries.map(([key]) => {
      return key
    }),
    id: localUserDefaults.id,
    name: envValues['LOCAL_USER_NAME']?.trim() || localUserDefaults.name,
    unpaywallEmail: localUserDefaults.unpaywallEmail,
    role: envValues['LOCAL_USER_ROLE']?.trim() || localUserDefaults.role,
  }
}

const getSourceUserCount = async (client: Client) => {
  const exists = await getSourceTableExists(client, {
    sourceTable: 'user',
    targetSchema: 'app',
    targetTable: 'user_config',
  })

  if (!exists) {
    return 0
  }

  const result = await client.query<{count: string}>(`SELECT COUNT(*)::text AS count FROM ${quoteIdentifier('user')}`)
  return Number.parseInt(result.rows[0]?.count ?? '0', 10)
}

const bootstrapLocalUser = async (client: Client) => {
  const localUser = getBootstrapLocalUser()
  const sourceUserCount = await getSourceUserCount(client)

  await getAppDatabaseService().run(`DELETE FROM app.user_config`)
  await getAppDatabaseService().run(`
    INSERT INTO app.user_config (
      id,
      name,
      email,
      role,
      unpaywall_email,
      created_at,
      updated_at
    )
    VALUES (
      ${getSqlLiteral(localUser.id)},
      ${getSqlLiteral(localUser.name)},
      ${getSqlLiteral(localUser.email)},
      ${getSqlLiteral(localUser.role)},
      ${getSqlLiteral(localUser.unpaywallEmail)},
      current_timestamp,
      current_timestamp
    )
  `)

  return {...localUser, sourceUserCount}
}

const getMartCounts = async () => {
  const rows = await getAppDatabaseService().queryJson<{row_count: number; table_name: string}>(`
    SELECT 'project_scope_article' AS table_name, COUNT(*) AS row_count FROM mart.project_scope_article
    UNION ALL
    SELECT 'judgment_fact' AS table_name, COUNT(*) AS row_count FROM mart.judgment_fact
    UNION ALL
    SELECT 'prompt_answer_fact' AS table_name, COUNT(*) AS row_count FROM mart.prompt_answer_fact
    UNION ALL
    SELECT 'review_article_rollup' AS table_name, COUNT(*) AS row_count FROM mart.review_article_rollup
  `)

  return rows.reduce<Record<string, number>>((counts, row) => {
    return {...counts, [row.table_name]: Number(row.row_count ?? 0)}
  }, {})
}

const importSelectedTables = async (
  client: Client,
  configs: TableConfig[],
  options: ImportOptions,
  report: ImportReport,
  reportPath: string,
  tempDirectory: string,
): Promise<ImportReport> => {
  if (configs.length === 0) {
    return report
  }

  const [currentConfig, ...remainingConfigs] = configs

  if (!currentConfig) {
    return importSelectedTables(client, remainingConfigs, options, report, reportPath, tempDirectory)
  }

  const currentTableName = getImportTargetName(currentConfig)
  const nextReport = {...report, currentTable: currentTableName}
  await writeReport(reportPath, nextReport)
  console.log(`[import:duckdb] ${currentTableName}`)
  const tableReport = await importTable(client, currentConfig, options, tempDirectory)
  const updatedReport = {
    ...nextReport,
    currentTable: null,
    tables: {...nextReport.tables, [currentTableName]: tableReport},
  }

  await writeReport(reportPath, updatedReport)
  return importSelectedTables(client, remainingConfigs, options, updatedReport, reportPath, tempDirectory)
}

const closeImporterServices = async () => {
  await getAppDatabaseService().close()
}

const ensureDuckdbSchemaIsCurrent = async () => {
  await migrateDuckdb()
}

const importPostgresToDuckdb = async () => {
  const options = getArgs()
  validateOptions(options)
  const configuredTables = getSelectedTableConfigs(options)
  const sourceDatabaseUrl = getSourceDatabaseUrl()
  const report = options.resume
    ? await getResumeReport(options.reportPath, sourceDatabaseUrl)
    : createReport(sourceDatabaseUrl, configuredTables, options.reportPath)
  const selectedTables = options.resume ? getResumeTableConfigs(report) : configuredTables
  const client = new Client({connectionString: sourceDatabaseUrl})
  const tempDirectory = mkdtempSync(join(tmpdir(), 'forska-duck-import-'))

  await ensureDuckdbSchemaIsCurrent()
  await writeReport(options.reportPath, report)

  if (options.clear && !options.resume) {
    await recreateDuckdbDatabase()
  }

  await client.connect()
  await setDuckdbImportSettings(options.importThreads)

  try {
    if (!options.clear && !options.resume && (await getHasExistingImportData(selectedTables))) {
      throw new Error('DuckDB already contains imported app data. Re-run with --clear to replace it.')
    }

    if (options.resume && report.currentTable) {
      const currentConfig = getTableConfigsFromNames([report.currentTable])[0]

      if (currentConfig) {
        await clearTargetTables([currentConfig])
      }
    }

    if (selectedTables.length === 0) {
      console.log('[import:duckdb] nothing left to import')
      return
    }

    const importedReport = await importSelectedTables(
      client,
      selectedTables,
      options,
      report,
      options.reportPath,
      tempDirectory,
    )
    const userBootstrap = await bootstrapLocalUser(client)
    if (options.rebuildMarts) {
      await getDuckdbMartService().rebuildAll()
    }
    const martCounts = options.rebuildMarts ? await getMartCounts() : null
    const completedReport = {
      ...importedReport,
      currentTable: null,
      finishedAt: new Date().toISOString(),
      martCounts,
      status: 'completed' as const,
      userBootstrap,
    }

    await writeReport(options.reportPath, completedReport)
    if (!options.rebuildMarts) {
      console.log('[import:duckdb] skipped mart rebuild; run `bun run db:duck:rebuild-marts` later if needed')
    }
    console.log(`[import:duckdb] wrote report to ${options.reportPath}`)
  } finally {
    await resetDuckdbImportSettings()
    rmSync(tempDirectory, {force: true, recursive: true})
    await client.end()
    await closeImporterServices()
  }
}

void withDuckdbMaintenanceAccess('postgres to duckdb import', async () => {
  await importPostgresToDuckdb()
}).catch(async (error) => {
  await closeImporterServices()
  throw error
})
