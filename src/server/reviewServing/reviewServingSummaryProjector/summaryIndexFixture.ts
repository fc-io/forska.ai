import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {DuckDBInstance} from '@duckdb/node-api'

import {createDuckdbInstance} from '../../utils/createDuckdbInstance.ts'
import {duckdbEngineCompatibilityOptions} from '../../utils/duckdbEngineContract.ts'
import {
  getDeleteReviewServingProjectorRowsStatement,
  type ReviewServingProjectorRecord,
  type ReviewServingProjectorWriterDatabase,
  writeReviewServingProjectorComponent,
} from '../reviewServingProjectorWriter.ts'

const migrationName = '0228_rebuildReviewSummaryServingWithoutIndexes.sql'
const tables = ['review_article_count_serving_v4', 'review_filter_facet_serving_v4']
const tablePredicate = tables
  .map((table) => {
    return `'${table}'`
  })
  .join(', ')
const scopes = [
  {project_id: 'project-one', review_config_hash: 'review-one', snapshot_id: 'snapshot-one'},
  {project_id: 'project-one', review_config_hash: 'review-two', snapshot_id: 'snapshot-two'},
  {project_id: 'project-two', review_config_hash: 'review-one', snapshot_id: 'snapshot-one'},
]

const getRecords = (scope: (typeof scopes)[number], count: number): ReviewServingProjectorRecord[] => {
  return [
    {
      keyColumns: [
        'project_id',
        'review_config_hash',
        'snapshot_id',
        'list_mode_key',
        'count_kind',
        'summary_definition_version',
        'filter_key',
      ],
      table: 'mart.review_article_count_serving_v4',
      values: {
        ...scope,
        summary_identity: 'review.list.total',
        list_mode_key: 'llm',
        count_kind: 'review.list.total',
        summary_definition_version: 'review-list-total:v1',
        filter_key: 'list:all',
        count_value: count,
        availability: 'ready',
        stale_reason: null,
      },
    },
    {
      keyColumns: [
        'project_id',
        'review_config_hash',
        'snapshot_id',
        'summary_identity',
        'facet_kind',
        'facet_key',
        'facet_value',
        'summary_definition_version',
      ],
      table: 'mart.review_filter_facet_serving_v4',
      values: {
        ...scope,
        summary_identity: 'review.filter.importRoute',
        facet_kind: 'review',
        facet_key: 'importRoute',
        facet_value: 'route-one',
        prompt_id: null,
        answer_id: null,
        answer_value: 'route-one',
        summary_definition_version: 'review-filter-import-route:v1',
        count_value: count,
        availability: 'ready',
      },
    },
  ]
}

const writeScope = async (
  database: ReviewServingProjectorWriterDatabase,
  scopeIndex: number,
  count: number,
  fail = false,
) => {
  const scope = scopes[scopeIndex]
  if (scope === undefined) {
    throw new Error('missing fixture scope')
  }
  const records = getRecords(scope, count)
  return writeReviewServingProjectorComponent(
    {
      component: 'summary',
      records: [...records, ...records],
      statements: records.map((record) => {
        return getDeleteReviewServingProjectorRowsStatement({table: record.table, predicates: scope})
      }),
      postRecordStatements: fail ? ['SELECT missing_summary_fixture_function()'] : [],
    },
    database,
  )
}

const getSnapshot = async (database: ReviewServingProjectorWriterDatabase) => {
  const rows = await Promise.all(
    tables.map(async (table) => {
      return database.queryJson(`SELECT * FROM mart.${table} ORDER BY project_id, review_config_hash, snapshot_id`)
    }),
  )
  return {
    rows,
    indexes: await database.queryJson(
      `SELECT index_name, table_name FROM duckdb_indexes() WHERE schema_name = 'mart' AND table_name IN (${tablePredicate}) ORDER BY index_name`,
    ),
    constraints: await database.queryJson(
      `SELECT table_name, constraint_type FROM duckdb_constraints() WHERE schema_name = 'mart' AND table_name IN (${tablePredicate}) AND constraint_type IN ('PRIMARY KEY', 'UNIQUE')`,
    ),
    columns: await database.queryJson(
      `SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'mart' AND table_name IN (${tablePredicate}) ORDER BY table_name, ordinal_position`,
    ),
    view: await database.queryJson(
      'SELECT * FROM mart.summary_index_fixture_view ORDER BY project_id, review_config_hash, snapshot_id',
    ),
  }
}

const withNativeDatabase = async <T>(operation: (database: ReviewServingProjectorWriterDatabase) => Promise<T>) => {
  const instance = await createDuckdbInstance({
    create: DuckDBInstance.create.bind(DuckDBInstance),
    databasePath: process.env.DUCKDB_PATH,
    options: {...duckdbEngineCompatibilityOptions, memory_limit: '512MiB'},
  })
  const connection = await instance.connect()
  const queryJson = async <R>(statement: string) => {
    return (await connection.runAndReadAll(statement)).getRowObjectsJson() as R[]
  }
  const run = async (statement: string) => {
    await connection.run(statement)
  }
  const database: ReviewServingProjectorWriterDatabase = {
    queryJson,
    run,
    transaction: async (operation) => {
      await run('BEGIN')
      try {
        const result = await operation({queryJson, run})
        await run('COMMIT')
        return result
      } catch (error) {
        await run('ROLLBACK')
        throw error
      }
    },
  }
  try {
    return await operation(database)
  } finally {
    connection.closeSync()
    instance.closeSync()
  }
}

const createView = async (database: ReviewServingProjectorWriterDatabase) => {
  await database.run(
    'CREATE VIEW mart.summary_index_fixture_view AS SELECT project_id, review_config_hash, snapshot_id, count_value FROM mart.review_filter_facet_serving_v4',
  )
}

const seed = async () => {
  const {migrateDuckdb} = await import('../../../db/migrateDuckdb.ts')
  const {getAppDatabaseService} = await import('../../services/appDatabaseService.ts')
  const {closeDuckdbService} = await import('../../utils/duckdbService.ts')
  await migrateDuckdb()
  const database = getAppDatabaseService()
  const firstScope = scopes[0]
  if (firstScope === undefined) {
    throw new Error('missing first scope')
  }
  for (const record of getRecords(firstScope, 0)) {
    await database.run(
      `CREATE UNIQUE INDEX idx_${record.table.split('.')[1]}_repaired_pk_legacy ON ${record.table}(${record.keyColumns.join(', ')})`,
    )
  }
  for (const [index] of scopes.entries()) {
    await writeScope(database, index, 10 + index)
  }
  await createView(database)
  await database.run(`DELETE FROM app_schema_migration WHERE name = '${migrationName}'`)
  const result = await getSnapshot(database)
  await database.run('CHECKPOINT')
  await closeDuckdbService()
  return result
}

const upgrade = async () => {
  return withNativeDatabase(async (database) => {
    const before = await getSnapshot(database)
    await database.transaction(async (tx) => {
      await tx.run(readFileSync(resolve(import.meta.dir, '../../../db/duckdbMigrations', migrationName), 'utf8'))
    })
    return {before, after: await getSnapshot(database)}
  })
}

const publish = async () => {
  return withNativeDatabase(async (database) => {
    const diagnostics = []
    for (const [scopeIndex, count] of [
      [0, 31],
      [1, 41],
      [0, 32],
    ] as const) {
      diagnostics.push((await writeScope(database, scopeIndex, count)).diagnostics.records)
    }
    const beforeRollback = await getSnapshot(database)
    let rollbackError: string | null = null
    try {
      await writeScope(database, 0, 999, true)
    } catch (error) {
      rollbackError = String(error)
    }
    const afterRollback = await getSnapshot(database)
    await database.run('CHECKPOINT')
    return {diagnostics, rollbackError, beforeRollback, afterRollback}
  })
}

const managed = async () => {
  const {migrateDuckdb} = await import('../../../db/migrateDuckdb.ts')
  const {getAppDatabaseService} = await import('../../services/appDatabaseService.ts')
  const {closeDuckdbService} = await import('../../utils/duckdbService.ts')
  await migrateDuckdb()
  const database = getAppDatabaseService()
  await writeScope(database, 0, 32)
  await closeDuckdbService()
  return withNativeDatabase(getSnapshot)
}

export const runSummaryIndexFixture = async (phase: string) => {
  if (phase === 'seed') {
    return seed()
  }
  if (phase === 'upgrade') {
    return upgrade()
  }
  if (phase === 'publish') {
    return publish()
  }
  if (phase === 'managed') {
    return managed()
  }
  if (phase === 'inspect') {
    return withNativeDatabase(getSnapshot)
  }
  if (phase === 'old-writer') {
    return withNativeDatabase(async (database) => {
      try {
        await writeScope(database, 0, 32)
        return {error: null}
      } catch (error) {
        return {error: String(error), snapshot: await getSnapshot(database)}
      }
    })
  }
  if (phase === 'fresh') {
    const {migrateDuckdb} = await import('../../../db/migrateDuckdb.ts')
    const {getAppDatabaseService} = await import('../../services/appDatabaseService.ts')
    const {closeDuckdbService} = await import('../../utils/duckdbService.ts')
    await migrateDuckdb()
    const database = getAppDatabaseService()
    await createView(database)
    for (const [index] of scopes.entries()) {
      await writeScope(database, index, 10 + index)
    }
    const result = await getSnapshot(database)
    await database.run('CHECKPOINT')
    await closeDuckdbService()
    return result
  }
  throw new Error(`unknown summary fixture phase ${phase}`)
}
