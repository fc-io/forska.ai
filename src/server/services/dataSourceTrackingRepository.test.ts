import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {DuckDBInstance} from '@duckdb/node-api'
import {expect, test} from 'bun:test'

import {duckdbEngineCompatibilityOptions} from '../utils/duckdbEngineContract.ts'
import {
  createDataSourceArticleChangeLogRepository,
  createDataSourceReconciliationWorkRepository,
  createDataSourceTrackingRepository,
  type DataSourceTrackingDatabaseRunner,
} from './dataSourceTrackingRepository.ts'

const migrationsFolder = resolve(import.meta.dir, '../../db/duckdbMigrations')

const withTrackingDatabase = async <T>(operation: (database: DataSourceTrackingDatabaseRunner) => Promise<T>) => {
  const instance = await DuckDBInstance.create(':memory:', duckdbEngineCompatibilityOptions)
  const connection = await instance.connect()

  try {
    const database: DataSourceTrackingDatabaseRunner = {
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

test('data source tracking state advances high water only through success transition', async () => {
  await withTrackingDatabase(async (database) => {
    const trackingRepository = createDataSourceTrackingRepository(database)
    const sourceId = 'tracking-source-high-water'
    const route = '/api/datasources/import/pubmed'
    const now = new Date('2026-09-15T10:00:00.000Z')
    const leaseExpiresAt = new Date('2026-09-15T10:05:00.000Z')

    await database.run(`
      INSERT INTO app.data_source (id, title, import_route, tracking_enabled, date_from)
      VALUES ('${sourceId}', 'Tracked source', '${route}', TRUE, TIMESTAMPTZ '2026-09-01T00:00:00.000Z')
    `)

    await trackingRepository.createOrUpdateTrackingState({
      dataSourceId: sourceId,
      granularity: 'day',
      nextRunAfter: new Date('2026-09-15T09:00:00.000Z'),
      route,
    })

    const dueSources = await trackingRepository.selectDueSources({limit: 5, now})
    expect(
      dueSources.map((source) => {
        return source.dataSourceId
      }),
    ).toEqual([sourceId])

    const claim = await trackingRepository.claimDueSource({
      dataSourceId: sourceId,
      leaseExpiresAt,
      leaseOwner: 'worker-a',
      now,
    })
    expect(claim?.leaseOwner).toBe('worker-a')

    await trackingRepository.startTrackingWindow({
      activeCursor: null,
      dataSourceId: sourceId,
      runKind: 'incremental',
      windowEnd: new Date('2026-09-14T00:00:00.000Z'),
      windowStart: new Date('2026-09-13T00:00:00.000Z'),
    })
    await trackingRepository.updateTrackingState(sourceId, {activeCursor: 'cursor-after-page-1'}, now)
    await trackingRepository.recordTrackingFailure({
      dataSourceId: sourceId,
      error: 'provider timeout',
      leaseOwner: 'worker-a',
      nextRunAfter: new Date('2026-09-15T11:00:00.000Z'),
      now,
    })

    const afterFailure = await trackingRepository.getTrackingState(sourceId)
    expect(afterFailure?.activeCursor).toBe('cursor-after-page-1')
    expect(afterFailure?.failureCount).toBe(1)
    expect(afterFailure?.highWaterCompletedAt).toBeNull()

    await trackingRepository.claimDueSource({
      dataSourceId: sourceId,
      leaseExpiresAt: new Date('2026-09-15T11:05:00.000Z'),
      leaseOwner: 'worker-b',
      now: new Date('2026-09-15T11:00:00.000Z'),
    })
    const success = await trackingRepository.recordTrackingSuccess({
      dataSourceId: sourceId,
      highWaterCompletedAt: new Date('2026-09-14T00:00:00.000Z'),
      importRunId: 'import-run-1',
      leaseOwner: 'worker-b',
      nextRunAfter: new Date('2026-09-16T00:00:00.000Z'),
      now: new Date('2026-09-15T11:01:00.000Z'),
    })

    expect(success?.highWaterCompletedAt?.toISOString()).toBe('2026-09-14T00:00:00.000Z')
    expect(success?.activeCursor).toBeNull()
    expect(success?.failureCount).toBe(0)
    expect(success?.lastImportRunId).toBe('import-run-1')

    const nonRegressingSuccess = await trackingRepository.recordTrackingSuccess({
      dataSourceId: sourceId,
      highWaterCompletedAt: new Date('2026-09-10T00:00:00.000Z'),
      now: new Date('2026-09-15T12:00:00.000Z'),
    })
    expect(nonRegressingSuccess?.highWaterCompletedAt?.toISOString()).toBe('2026-09-14T00:00:00.000Z')
  })
})

test('data source tracking state resets window progress when the tracked route changes', async () => {
  await withTrackingDatabase(async (database) => {
    const trackingRepository = createDataSourceTrackingRepository(database)
    const sourceId = 'tracking-source-route-change'
    const pubmedRoute = '/api/datasources/import/pubmed'
    const pprRoute = '/api/datasources/import/europe-pmc-ppr'

    await database.run(`
      INSERT INTO app.data_source (id, title, import_route, tracking_enabled, date_from)
      VALUES ('${sourceId}', 'Tracked route change source', '${pubmedRoute}', TRUE, TIMESTAMPTZ '2026-09-01T00:00:00.000Z')
    `)

    await trackingRepository.createOrUpdateTrackingState({
      dataSourceId: sourceId,
      granularity: 'day',
      route: pubmedRoute,
    })
    await trackingRepository.startTrackingWindow({
      activeCursor: 'cursor-page-1',
      dataSourceId: sourceId,
      runKind: 'incremental',
      windowEnd: new Date('2026-09-14T00:00:00.000Z'),
      windowStart: new Date('2026-09-13T00:00:00.000Z'),
    })
    await trackingRepository.recordTrackingFailure({
      dataSourceId: sourceId,
      error: 'provider timeout',
      now: new Date('2026-09-15T10:00:00.000Z'),
    })
    await trackingRepository.recordTrackingSuccess({
      dataSourceId: sourceId,
      highWaterCompletedAt: new Date('2026-09-14T00:00:00.000Z'),
      importRunId: 'import-run-1',
      now: new Date('2026-09-15T11:00:00.000Z'),
    })

    const changed = await trackingRepository.createOrUpdateTrackingState({
      dataSourceId: sourceId,
      granularity: 'day',
      route: pprRoute,
    })

    expect(changed.route).toBe(pprRoute)
    expect(changed.highWaterCompletedAt).toBeNull()
    expect(changed.activeCursor).toBeNull()
    expect(changed.activeWindowStart).toBeNull()
    expect(changed.activeWindowEnd).toBeNull()
    expect(changed.activeRunKind).toBeNull()
    expect(changed.failureCount).toBe(0)
    expect(changed.lastError).toBeNull()
  })
})

test('data source reconciliation work scheduling is idempotent and claims one active lease', async () => {
  await withTrackingDatabase(async (database) => {
    const workRepository = createDataSourceReconciliationWorkRepository(database)
    const sourceId = 'tracking-source-reconciliation'
    const route = '/api/datasources/import/europe-pmc-ppr'
    const periodStart = new Date('2026-06-01T00:00:00.000Z')
    const periodEnd = new Date('2026-07-01T00:00:00.000Z')

    await database.run(`
      INSERT INTO app.data_source (id, title, import_route, tracking_enabled, date_from)
      VALUES ('${sourceId}', 'Tracked source', '${route}', TRUE, TIMESTAMPTZ '2026-01-01T00:00:00.000Z')
    `)

    const first = await workRepository.scheduleWork({
      ageMonths: 3,
      dataSourceId: sourceId,
      now: new Date('2026-09-01T00:00:00.000Z'),
      periodEnd,
      periodStart,
      route,
      runKind: 'automatic_age_bucket',
    })
    const second = await workRepository.scheduleWork({
      ageMonths: 3,
      dataSourceId: sourceId,
      now: new Date('2026-09-01T00:00:10.000Z'),
      periodEnd,
      periodStart,
      route,
      runKind: 'automatic_age_bucket',
    })
    const [countRow] = await database.queryJson<{count: number}>(`
      SELECT COUNT(*)::INTEGER AS count
      FROM app.data_source_reconciliation_work
      WHERE data_source_id = '${sourceId}'
    `)

    expect(second.id).toBe(first.id)
    expect(countRow?.count).toBe(1)

    const claim = await workRepository.claimNextWork({
      leaseExpiresAt: new Date('2026-09-15T10:05:00.000Z'),
      leaseOwner: 'worker-a',
      now: new Date('2026-09-15T10:00:00.000Z'),
    })
    const duplicateClaim = await workRepository.claimNextWork({
      leaseExpiresAt: new Date('2026-09-15T10:05:00.000Z'),
      leaseOwner: 'worker-b',
      now: new Date('2026-09-15T10:01:00.000Z'),
    })

    expect(claim?.id).toBe(first.id)
    expect(claim?.status).toBe('running')
    expect(claim?.leaseOwner).toBe('worker-a')
    expect(duplicateClaim).toBeNull()

    await workRepository.markWorkFailed({
      error: 'provider timeout',
      id: first.id,
      leaseOwner: 'worker-a',
      nextRetryAt: new Date('2026-09-15T11:00:00.000Z'),
      now: new Date('2026-09-15T10:02:00.000Z'),
    })

    const retryTooEarly = await workRepository.claimNextWork({
      leaseExpiresAt: new Date('2026-09-15T10:15:00.000Z'),
      leaseOwner: 'worker-c',
      now: new Date('2026-09-15T10:10:00.000Z'),
    })
    const retryDue = await workRepository.claimNextWork({
      leaseExpiresAt: new Date('2026-09-15T11:15:00.000Z'),
      leaseOwner: 'worker-d',
      now: new Date('2026-09-15T11:00:00.000Z'),
    })

    expect(retryTooEarly).toBeNull()
    expect(retryDue?.id).toBe(first.id)
    expect(retryDue?.nextRetryAt?.toISOString()).toBe('2026-09-15T11:00:00.000Z')
  })
})

test('reconciliation claims require enabled current-route data sources', async () => {
  await withTrackingDatabase(async (database) => {
    const workRepository = createDataSourceReconciliationWorkRepository(database)
    const sourceId = 'tracking-source-reconciliation-disabled'
    const route = '/api/datasources/import/europe-pmc-ppr'
    const otherRoute = '/api/datasources/import/pubmed'

    await database.run(`
      INSERT INTO app.data_source (id, title, import_route, tracking_enabled, archived, date_from)
      VALUES ('${sourceId}', 'Tracked source', '${route}', TRUE, FALSE, TIMESTAMPTZ '2026-01-01T00:00:00.000Z')
    `)

    const work = await workRepository.scheduleWork({
      ageMonths: 3,
      dataSourceId: sourceId,
      now: new Date('2026-09-01T00:00:00.000Z'),
      periodEnd: new Date('2026-07-01T00:00:00.000Z'),
      periodStart: new Date('2026-06-01T00:00:00.000Z'),
      route,
      runKind: 'automatic_age_bucket',
    })

    await database.run(`UPDATE app.data_source SET tracking_enabled = FALSE WHERE id = '${sourceId}'`)
    expect(
      await workRepository.claimNextWork({
        leaseExpiresAt: new Date('2026-09-15T10:05:00.000Z'),
        leaseOwner: 'worker-disabled',
        now: new Date('2026-09-15T10:00:00.000Z'),
      }),
    ).toBeNull()

    await database.run(`UPDATE app.data_source SET tracking_enabled = TRUE, archived = TRUE WHERE id = '${sourceId}'`)
    expect(
      await workRepository.claimNextWork({
        leaseExpiresAt: new Date('2026-09-15T10:05:00.000Z'),
        leaseOwner: 'worker-archived',
        now: new Date('2026-09-15T10:00:00.000Z'),
      }),
    ).toBeNull()

    await database.run(`
      UPDATE app.data_source
      SET archived = FALSE, import_route = '${otherRoute}'
      WHERE id = '${sourceId}'
    `)
    expect(
      await workRepository.claimNextWork({
        leaseExpiresAt: new Date('2026-09-15T10:05:00.000Z'),
        leaseOwner: 'worker-route',
        now: new Date('2026-09-15T10:00:00.000Z'),
      }),
    ).toBeNull()

    await database.run(`UPDATE app.data_source SET import_route = '${route}' WHERE id = '${sourceId}'`)
    const claim = await workRepository.claimNextWork({
      leaseExpiresAt: new Date('2026-09-15T10:05:00.000Z'),
      leaseOwner: 'worker-current',
      now: new Date('2026-09-15T10:00:00.000Z'),
    })

    expect(claim?.id).toBe(work.id)
    expect(claim?.leaseOwner).toBe('worker-current')
  })
})

test('completed manual reconciliation work can be requested again', async () => {
  await withTrackingDatabase(async (database) => {
    const workRepository = createDataSourceReconciliationWorkRepository(database)
    const sourceId = 'tracking-source-manual-repeat'
    const route = '/api/datasources/import/pubmed'
    const periodStart = new Date('2026-01-01T00:00:00.000Z')
    const periodEnd = new Date('2026-09-01T00:00:00.000Z')

    await database.run(`
      INSERT INTO app.data_source (id, title, import_route, tracking_enabled, date_from)
      VALUES ('${sourceId}', 'Tracked source', '${route}', TRUE, TIMESTAMPTZ '2026-01-01T00:00:00.000Z')
    `)

    const first = await workRepository.scheduleWork({
      ageMonths: null,
      dataSourceId: sourceId,
      now: new Date('2026-09-15T09:00:00.000Z'),
      periodEnd,
      periodStart,
      route,
      runKind: 'manual_full_range',
    })
    const activeDuplicate = await workRepository.scheduleWork({
      ageMonths: null,
      dataSourceId: sourceId,
      now: new Date('2026-09-15T09:01:00.000Z'),
      periodEnd,
      periodStart,
      route,
      runKind: 'manual_full_range',
    })

    expect(activeDuplicate.id).toBe(first.id)

    await workRepository.markWorkCompleted({
      id: first.id,
      importRunId: 'manual-run-1',
      now: new Date('2026-09-15T09:02:00.000Z'),
    })

    const second = await workRepository.scheduleWork({
      ageMonths: null,
      dataSourceId: sourceId,
      now: new Date('2026-09-15T09:03:00.000Z'),
      periodEnd,
      periodStart,
      route,
      runKind: 'manual_full_range',
    })

    expect(second.id).not.toBe(first.id)
    expect(second.status).toBe('queued')
  })
})

test('monthly reconciliation scheduler catches up configured age buckets without duplicating work', async () => {
  await withTrackingDatabase(async (database) => {
    const trackingRepository = createDataSourceTrackingRepository(database)
    const workRepository = createDataSourceReconciliationWorkRepository(database)
    const sourceId = 'tracking-source-reconciliation-scheduler'
    const route = '/api/datasources/import/pubmed'

    await database.run(`
      INSERT INTO app.data_source (
        id,
        title,
        import_route,
        tracking_enabled,
        tracking_reconcile_schedule_months,
        date_from
      )
      VALUES (
        '${sourceId}',
        'Tracked source scheduler',
        '${route}',
        TRUE,
        CAST('[3,12,24,36]' AS JSON),
        TIMESTAMPTZ '2020-01-01T00:00:00.000Z'
      )
    `)
    await trackingRepository.createOrUpdateTrackingState({dataSourceId: sourceId, granularity: 'day', route})
    await trackingRepository.updateTrackingState(
      sourceId,
      {lastReconciliationSchedulerAt: new Date('2026-07-12T00:00:00.000Z')},
      new Date('2026-07-12T00:00:00.000Z'),
    )

    const scheduled = await workRepository.scheduleDueMonthlyAgeBucketWork({
      now: new Date('2026-09-16T12:00:00.000Z'),
      routes: [route],
    })
    const duplicate = await workRepository.scheduleDueMonthlyAgeBucketWork({
      now: new Date('2026-09-16T12:00:10.000Z'),
      routes: [route],
    })
    const rows = await database.queryJson<{
      ageMonths: number
      periodEnd: unknown
      periodStart: unknown
      status: string
    }>(`
      SELECT
        age_months::INTEGER AS ageMonths,
        period_start AS periodStart,
        period_end AS periodEnd,
        status
      FROM app.data_source_reconciliation_work
      WHERE data_source_id = '${sourceId}'
      ORDER BY period_start ASC, age_months ASC
    `)
    const state = await trackingRepository.getTrackingState(sourceId)
    const normalizedRows = rows.map((row) => {
      return {
        ...row,
        periodEnd: new Date(row.periodEnd as string).toISOString(),
        periodStart: new Date(row.periodStart as string).toISOString(),
      }
    })

    expect(scheduled).toHaveLength(8)
    expect(duplicate).toHaveLength(0)
    expect(normalizedRows).toEqual([
      {ageMonths: 36, periodEnd: '2023-09-01T00:00:00.000Z', periodStart: '2023-08-01T00:00:00.000Z', status: 'queued'},
      {ageMonths: 36, periodEnd: '2023-10-01T00:00:00.000Z', periodStart: '2023-09-01T00:00:00.000Z', status: 'queued'},
      {ageMonths: 24, periodEnd: '2024-09-01T00:00:00.000Z', periodStart: '2024-08-01T00:00:00.000Z', status: 'queued'},
      {ageMonths: 24, periodEnd: '2024-10-01T00:00:00.000Z', periodStart: '2024-09-01T00:00:00.000Z', status: 'queued'},
      {ageMonths: 12, periodEnd: '2025-09-01T00:00:00.000Z', periodStart: '2025-08-01T00:00:00.000Z', status: 'queued'},
      {ageMonths: 12, periodEnd: '2025-10-01T00:00:00.000Z', periodStart: '2025-09-01T00:00:00.000Z', status: 'queued'},
      {ageMonths: 3, periodEnd: '2026-06-01T00:00:00.000Z', periodStart: '2026-05-01T00:00:00.000Z', status: 'queued'},
      {ageMonths: 3, periodEnd: '2026-07-01T00:00:00.000Z', periodStart: '2026-06-01T00:00:00.000Z', status: 'queued'},
    ])
    expect(state?.lastReconciliationSchedulerAt?.toISOString()).toBe('2026-09-16T12:00:10.000Z')
  })
})

test('data source article change log inserts deduplicated rows and reads them by data source', async () => {
  await withTrackingDatabase(async (database) => {
    const changeLogRepository = createDataSourceArticleChangeLogRepository(database)
    const sourceId = 'tracking-source-change-log'
    const route = '/api/datasources/import/pubmed'

    await database.run(`
      INSERT INTO app.data_source (id, title, import_route, tracking_enabled, date_from)
      VALUES ('${sourceId}', 'Tracked source', '${route}', TRUE, TIMESTAMPTZ '2026-01-01T00:00:00.000Z')
    `)

    const first = await changeLogRepository.insertChange({
      changeKind: 'source_record_changed',
      changedFields: {title: ['Old', 'New']},
      dataSourceId: sourceId,
      externalArticleId: 'pmid:1',
      nextSourceRecordHash: 'hash-new',
      previousSourceRecordHash: 'hash-old',
      route,
      runKind: 'automatic_age_bucket',
      sourceRecordKey: 'SRC:MED:1',
    })
    const second = await changeLogRepository.insertChange({
      changeKind: 'source_record_changed',
      changedFields: {title: ['Old', 'New']},
      dataSourceId: sourceId,
      externalArticleId: 'pmid:1',
      nextSourceRecordHash: 'hash-new',
      previousSourceRecordHash: 'hash-old',
      route,
      runKind: 'automatic_age_bucket',
      sourceRecordKey: 'SRC:MED:1',
    })
    const changes = await changeLogRepository.listChanges({dataSourceId: sourceId, limit: 10})

    expect(second.id).toBe(first.id)
    expect(changes).toHaveLength(1)
    expect(changes[0]?.changeKind).toBe('source_record_changed')
    expect(changes[0]?.changedFields).toEqual({title: ['Old', 'New']})
    expect(changes[0]?.dataSourceId).toBe(sourceId)
    expect(changes[0]?.sourceRecordKey).toBe('SRC:MED:1')
  })
})
