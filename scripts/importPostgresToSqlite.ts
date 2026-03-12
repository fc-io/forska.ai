import {Client} from 'pg'

import {env} from '../src/server/utils/env.ts'
import {getSqliteClient} from '../src/server/utils/getDatabase.ts'
import {localUserDefaults} from '../src/utils/localUser.ts'

type ImportOptions = {clear: boolean; batchSize: number; reportPath: string; fromTable: string | null; resume: boolean}

type TableConfig = {
  tableName: string
  sourceTableName?: string
  pagination: 'id' | 'all'
  rename?: Record<string, string>
  collisionKey?: string[]
  batchSize?: number
}

type ImportProgress = {startedAtMs: number; lastLoggedAtMs: number}

type TableReport = {
  sourceRows: number
  importedRows: number
  finalRows?: number
  skippedRows: number
  missing: boolean
  collisions: Array<{key: string; keptId: string | null; droppedIds: string[]}>
}

type ImportReport = {
  sourceDatabaseUrl: string
  sqlitePath: string
  clearRequested: boolean
  batchSize: number
  startedAt: string
  finishedAt: string | null
  status?: 'running' | 'completed'
  currentTable?: string | null
  tables: Record<string, TableReport>
  userBootstrap: {
    id: string
    name: string
    email: string
    role: string | null
    openalexMailto: string | null
    sourceUserCount: number
    envKeysUsed: string[]
  } | null
}

const importTables: TableConfig[] = [
  {tableName: 'models', pagination: 'id', batchSize: 5000},
  {tableName: 'datasource', pagination: 'id', batchSize: 5000},
  {tableName: 'import_route', pagination: 'id', batchSize: 5000},
  {tableName: 'datasource_route_link', pagination: 'id', batchSize: 10000},
  {tableName: 'articles', pagination: 'id', batchSize: 1000},
  {tableName: 'article_route_link', pagination: 'id', batchSize: 10000},
  {tableName: 'projects', pagination: 'id', batchSize: 5000},
  {tableName: 'project_route_link', pagination: 'id', batchSize: 10000},
  {tableName: 'comparison_project', pagination: 'id', batchSize: 5000},
  {tableName: 'comparison_project_route_link', pagination: 'id', batchSize: 10000},
  {
    tableName: 'judgments_jobs',
    pagination: 'id',
    rename: {cursor_last_created_at: 'ch_cursor_last_date', cursor_last_article_id: 'ch_cursor_last_article_id'},
    batchSize: 5000,
  },
  {tableName: 'prompts', pagination: 'id', batchSize: 5000},
  {tableName: 'judgments_jobs_prompts', pagination: 'id', batchSize: 5000},
  {tableName: 'project_prompts', pagination: 'id', batchSize: 5000},
  {tableName: 'comparison_project_prompt', pagination: 'id', batchSize: 5000},
  {tableName: 'judgments', pagination: 'id', batchSize: 5000},
  {
    tableName: 'judgments_human',
    pagination: 'all',
    collisionKey: ['project_id', 'article_id', 'prompt_id'],
    batchSize: 5000,
  },
  {tableName: 'project_articles', pagination: 'id', batchSize: 10000},
  {tableName: 'token_use', pagination: 'id', batchSize: 20000},
  {tableName: 'reviews', pagination: 'all', collisionKey: ['project_id', 'article_id'], batchSize: 5000},
  {tableName: 'judgment_assessments', pagination: 'all', collisionKey: ['judgment_id'], batchSize: 5000},
  {tableName: 'llm_status', pagination: 'id', batchSize: 20000},
  {tableName: 'nvidia_smi', pagination: 'id', batchSize: 20000},
  {tableName: 'sync_state', pagination: 'all', batchSize: 5000},
]

const getArgs = (): ImportOptions => {
  const args = process.argv.slice(2)
  const batchArg = args.find((arg) => {
    return arg.startsWith('--batch-size=')
  })
  const reportArg = args.find((arg) => {
    return arg.startsWith('--report=')
  })
  const fromTableArg = args.find((arg) => {
    return arg.startsWith('--from-table=')
  })
  const batchSize = Number.parseInt(batchArg?.split('=')[1] ?? '1000', 10)

  return {
    clear: args.includes('--clear'),
    batchSize: Number.isFinite(batchSize) && batchSize > 0 ? batchSize : 1000,
    reportPath: reportArg?.split('=')[1] ?? './data/local-first-import-report.json',
    fromTable: fromTableArg?.split('=')[1] ?? null,
    resume: args.includes('--resume'),
  }
}

const getImportTablesFromTable = (fromTable: string | null) => {
  if (!fromTable) {
    return importTables
  }

  const startIndex = importTables.findIndex((config) => {
    return config.tableName === fromTable
  })

  if (startIndex === -1) {
    throw new Error(
      `Unknown table '${fromTable}'. Expected one of: ${importTables
        .map((config) => {
          return config.tableName
        })
        .join(', ')}`,
    )
  }

  return importTables.slice(startIndex)
}

const validateOptions = (options: ImportOptions) => {
  if (options.clear && options.resume) {
    throw new Error('Use either --clear or --resume, not both in the same run.')
  }

  if (options.fromTable && options.resume) {
    throw new Error('Use either --from-table or --resume, not both in the same run.')
  }
}

const getCursorName = (tableName: string) => {
  const sanitizedTableName = tableName.replaceAll(/[^a-zA-Z0-9_]/g, '_')
  return `f1_import_${sanitizedTableName}_${Date.now()}`
}

const logImportProgress = (tableName: string, processedRows: number, progress: ImportProgress) => {
  const now = Date.now()

  if (processedRows === 0 || now - progress.lastLoggedAtMs < 2000) {
    return progress
  }

  const elapsedSeconds = Math.max(1, Math.round((now - progress.startedAtMs) / 1000))
  const rowsPerSecond = Math.round(processedRows / elapsedSeconds)
  console.log(`[import] ${tableName}: scanned ${processedRows} rows (${rowsPerSecond}/s)`)
  return {...progress, lastLoggedAtMs: now}
}

const getResumeTableName = (report: ImportReport) => {
  if (report.currentTable) {
    return report.currentTable
  }

  return (
    importTables.find((config) => {
      return report.tables[config.tableName] == null
    })?.tableName ?? null
  )
}

const getSelectedImportTables = (options: ImportOptions, report: ImportReport) => {
  if (!options.resume) {
    return getImportTablesFromTable(options.fromTable)
  }

  const resumeTableName = getResumeTableName(report)
  return resumeTableName ? getImportTablesFromTable(resumeTableName) : []
}

const quoteIdentifier = (value: string) => {
  return `"${value.replaceAll('"', '""')}"`
}

const getSourceDatabaseUrl = () => {
  const databaseUrl = String(process.env['DATABASE_URL'] ?? '').trim()

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to import from PostgreSQL')
  }

  return databaseUrl
}

const getTargetColumnNames = (tableName: string) => {
  const sqlite = getSqliteClient()
  const rows = sqlite.query(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as Array<{name?: string}>
  return rows
    .map((row) => {
      return row.name ?? ''
    })
    .filter((value) => {
      return value !== ''
    })
}

const getSourceColumnNames = async (client: Client, tableName: string) => {
  const result = await client.query<{column_name: string}>(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
    `,
    [tableName],
  )

  return result.rows.map((row) => {
    return row.column_name
  })
}

const getSourceTableExists = async (client: Client, tableName: string) => {
  const result = await client.query<{exists: string | null}>(`SELECT to_regclass($1) AS exists`, [
    `public.${tableName}`,
  ])
  return result.rows[0]?.exists !== null
}

const getColumnMappings = async (client: Client, config: TableConfig) => {
  const sourceTableName = config.sourceTableName ?? config.tableName
  const targetColumns = getTargetColumnNames(config.tableName)
  const sourceColumns = await getSourceColumnNames(client, sourceTableName)
  const sourceColumnSet = new Set(sourceColumns)

  return targetColumns
    .map((targetColumn) => {
      const renamedSourceColumn = config.rename?.[targetColumn] ?? targetColumn
      return sourceColumnSet.has(renamedSourceColumn) ? {targetColumn, sourceColumn: renamedSourceColumn} : null
    })
    .filter((entry): entry is {targetColumn: string; sourceColumn: string} => {
      return entry !== null
    })
}

const getSelectList = (mappings: Array<{targetColumn: string; sourceColumn: string}>) => {
  return mappings
    .map((mapping) => {
      return `${quoteIdentifier(mapping.sourceColumn)} AS ${quoteIdentifier(mapping.targetColumn)}`
    })
    .join(', ')
}

const getTableCount = async (client: Client, tableName: string) => {
  const result = await client.query<{count: string}>(
    `SELECT COUNT(*)::text AS count FROM ${quoteIdentifier(tableName)}`,
  )
  return Number.parseInt(result.rows[0]?.count ?? '0', 10)
}

const getCursorBatchRows = async (client: Client, batchSize: number, cursorName: string) => {
  const result = await client.query<Record<string, unknown>>(
    `
      FETCH FORWARD ${Math.max(1, Math.trunc(batchSize))} FROM ${quoteIdentifier(cursorName)}
    `,
  )

  return result.rows
}

const declareCursor = async (client: Client, config: TableConfig, selectList: string, cursorName: string) => {
  const sourceTableName = config.sourceTableName ?? config.tableName
  const orderByClause =
    config.pagination === 'all' && config.collisionKey
      ? ` ORDER BY ${config.collisionKey.map(quoteIdentifier).join(', ')}, updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC`
      : ''

  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  await client.query('SET LOCAL statement_timeout TO 0')
  await client.query(
    `
      DECLARE ${quoteIdentifier(cursorName)} NO SCROLL CURSOR FOR
      SELECT ${selectList}
      FROM ${quoteIdentifier(sourceTableName)}${orderByClause}
    `,
  )
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
    columns.map((column) => {
      return row[column] ?? null
    }),
  )
}

const getCollisionRows = (rows: Record<string, unknown>[], columns: string[]) => {
  return rows.reduce<{
    dedupedRows: Record<string, unknown>[]
    collisions: Array<{key: string; keptId: string | null; droppedIds: string[]}>
  }>(
    (acc, row) => {
      const key = getCollisionKey(row, columns)
      const previous = acc.dedupedRows[acc.dedupedRows.length - 1]
      const previousKey = previous ? getCollisionKey(previous, columns) : null

      if (previousKey !== key) {
        return {...acc, dedupedRows: [...acc.dedupedRows, row]}
      }

      const previousId = typeof previous?.id === 'string' ? previous.id : null
      const currentId = typeof row.id === 'string' ? row.id : null
      const lastCollision = acc.collisions[acc.collisions.length - 1]
      const collisions =
        lastCollision?.key === key
          ? [
              ...acc.collisions.slice(0, -1),
              {...lastCollision, droppedIds: [...lastCollision.droppedIds, ...(currentId ? [currentId] : [])]},
            ]
          : [...acc.collisions, {key, keptId: previousId, droppedIds: currentId ? [currentId] : []}]

      return {...acc, collisions}
    },
    {dedupedRows: [], collisions: []},
  )
}

const getStatementChanges = (result: unknown) => {
  return typeof result === 'object' && result !== null && 'changes' in result && typeof result.changes === 'number'
    ? result.changes
    : 0
}

const getNormalizedValue = (columnName: string, value: unknown): unknown => {
  if (value === null || value === undefined) {
    return null
  }

  if (value instanceof Date) {
    return value.getTime()
  }

  if (typeof value === 'boolean') {
    return value ? 1 : 0
  }

  if (Array.isArray(value)) {
    return JSON.stringify(value)
  }

  if (typeof value === 'object') {
    return JSON.stringify(value)
  }

  if (
    typeof value === 'string'
    && /(^|_)(created_at|updated_at|deleted_at|last_import_at|date_from|date_to|sent_at|judged_at|started_at|finished_at|last_synced_at|ts)$/.exec(
      columnName,
    ) !== null
  ) {
    const parsedDate = new Date(value)
    return Number.isNaN(parsedDate.getTime()) ? value : parsedDate.getTime()
  }

  return value
}

const insertRows = (tableName: string, rows: Record<string, unknown>[], ignoreConflicts: boolean) => {
  if (rows.length === 0) {
    return 0
  }

  const sqlite = getSqliteClient()
  const columnNames = Object.keys(rows[0] ?? {})
  const placeholders = columnNames.map(() => {
    return '?'
  })
  const statement = sqlite.prepare(
    `${ignoreConflicts ? 'INSERT OR IGNORE' : 'INSERT'} INTO ${quoteIdentifier(tableName)} (${columnNames.map(quoteIdentifier).join(', ')}) VALUES (${placeholders.join(', ')})`,
  )

  sqlite.exec('BEGIN')

  try {
    const insertedRows = rows.reduce((count, row) => {
      const values = columnNames.map((columnName) => {
        return getNormalizedValue(columnName, row[columnName])
      })
      const result = (statement as {run: (...bindings: unknown[]) => unknown}).run(...values)
      return count + getStatementChanges(result)
    }, 0)
    sqlite.exec('COMMIT')
    return insertedRows
  } catch (error) {
    sqlite.exec('ROLLBACK')
    throw error
  }
}

const getTargetRowCount = (tableName: string) => {
  const sqlite = getSqliteClient()
  const row = sqlite.query(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`).get() as {
    count?: number
  } | null
  return row?.count ?? 0
}

const getHasExistingImportData = (tables: TableConfig[]) => {
  return tables.some((config) => {
    return getTargetRowCount(config.tableName) > 0
  })
}

const clearTargetTables = (tables: TableConfig[], clearUser: boolean) => {
  const sqlite = getSqliteClient()
  sqlite.exec('PRAGMA foreign_keys = OFF;')
  sqlite.exec('BEGIN')

  try {
    ;[...tables].reverse().forEach((config) => {
      sqlite.exec(`DELETE FROM ${quoteIdentifier(config.tableName)}`)
    })
    if (clearUser) {
      sqlite.exec(`DELETE FROM ${quoteIdentifier('user')}`)
    }
    sqlite.exec('COMMIT')
  } catch (error) {
    sqlite.exec('ROLLBACK')
    throw error
  } finally {
    sqlite.exec('PRAGMA foreign_keys = ON;')
  }
}

const withFastImportPragmas = async <T>(run: () => Promise<T>) => {
  const sqlite = getSqliteClient()

  sqlite.exec('PRAGMA foreign_keys = OFF;')
  sqlite.exec('PRAGMA synchronous = OFF;')
  sqlite.exec('PRAGMA temp_store = MEMORY;')
  sqlite.exec('PRAGMA cache_size = -200000;')
  sqlite.exec('PRAGMA wal_autocheckpoint = 0;')

  try {
    return await run()
  } finally {
    sqlite.exec('PRAGMA foreign_keys = ON;')
    sqlite.exec('PRAGMA synchronous = NORMAL;')
    sqlite.exec('PRAGMA temp_store = DEFAULT;')
    sqlite.exec('PRAGMA wal_autocheckpoint = 1000;')
    sqlite.exec('PRAGMA optimize;')
  }
}

const loadReport = async (reportPath: string) => {
  const reportFile = globalThis.Bun.file(reportPath)
  return (await reportFile.exists()) ? ((await reportFile.json()) as ImportReport) : null
}

const createReport = (options: ImportOptions, sourceDatabaseUrl: string): ImportReport => {
  return {
    sourceDatabaseUrl,
    sqlitePath: env.SQLITE_PATH,
    clearRequested: options.clear,
    batchSize: options.batchSize,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: 'running',
    currentTable: null,
    tables: {},
    userBootstrap: null,
  }
}

const getReport = async (options: ImportOptions, sourceDatabaseUrl: string): Promise<ImportReport> => {
  if (!options.resume) {
    return createReport(options, sourceDatabaseUrl)
  }

  const report = await loadReport(options.reportPath)

  if (!report) {
    throw new Error(`Cannot resume without an import report at ${options.reportPath}`)
  }

  if (report.sourceDatabaseUrl !== sourceDatabaseUrl) {
    throw new Error('Cannot resume import because DATABASE_URL does not match the saved report.')
  }

  if (report.sqlitePath !== env.SQLITE_PATH) {
    throw new Error('Cannot resume import because SQLITE_PATH does not match the saved report.')
  }

  if (report.status === 'completed') {
    throw new Error('Import report is already completed. Use --clear to start from an empty SQLite database.')
  }

  return {...report, clearRequested: false, batchSize: options.batchSize, finishedAt: null, status: 'running' as const}
}

const getReportedFinalRows = (tableReport: TableReport | undefined) => {
  return tableReport?.finalRows ?? tableReport?.importedRows ?? 0
}

const validateResumeState = (report: ImportReport, selectedTables: TableConfig[]) => {
  const resumeTableName = getResumeTableName(report)
  const resumeTableIndex = resumeTableName
    ? importTables.findIndex((config) => {
        return config.tableName === resumeTableName
      })
    : importTables.length
  const completedTables = importTables.slice(0, resumeTableIndex)

  completedTables.forEach((config) => {
    const expectedRows = getReportedFinalRows(report.tables[config.tableName])
    const actualRows = getTargetRowCount(config.tableName)

    if (expectedRows > actualRows) {
      throw new Error(
        `Cannot resume import because ${config.tableName} has ${actualRows} rows in SQLite but the report expects ${expectedRows}. Use --clear to restart from scratch.`,
      )
    }
  })

  if (report.currentTable && selectedTables[0]?.tableName !== report.currentTable) {
    throw new Error(
      `Cannot resume import because the saved current table '${report.currentTable}' does not match the selected resume point.`,
    )
  }
}

const getBootstrapLocalUser = () => {
  const keys = [
    ['LOCAL_USER_NAME', process.env['LOCAL_USER_NAME']],
    ['LOCAL_USER_EMAIL', process.env['LOCAL_USER_EMAIL']],
    ['LOCAL_USER_ROLE', process.env['LOCAL_USER_ROLE']],
    ['OPENALEX_MAILTO', process.env['OPENALEX_MAILTO']],
  ].filter((entry): entry is [string, string] => {
    return typeof entry[1] === 'string' && entry[1].trim() !== ''
  })
  const values = Object.fromEntries(keys)

  return {
    id: localUserDefaults.id,
    name: values['LOCAL_USER_NAME']?.trim() || localUserDefaults.name,
    email: values['LOCAL_USER_EMAIL']?.trim() || localUserDefaults.email,
    role: values['LOCAL_USER_ROLE']?.trim() || localUserDefaults.role,
    openalexMailto: values['OPENALEX_MAILTO']?.trim() || localUserDefaults.openalexMailto,
    envKeysUsed: keys.map(([key]) => {
      return key
    }),
  }
}

const getSourceUserCount = async (client: Client) => {
  const exists = await getSourceTableExists(client, 'user')

  return exists ? getTableCount(client, 'user') : 0
}

const bootstrapLocalUser = async (client: Client) => {
  const sqlite = getSqliteClient()
  const localUser = getBootstrapLocalUser()
  const now = Date.now()
  sqlite
    .prepare(
      `
        INSERT INTO ${quoteIdentifier('user')} (${quoteIdentifier('id')}, ${quoteIdentifier('name')}, ${quoteIdentifier('email')}, ${quoteIdentifier('role')}, ${quoteIdentifier('openalex_mailto')}, ${quoteIdentifier('created_at')}, ${quoteIdentifier('updated_at')})
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(${quoteIdentifier('id')}) DO UPDATE SET
          ${quoteIdentifier('name')} = excluded.${quoteIdentifier('name')},
          ${quoteIdentifier('email')} = excluded.${quoteIdentifier('email')},
          ${quoteIdentifier('role')} = excluded.${quoteIdentifier('role')},
          ${quoteIdentifier('openalex_mailto')} = excluded.${quoteIdentifier('openalex_mailto')},
          ${quoteIdentifier('updated_at')} = excluded.${quoteIdentifier('updated_at')}
      `,
    )
    .run(localUser.id, localUser.name, localUser.email, localUser.role, localUser.openalexMailto, now, now)

  return {...localUser, sourceUserCount: await getSourceUserCount(client)}
}

const writeReport = async (reportPath: string, report: ImportReport) => {
  await globalThis.Bun.write(reportPath, JSON.stringify(report, null, 2))
}

const importTable = async (client: Client, config: TableConfig, options: ImportOptions) => {
  const sourceTableName = config.sourceTableName ?? config.tableName
  const exists = await getSourceTableExists(client, sourceTableName)

  if (!exists) {
    const finalRows = getTargetRowCount(config.tableName)
    return {sourceRows: 0, importedRows: 0, finalRows, skippedRows: 0, missing: true, collisions: []}
  }

  const mappings = await getColumnMappings(client, config)
  const selectList = getSelectList(mappings)

  if (!selectList) {
    const finalRows = getTargetRowCount(config.tableName)
    return {sourceRows: 0, importedRows: 0, finalRows, skippedRows: 0, missing: false, collisions: []}
  }

  const cursorName = getCursorName(config.tableName)
  const batchSize = config.batchSize ?? options.batchSize
  const ignoreConflicts = getTargetRowCount(config.tableName) > 0
  let sourceRows = 0
  let importedRows = 0
  let collisions: TableReport['collisions'] = []
  let pendingCollisionRows: Record<string, unknown>[] = []
  let progress: ImportProgress = {startedAtMs: Date.now(), lastLoggedAtMs: 0}

  await declareCursor(client, config, selectList, cursorName)

  try {
    while (true) {
      const batchRows = await getCursorBatchRows(client, batchSize, cursorName)

      if (batchRows.length === 0) {
        break
      }

      sourceRows += batchRows.length

      if (config.pagination === 'all' && config.collisionKey) {
        const collisionKey = config.collisionKey
        const combinedRows = [...pendingCollisionRows, ...batchRows]
        const lastRow = combinedRows[combinedRows.length - 1] ?? null
        const boundaryKey = lastRow ? getCollisionKey(lastRow, collisionKey) : null
        const committedRows = boundaryKey
          ? combinedRows.filter((row) => {
              return getCollisionKey(row, collisionKey) !== boundaryKey
            })
          : combinedRows
        pendingCollisionRows = boundaryKey
          ? combinedRows.filter((row) => {
              return getCollisionKey(row, collisionKey) === boundaryKey
            })
          : []

        const deduped = getCollisionRows(committedRows, collisionKey)
        importedRows += insertRows(config.tableName, deduped.dedupedRows, ignoreConflicts)
        collisions = [...collisions, ...deduped.collisions]
      } else {
        importedRows += insertRows(config.tableName, batchRows, ignoreConflicts)
      }

      progress = logImportProgress(config.tableName, sourceRows, progress)
    }

    if (config.pagination === 'all' && config.collisionKey && pendingCollisionRows.length > 0) {
      const deduped = getCollisionRows(pendingCollisionRows, config.collisionKey)
      importedRows += insertRows(config.tableName, deduped.dedupedRows, ignoreConflicts)
      collisions = [...collisions, ...deduped.collisions]
    }
  } finally {
    await closeCursor(client, cursorName)
  }

  const finalRows = getTargetRowCount(config.tableName)

  console.log(`[import] ${config.tableName}: done (applied ${importedRows}/${sourceRows}, final ${finalRows})`)

  return {
    sourceRows,
    importedRows,
    finalRows,
    skippedRows: Math.max(0, sourceRows - finalRows),
    missing: false,
    collisions,
  }
}

const importPostgresToSqlite = async () => {
  const options = getArgs()
  validateOptions(options)
  const sourceDatabaseUrl = getSourceDatabaseUrl()
  const report = await getReport(options, sourceDatabaseUrl)
  const selectedTables = getSelectedImportTables(options, report)
  const client = new Client({connectionString: sourceDatabaseUrl})

  await client.connect()

  try {
    if (options.resume) {
      validateResumeState(report, selectedTables)
    }

    if (getHasExistingImportData(selectedTables) && !options.clear && !options.fromTable && !options.resume) {
      throw new Error('SQLite already contains imported data. Re-run with --clear to replace the current contents.')
    }

    if (options.clear || options.fromTable) {
      clearTargetTables(selectedTables, options.clear && !options.fromTable)
    }

    await writeReport(options.reportPath, report)

    await withFastImportPragmas(async () => {
      for (const config of selectedTables) {
        report.currentTable = config.tableName
        await writeReport(options.reportPath, report)
        console.log(`[import] ${config.tableName}`)
        report.tables[config.tableName] = await importTable(client, config, options)
        report.currentTable = null
        await writeReport(options.reportPath, report)
      }
    })

    report.userBootstrap = await bootstrapLocalUser(client)
    report.finishedAt = new Date().toISOString()
    report.status = 'completed'
    report.currentTable = null

    await writeReport(options.reportPath, report)
    console.log(`[import] wrote report to ${options.reportPath}`)
  } finally {
    await client.end()
  }
}

void importPostgresToSqlite()
