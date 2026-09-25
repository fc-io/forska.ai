import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'
import type {ReviewImportDeltaDirtyIntakeDatabase} from './reviewImportDeltaDirtyIntakeService.ts'
import type {ReviewServingDirtyWorkTransaction} from './reviewServingDirtyWorkService.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('review-import-delta-intake')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const importComponentCount = 9

let database: ReturnType<typeof getAppDatabaseService> | null = null

const getDatabase = () => {
  if (database === null) {
    throw new Error('Database not initialized')
  }

  return database
}

const getIntake = async () => {
  const {intakeReviewImportDeltasToDirtyWork} = await import('./reviewImportDeltaDirtyIntakeService.ts')

  return intakeReviewImportDeltasToDirtyWork
}

const createCountingDatabase = () => {
  const counts = {statements: 0, transactions: 0}
  const countStatements = (tx: ReviewServingDirtyWorkTransaction): ReviewServingDirtyWorkTransaction => {
    return {
      queryJson: <T>(statement: string) => {
        counts.statements += 1

        return tx.queryJson<T>(statement)
      },
      run: (statement: string) => {
        counts.statements += 1

        return tx.run(statement)
      },
    }
  }
  const countingDatabase: ReviewImportDeltaDirtyIntakeDatabase = {
    ...countStatements(getDatabase()),
    transaction: <T>(operation: (tx: ReviewServingDirtyWorkTransaction) => Promise<T>) => {
      counts.transactions += 1

      return getDatabase().transaction((tx) => {
        return operation(countStatements(tx))
      })
    },
  }

  return {counts, database: countingDatabase}
}

const insertRoute = async (input: {projectId: string; routeId: string}) => {
  await getDatabase().run(
    `INSERT INTO app.import_route (id, route, name) VALUES ('${input.routeId}', '${input.routeId}', '${input.routeId}')`,
  )
  await getDatabase().run(`
    INSERT INTO app.project_import_route (id, project_id, import_route_id)
    VALUES ('${input.projectId}:${input.routeId}', '${input.projectId}', '${input.routeId}')
  `)
}

const insertAddedDeltas = async (input: {
  count: number
  deltaPrefix: string
  firstArticle?: number
  firstWatermark: number
  routeId: string
}) => {
  await getDatabase().run(`
    INSERT INTO app.import_run_article_delta (
      delta_id, change_kind, source_table, source_row_id, source_operation, source_partition, source_high_water_mark,
      idempotency_key, payload_version, import_route_id, article_id, source_record_key
    )
    SELECT
      '${input.deltaPrefix}-' || lpad(i::VARCHAR, 5, '0'),
      'importRoute.article.added',
      'app.article_import_route',
      '${input.deltaPrefix}-row-' || i::VARCHAR,
      'insert',
      'importRoute:${input.routeId}',
      ${input.firstWatermark} + i,
      '${input.deltaPrefix}-key-' || i::VARCHAR,
      1,
      '${input.routeId}',
      'article-' || (${input.firstArticle ?? 0} + i)::VARCHAR,
      'record-' || (${input.firstArticle ?? 0} + i)::VARCHAR
    FROM range(${input.count}) t(i)
  `)
}

const getReconciledCount = async (routeId: string) => {
  const [row] = await getDatabase().queryJson<{pending: number; reconciled: number}>(`
    SELECT
      CAST(count(*) FILTER (WHERE reconciled_at IS NOT NULL) AS INTEGER) AS reconciled,
      CAST(count(*) FILTER (WHERE reconciled_at IS NULL) AS INTEGER) AS pending
    FROM app.import_run_article_delta
    WHERE import_route_id = '${routeId}'
  `)

  return row
}

const getDirtyWorkCounts = async (sourcePartition: string) => {
  const [row] = await getDatabase().queryJson<{claimStates: number; dirtyWork: number; mismatched: number}>(`
    SELECT
      CAST(count(DISTINCT dirty.dirty_work_id) AS INTEGER) AS dirtyWork,
      CAST(count(DISTINCT state.dirty_work_id) AS INTEGER) AS claimStates,
      CAST(count(*) FILTER (
        WHERE state.dirty_work_id IS NULL
          OR state.status <> dirty.status
          OR state.latest_source_high_water_mark <> dirty.latest_source_high_water_mark
          OR state.projection_component <> dirty.projection_component
      ) AS INTEGER) AS mismatched
    FROM app.review_serving_dirty_work dirty
    LEFT JOIN app.review_serving_dirty_work_claim_state state
      ON state.dirty_work_id = dirty.dirty_work_id
    WHERE dirty.source_partition = '${sourcePartition}'
  `)

  return row
}

beforeAll(async () => {
  const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] =
    await Promise.all([
      import('../../db/migrateDuckdb.ts'),
      import('../services/appDatabaseService.ts'),
      import('../utils/duckdbService.ts'),
      import('../utils/serverRuntimeRole.ts'),
    ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()

  await migrateDuckdb()

  database = getAppDatabaseService()
})

afterAll(async () => {
  await database?.close()
  tempRuntimeRoot.cleanup()
})

test('import delta intake writes dirty work in bounded set-based transactions instead of per-row statements', async () => {
  const intake = await getIntake()
  const {counts, database: countingDatabase} = createCountingDatabase()

  await insertRoute({projectId: 'project-bounded', routeId: 'route-bounded'})
  await insertAddedDeltas({count: 120, deltaPrefix: 'bounded', firstWatermark: 1, routeId: 'route-bounded'})

  const result = await intake(
    {
      endSourceHighWaterMark: 120,
      limit: 512,
      sourcePartition: 'importRoute:route-bounded',
      startSourceHighWaterMark: 1,
    },
    countingDatabase,
  )

  expect(result).toEqual({dirtyWorkCount: 120 * importComponentCount, maxSourceHighWaterMark: 120, status: 'converted'})
  expect(await getReconciledCount('route-bounded')).toEqual({pending: 0, reconciled: 120})
  expect(await getDirtyWorkCounts('importRoute:route-bounded')).toEqual({
    claimStates: 120 * importComponentCount,
    dirtyWork: 120 * importComponentCount,
    mismatched: 0,
  })
  expect(counts.transactions).toBe(3)
  expect(counts.statements).toBeLessThan(40)
})

test('a spent intake deadline commits one bounded transaction and leaves the rest of the range for later', async () => {
  const intake = await getIntake()
  const params = {
    endSourceHighWaterMark: 1_120,
    limit: 512,
    sourcePartition: 'importRoute:route-deadline',
    startSourceHighWaterMark: 1_001,
  }

  await insertRoute({projectId: 'project-deadline', routeId: 'route-deadline'})
  await insertAddedDeltas({count: 120, deltaPrefix: 'deadline', firstWatermark: 1_001, routeId: 'route-deadline'})

  const first = await intake({...params, deadlineAtMs: 0}, getDatabase() as ReviewImportDeltaDirtyIntakeDatabase)

  expect(first).toEqual({dirtyWorkCount: 55 * importComponentCount, maxSourceHighWaterMark: 1_055, status: 'converted'})
  expect(await getReconciledCount('route-deadline')).toEqual({pending: 65, reconciled: 55})
  expect(await getDirtyWorkCounts('importRoute:route-deadline')).toEqual({
    claimStates: 55 * importComponentCount,
    dirtyWork: 55 * importComponentCount,
    mismatched: 0,
  })

  const rest = await intake(
    {...params, startSourceHighWaterMark: 1_056},
    getDatabase() as ReviewImportDeltaDirtyIntakeDatabase,
  )

  expect(rest).toEqual({dirtyWorkCount: 65 * importComponentCount, maxSourceHighWaterMark: 1_120, status: 'converted'})
  expect(await getReconciledCount('route-deadline')).toEqual({pending: 0, reconciled: 120})
  expect(await getDirtyWorkCounts('importRoute:route-deadline')).toEqual({
    claimStates: 120 * importComponentCount,
    dirtyWork: 120 * importComponentCount,
    mismatched: 0,
  })
})

test('a later import delta reopens completed dirty work and its claim state like the per-row upsert did', async () => {
  const intake = await getIntake()
  const sourcePartition = 'importRoute:route-reopen'

  await insertRoute({projectId: 'project-reopen', routeId: 'route-reopen'})
  await insertAddedDeltas({count: 2, deltaPrefix: 'reopen-a', firstWatermark: 2_001, routeId: 'route-reopen'})
  await intake(
    {endSourceHighWaterMark: 2_002, limit: 512, sourcePartition, startSourceHighWaterMark: 2_001},
    getDatabase() as ReviewImportDeltaDirtyIntakeDatabase,
  )
  await getDatabase().run(`
    UPDATE app.review_serving_dirty_work SET status = 'completed', lifecycle_reason = 'done'
    WHERE source_partition = '${sourcePartition}'
  `)
  await getDatabase().run(`
    UPDATE app.review_serving_dirty_work_claim_state SET status = 'completed', lifecycle_reason = 'done'
    WHERE source_partition = '${sourcePartition}'
  `)
  await insertAddedDeltas({count: 1, deltaPrefix: 'reopen-b', firstWatermark: 2_010, routeId: 'route-reopen'})

  const result = await intake(
    {endSourceHighWaterMark: 2_010, limit: 512, sourcePartition, startSourceHighWaterMark: 2_010},
    getDatabase() as ReviewImportDeltaDirtyIntakeDatabase,
  )
  const rows = await getDatabase().queryJson<{
    articleId: string
    claimLatest: number
    claimReason: string | null
    claimStatus: string
    first: number
    latest: number
    latestDeltaId: string
    status: string
  }>(`
    SELECT
      dirty.article_id AS articleId,
      dirty.status,
      CAST(dirty.first_source_high_water_mark AS INTEGER) AS first,
      CAST(dirty.latest_source_high_water_mark AS INTEGER) AS latest,
      dirty.latest_delta_id AS latestDeltaId,
      state.status AS claimStatus,
      state.lifecycle_reason AS claimReason,
      CAST(state.latest_source_high_water_mark AS INTEGER) AS claimLatest
    FROM app.review_serving_dirty_work dirty
    INNER JOIN app.review_serving_dirty_work_claim_state state ON state.dirty_work_id = dirty.dirty_work_id
    WHERE dirty.source_partition = '${sourcePartition}' AND dirty.projection_component = 'payload'
    ORDER BY dirty.article_id
  `)

  expect(result).toEqual({dirtyWorkCount: importComponentCount, maxSourceHighWaterMark: 2_010, status: 'converted'})
  expect(rows).toEqual([
    {
      articleId: 'article-0',
      claimLatest: 2_010,
      claimReason: null,
      claimStatus: 'pending',
      first: 2_001,
      latest: 2_010,
      latestDeltaId: 'reopen-b-00000',
      status: 'pending',
    },
    {
      articleId: 'article-1',
      claimLatest: 2_002,
      claimReason: 'done',
      claimStatus: 'completed',
      first: 2_002,
      latest: 2_002,
      latestDeltaId: 'reopen-a-00001',
      status: 'completed',
    },
  ])
})
