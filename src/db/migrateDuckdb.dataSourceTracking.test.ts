import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {DuckDBInstance} from '@duckdb/node-api'
import {expect, test} from 'bun:test'

import {duckdbEngineCompatibilityOptions} from '../server/utils/duckdbEngineContract.ts'

type DuckDBConnectionLike = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

const migrationsFolder = resolve(import.meta.dir, 'duckdbMigrations')

const withDataSourceTrackingMigration = async <T>(operation: (database: DuckDBConnectionLike) => Promise<T>) => {
  const instance = await DuckDBInstance.create(':memory:', duckdbEngineCompatibilityOptions)
  const connection = await instance.connect()

  try {
    const database: DuckDBConnectionLike = {
      queryJson: async <R>(statement: string) => {
        return (await connection.runAndReadAll(statement)).getRowObjectsJson() as R[]
      },
      run: async (statement: string) => {
        await connection.run(statement)
      },
    }

    await database.run(readFileSync(resolve(migrationsFolder, '0000_nativeDuckdbSchema.sql'), 'utf8'))
    await database.run(readFileSync(resolve(migrationsFolder, '0235_dataSourceContinuousTracking.sql'), 'utf8'))

    return await operation(database)
  } finally {
    connection.closeSync()
    instance.closeSync()
  }
}

test('DuckDB data-source continuous tracking migration adds state, reconciliation, and change-log schema', async () => {
  await withDataSourceTrackingMigration(async (database) => {
    const columns = await database.queryJson<{
      columnDefault: string | null
      columnName: string
      dataType: string
      tableName: string
    }>(`
      SELECT table_name AS tableName, column_name AS columnName, data_type AS dataType, column_default AS columnDefault
      FROM information_schema.columns
      WHERE table_schema = 'app'
        AND table_name IN (
          'data_source',
          'data_source_tracking_state',
          'data_source_reconciliation_work',
          'data_source_article_change_log'
        )
      ORDER BY table_name, ordinal_position
    `)
    const constraints = await database.queryJson<{columnNames: string[]; constraintType: string; tableName: string}>(`
      SELECT table_name AS tableName, constraint_type AS constraintType, constraint_column_names AS columnNames
      FROM duckdb_constraints()
      WHERE schema_name = 'app'
        AND table_name IN (
          'data_source_tracking_state',
          'data_source_reconciliation_work',
          'data_source_article_change_log'
        )
      ORDER BY table_name, constraint_type, constraint_name
    `)
    const indexes = await database.queryJson<{indexName: string; tableName: string}>(`
      SELECT table_name AS tableName, index_name AS indexName
      FROM duckdb_indexes()
      WHERE schema_name = 'app'
        AND table_name = 'data_source_article_change_log'
      ORDER BY index_name
    `)

    await database.run(`
      INSERT INTO app.data_source (id, title)
      VALUES ('source-defaults', 'Defaults')
    `)
    const [dataSource] = await database.queryJson<{
      trackingEnabled: boolean
      trackingReconcileScheduleMonths: unknown
    }>(`
      SELECT
        tracking_enabled AS trackingEnabled,
        TO_JSON(tracking_reconcile_schedule_months) AS trackingReconcileScheduleMonths
      FROM app.data_source
      WHERE id = 'source-defaults'
    `)

    expect(
      columns.map((column) => {
        return `${column.tableName}.${column.columnName}:${column.dataType}`
      }),
    ).toContain('data_source.tracking_enabled:BOOLEAN')
    expect(
      columns.map((column) => {
        return `${column.tableName}.${column.columnName}:${column.dataType}`
      }),
    ).toContain('data_source.tracking_reconcile_schedule_months:JSON')
    const columnNames = columns.map((column) => {
      return `${column.tableName}.${column.columnName}`
    })
    const primaryKeys = constraints
      .filter((constraint) => {
        return constraint.constraintType === 'PRIMARY KEY'
      })
      .map((constraint) => {
        return constraint.columnNames
      })
    const uniqueKeys = constraints
      .filter((constraint) => {
        return constraint.constraintType === 'UNIQUE'
      })
      .map((constraint) => {
        return constraint.columnNames
      })

    expect(columnNames).toContain('data_source_article_change_log.previous_snapshot')
    expect(columnNames).toContain('data_source_article_change_log.next_snapshot')
    expect(columnNames).toContain('data_source_reconciliation_work.next_retry_at')
    expect(columnNames).toContain('data_source_reconciliation_work.period_start')
    expect(columnNames).toContain('data_source_reconciliation_work.period_end')
    expect(columnNames).toContain('data_source_tracking_state.high_water_completed_at')
    expect(columnNames).toContain('data_source_tracking_state.lease_expires_at')
    expect(primaryKeys).toContainEqual(['data_source_id'])
    expect(primaryKeys).toContainEqual(['id'])
    expect(uniqueKeys).toContainEqual(['data_source_id', 'run_kind', 'age_months', 'period_start', 'period_end'])
    expect(indexes).toEqual([
      {
        indexName: 'idx_data_source_article_change_log_source_record_history',
        tableName: 'data_source_article_change_log',
      },
      {indexName: 'idx_data_source_article_change_log_timeline', tableName: 'data_source_article_change_log'},
    ])
    expect(dataSource?.trackingEnabled).toBe(false)
    expect(
      typeof dataSource?.trackingReconcileScheduleMonths === 'string'
        ? JSON.parse(dataSource.trackingReconcileScheduleMonths)
        : dataSource?.trackingReconcileScheduleMonths,
    ).toEqual([3, 12, 24, 36])
  })
})
