import {Client} from 'pg'

import {env} from '../src/server/utils/env.ts'
import {getSqliteClient} from '../src/server/utils/getDatabase.ts'
import {localUserDefaults} from '../src/utils/localUser.ts'

type ImportOptions = {clear: boolean; batchSize: number; reportPath: string}

type TableConfig = {
  tableName: string
  sourceTableName?: string
  pagination: 'id' | 'all'
  rename?: Record<string, string>
  collisionKey?: string[]
}

type TableReport = {
  sourceRows: number
  importedRows: number
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
  tables: Record<string, TableReport>
  userBootstrap: {
    id: string
    name: string
    email: string
    role: string | null
    sourceUserCount: number
    envKeysUsed: string[]
  } | null
}

const importTables: TableConfig[] = [
  {tableName: 'models', pagination: 'id'},
  {tableName: 'datasource', pagination: 'id'},
  {tableName: 'import_route', pagination: 'id'},
  {tableName: 'datasource_route_link', pagination: 'id'},
  {tableName: 'articles', pagination: 'id'},
  {tableName: 'article_route_link', pagination: 'id'},
  {tableName: 'projects', pagination: 'id'},
  {tableName: 'project_route_link', pagination: 'id'},
  {tableName: 'comparison_project', pagination: 'id'},
  {tableName: 'comparison_project_route_link', pagination: 'id'},
  {
    tableName: 'judgments_jobs',
    pagination: 'id',
    rename: {cursor_last_created_at: 'ch_cursor_last_date', cursor_last_article_id: 'ch_cursor_last_article_id'},
  },
  {tableName: 'prompts', pagination: 'id'},
  {tableName: 'judgments_jobs_prompts', pagination: 'id'},
  {tableName: 'project_prompts', pagination: 'id'},
  {tableName: 'comparison_project_prompt', pagination: 'id'},
  {tableName: 'judgments', pagination: 'id'},
  {tableName: 'judgments_human', pagination: 'all', collisionKey: ['project_id', 'article_id', 'prompt_id']},
  {tableName: 'project_articles', pagination: 'id'},
  {tableName: 'token_use', pagination: 'id'},
  {tableName: 'reviews', pagination: 'all', collisionKey: ['project_id', 'article_id']},
  {tableName: 'judgment_assessments', pagination: 'all', collisionKey: ['judgment_id']},
  {tableName: 'llm_status', pagination: 'id'},
  {tableName: 'nvidia_smi', pagination: 'id'},
  {tableName: 'sync_state', pagination: 'all'},
]

const getArgs = (): ImportOptions => {
  const args = process.argv.slice(2)
  const batchArg = args.find((arg) => {
    return arg.startsWith('--batch-size=')
  })
  const reportArg = args.find((arg) => {
    return arg.startsWith('--report=')
  })
  const batchSize = Number.parseInt(batchArg?.split('=')[1] ?? '1000', 10)

  return {
    clear: args.includes('--clear'),
    batchSize: Number.isFinite(batchSize) && batchSize > 0 ? batchSize : 1000,
    reportPath: reportArg?.split('=')[1] ?? './data/local-first-import-report.json',
  }
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

const getIdBatchRows = async (
  client: Client,
  config: TableConfig,
  selectList: string,
  batchSize: number,
  lastId: string | null,
) => {
  const sourceTableName = config.sourceTableName ?? config.tableName
  const whereClause = lastId ? `WHERE id > $1` : ''
  const params = lastId ? [lastId, batchSize] : [batchSize]
  const limitRef = lastId ? '$2' : '$1'
  const result = await client.query<Record<string, unknown>>(
    `
      SELECT ${selectList}
      FROM ${quoteIdentifier(sourceTableName)}
      ${whereClause}
      ORDER BY id ASC
      LIMIT ${limitRef}
    `,
    params,
  )

  return result.rows
}

const getAllRows = async (client: Client, config: TableConfig, selectList: string) => {
  const sourceTableName = config.sourceTableName ?? config.tableName
  const orderByClause = config.collisionKey
    ? `${config.collisionKey.map(quoteIdentifier).join(', ')}, updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC`
    : '1'
  const result = await client.query<Record<string, unknown>>(
    `
      SELECT ${selectList}
      FROM ${quoteIdentifier(sourceTableName)}
      ORDER BY ${orderByClause}
    `,
  )

  return result.rows
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

const insertRows = (tableName: string, rows: Record<string, unknown>[]) => {
  if (rows.length === 0) {
    return 0
  }

  const sqlite = getSqliteClient()
  const columnNames = Object.keys(rows[0] ?? {})
  const placeholders = columnNames.map(() => {
    return '?'
  })
  const statement = sqlite.prepare(
    `INSERT OR IGNORE INTO ${quoteIdentifier(tableName)} (${columnNames.map(quoteIdentifier).join(', ')}) VALUES (${placeholders.join(', ')})`,
  )

  sqlite.exec('BEGIN')

  try {
    rows.forEach((row) => {
      const values = columnNames.map((columnName) => {
        return getNormalizedValue(columnName, row[columnName])
      })
      ;(statement as {run: (...bindings: unknown[]) => unknown}).run(...values)
    })
    sqlite.exec('COMMIT')
  } catch (error) {
    sqlite.exec('ROLLBACK')
    throw error
  }

  return rows.length
}

const getTargetRowCount = (tableName: string) => {
  const sqlite = getSqliteClient()
  const row = sqlite.query(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`).get() as {
    count?: number
  } | null
  return row?.count ?? 0
}

const getHasExistingImportData = () => {
  return importTables.some((config) => {
    return getTargetRowCount(config.tableName) > 0
  })
}

const clearTargetTables = () => {
  const sqlite = getSqliteClient()
  sqlite.exec('PRAGMA foreign_keys = OFF;')
  sqlite.exec('BEGIN')

  try {
    ;[...importTables].reverse().forEach((config) => {
      sqlite.exec(`DELETE FROM ${quoteIdentifier(config.tableName)}`)
    })
    sqlite.exec(`DELETE FROM ${quoteIdentifier('user')}`)
    sqlite.exec('COMMIT')
  } catch (error) {
    sqlite.exec('ROLLBACK')
    throw error
  } finally {
    sqlite.exec('PRAGMA foreign_keys = ON;')
  }
}

const getBootstrapLocalUser = () => {
  const keys = [
    ['LOCAL_USER_NAME', process.env['LOCAL_USER_NAME']],
    ['LOCAL_USER_EMAIL', process.env['LOCAL_USER_EMAIL']],
    ['LOCAL_USER_ROLE', process.env['LOCAL_USER_ROLE']],
  ].filter((entry): entry is [string, string] => {
    return typeof entry[1] === 'string' && entry[1].trim() !== ''
  })
  const values = Object.fromEntries(keys)

  return {
    id: localUserDefaults.id,
    name: values['LOCAL_USER_NAME']?.trim() || localUserDefaults.name,
    email: values['LOCAL_USER_EMAIL']?.trim() || localUserDefaults.email,
    role: values['LOCAL_USER_ROLE']?.trim() || localUserDefaults.role,
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
        INSERT INTO ${quoteIdentifier('user')} (${quoteIdentifier('id')}, ${quoteIdentifier('name')}, ${quoteIdentifier('email')}, ${quoteIdentifier('role')}, ${quoteIdentifier('created_at')}, ${quoteIdentifier('updated_at')})
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(${quoteIdentifier('id')}) DO UPDATE SET
          ${quoteIdentifier('name')} = excluded.${quoteIdentifier('name')},
          ${quoteIdentifier('email')} = excluded.${quoteIdentifier('email')},
          ${quoteIdentifier('role')} = excluded.${quoteIdentifier('role')},
          ${quoteIdentifier('updated_at')} = excluded.${quoteIdentifier('updated_at')}
      `,
    )
    .run(localUser.id, localUser.name, localUser.email, localUser.role, now, now)

  return {...localUser, sourceUserCount: await getSourceUserCount(client)}
}

const writeReport = async (reportPath: string, report: ImportReport) => {
  await globalThis.Bun.write(reportPath, JSON.stringify(report, null, 2))
}

const importTable = async (client: Client, config: TableConfig, options: ImportOptions, report: ImportReport) => {
  const sourceTableName = config.sourceTableName ?? config.tableName
  const exists = await getSourceTableExists(client, sourceTableName)

  if (!exists) {
    report.tables[config.tableName] = {sourceRows: 0, importedRows: 0, skippedRows: 0, missing: true, collisions: []}
    return
  }

  const mappings = await getColumnMappings(client, config)
  const selectList = getSelectList(mappings)

  if (!selectList) {
    report.tables[config.tableName] = {sourceRows: 0, importedRows: 0, skippedRows: 0, missing: false, collisions: []}
    return
  }

  if (config.pagination === 'all') {
    const sourceRows = await getAllRows(client, config, selectList)
    const deduped = config.collisionKey
      ? getCollisionRows(sourceRows, config.collisionKey)
      : {dedupedRows: sourceRows, collisions: []}
    const importedRows = insertRows(config.tableName, deduped.dedupedRows)
    report.tables[config.tableName] = {
      sourceRows: sourceRows.length,
      importedRows,
      skippedRows: sourceRows.length - deduped.dedupedRows.length,
      missing: false,
      collisions: deduped.collisions,
    }
    return
  }

  let lastId: string | null = null
  let sourceRows = 0
  let importedRows = 0

  while (true) {
    const batchRows = await getIdBatchRows(client, config, selectList, options.batchSize, lastId)

    if (batchRows.length === 0) {
      break
    }

    sourceRows += batchRows.length
    importedRows += insertRows(config.tableName, batchRows)

    const nextLastId = batchRows[batchRows.length - 1]?.id
    lastId = typeof nextLastId === 'string' ? nextLastId : null

    if (!lastId) {
      break
    }
  }

  report.tables[config.tableName] = {
    sourceRows,
    importedRows,
    skippedRows: sourceRows - importedRows,
    missing: false,
    collisions: [],
  }
}

const importPostgresToSqlite = async () => {
  const options = getArgs()
  const sourceDatabaseUrl = getSourceDatabaseUrl()
  const report: ImportReport = {
    sourceDatabaseUrl,
    sqlitePath: env.SQLITE_PATH,
    clearRequested: options.clear,
    batchSize: options.batchSize,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    tables: {},
    userBootstrap: null,
  }
  const client = new Client({connectionString: sourceDatabaseUrl})

  await client.connect()

  try {
    if (getHasExistingImportData() && !options.clear) {
      throw new Error('SQLite already contains imported data. Re-run with --clear to replace the current contents.')
    }

    if (options.clear) {
      clearTargetTables()
    }

    for (const config of importTables) {
      console.log(`[import] ${config.tableName}`)
      await importTable(client, config, options, report)
    }

    report.userBootstrap = await bootstrapLocalUser(client)
    report.finishedAt = new Date().toISOString()

    await writeReport(options.reportPath, report)
    console.log(`[import] wrote report to ${options.reportPath}`)
  } finally {
    await client.end()
  }
}

void importPostgresToSqlite()
