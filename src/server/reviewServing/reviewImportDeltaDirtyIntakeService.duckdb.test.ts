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
  const counts = {dirtyWorkBatches: 0, statements: 0, transactions: 0}
  const countStatements = (tx: ReviewServingDirtyWorkTransaction): ReviewServingDirtyWorkTransaction => {
    return {
      queryJson: <T>(statement: string) => {
        counts.statements += 1

        return tx.queryJson<T>(statement)
      },
      run: (statement: string) => {
        counts.statements += 1
        counts.dirtyWorkBatches += statement.includes('INSERT INTO temp_review_serving_dirty_work_batch_') ? 1 : 0

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

const insertRoute = async (input: {
  archivedProjectIds?: readonly string[]
  projectId?: string
  projectIds?: readonly string[]
  routeId: string
}) => {
  const projectIds = input.projectIds ?? [input.projectId ?? `project-${input.routeId}`]
  const archivedProjectIds = input.archivedProjectIds ?? []

  await getDatabase().run(
    `INSERT INTO app.import_route (id, route, name) VALUES ('${input.routeId}', '${input.routeId}', '${input.routeId}')`,
  )
  await getDatabase().run(`
    INSERT INTO app.project (id, name, model_id, archived)
    VALUES ${projectIds
      .map((projectId) => {
        return `('${projectId}', '${projectId}', 'model-intake', ${archivedProjectIds.includes(projectId)})`
      })
      .join(', ')}
  `)
  await getDatabase().run(`
    INSERT INTO app.project_import_route (id, project_id, import_route_id)
    VALUES ${projectIds
      .map((projectId) => {
        return `('${projectId}:${input.routeId}', '${projectId}', '${input.routeId}')`
      })
      .join(', ')}
  `)
}

const insertAddedDeltas = async (input: {
  count: number
  deltaPrefix: string
  firstArticle?: number
  firstWatermark: number
  routeId: string
  sourcePartition?: string
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
      '${input.sourcePartition ?? `importRoute:${input.routeId}`}',
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

  await getDatabase().run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('connection-intake', 'sglang', 'SGLang', TRUE, 'none', 'https://worker.example.test')
  `)
  await getDatabase().run(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled, variant, metadata_json)
    VALUES ('model-intake', 'connection-intake', 'model', 'model', 'Model', 'manual', TRUE, 'thinking', '{}'::JSON)
  `)
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
    {limit: 512, sourcePartition: 'importRoute:route-bounded', startSourceHighWaterMark: 1},
    countingDatabase,
  )

  expect(result).toEqual({dirtyWorkCount: 120 * importComponentCount, maxSourceHighWaterMark: 120, status: 'converted'})
  expect(await getReconciledCount('route-bounded')).toEqual({pending: 0, reconciled: 120})
  expect(await getDirtyWorkCounts('importRoute:route-bounded')).toEqual({
    claimStates: 120 * importComponentCount,
    dirtyWork: 120 * importComponentCount,
    mismatched: 0,
  })
  expect(counts.transactions).toBe(1)
  expect(counts.dirtyWorkBatches).toBe(1)
  expect(counts.statements).toBeLessThan(20)
})

test('four-project import deltas commit one dirty-work batch per transaction without a spill chunk', async () => {
  const intake = await getIntake()
  const {counts, database: countingDatabase} = createCountingDatabase()
  const sourcePartition = 'import-route:route-four-projects'

  await insertRoute({
    projectIds: ['project-four-a', 'project-four-b', 'project-four-c', 'project-four-d'],
    routeId: 'route-four-projects',
  })
  await insertAddedDeltas({
    count: 300,
    deltaPrefix: 'four-projects',
    firstWatermark: 5_001,
    routeId: 'route-four-projects',
    sourcePartition,
  })

  const result = await intake({limit: 1_024, sourcePartition, startSourceHighWaterMark: 5_001}, countingDatabase)

  expect(result).toEqual({
    dirtyWorkCount: 300 * 4 * importComponentCount,
    maxSourceHighWaterMark: 5_300,
    status: 'converted',
  })
  expect(await getReconciledCount('route-four-projects')).toEqual({pending: 0, reconciled: 300})
  expect(await getDirtyWorkCounts(sourcePartition)).toEqual({
    claimStates: 300 * 4 * importComponentCount,
    dirtyWork: 300 * 4 * importComponentCount,
    mismatched: 0,
  })
  expect(counts.transactions).toBe(3)
  expect(counts.dirtyWorkBatches).toBe(counts.transactions)
})

test('import delta intake reconciles deltas without queueing dirty work for archived projects on the route', async () => {
  const intake = await getIntake()
  const sourcePartition = 'import-route:route-archived-projects'

  await insertRoute({
    archivedProjectIds: ['project-archived-a', 'project-archived-b'],
    projectIds: ['project-active', 'project-archived-a', 'project-archived-b'],
    routeId: 'route-archived-projects',
  })
  await insertAddedDeltas({
    count: 20,
    deltaPrefix: 'archived-projects',
    firstWatermark: 7_001,
    routeId: 'route-archived-projects',
    sourcePartition,
  })

  const result = await intake(
    {limit: 1_024, sourcePartition, startSourceHighWaterMark: 7_001},
    getDatabase() as ReviewImportDeltaDirtyIntakeDatabase,
  )

  expect(result).toEqual({
    dirtyWorkCount: 20 * importComponentCount,
    maxSourceHighWaterMark: 7_020,
    status: 'converted',
  })
  expect(await getReconciledCount('route-archived-projects')).toEqual({pending: 0, reconciled: 20})
  expect(
    await getDatabase().queryJson<{projectId: string; rows: number}>(`
      SELECT project_id AS projectId, CAST(count(*) AS INTEGER) AS rows
      FROM app.review_serving_dirty_work
      WHERE source_partition = '${sourcePartition}'
      GROUP BY ALL
    `),
  ).toEqual([{projectId: 'project-active', rows: 20 * importComponentCount}])
})

test('a rank-field delta followed by the same article being added in the window only queues the add', async () => {
  const intake = await getIntake()
  const sourcePartition = 'import-route:route-rank-fold'
  const insertDelta = async (input: {articleId: string; changeKind: string; deltaId: string; watermark: number}) => {
    await getDatabase().run(`
      INSERT INTO app.import_run_article_delta (
        delta_id, change_kind, source_table, source_row_id, source_operation, source_partition, source_high_water_mark,
        idempotency_key, payload_version, import_route_id, article_id, source_record_key
      ) VALUES (
        '${input.deltaId}', '${input.changeKind}', 'app.article_import_route', 'row-${input.deltaId}', 'insert',
        '${sourcePartition}', ${input.watermark}, 'key-${input.deltaId}', 1, 'route-rank-fold', '${input.articleId}',
        'record-${input.articleId}'
      )
    `)
  }

  await insertRoute({projectIds: ['project-rank-fold'], routeId: 'route-rank-fold'})
  await insertDelta({
    articleId: 'article-folded',
    changeKind: 'importRoute.article.rankFields.updated',
    deltaId: 'rank-folded',
    watermark: 9_001,
  })
  await insertDelta({
    articleId: 'article-folded',
    changeKind: 'importRoute.article.added',
    deltaId: 'added-folded',
    watermark: 9_002,
  })
  await insertDelta({
    articleId: 'article-kept',
    changeKind: 'importRoute.article.added',
    deltaId: 'added-kept',
    watermark: 9_003,
  })
  await insertDelta({
    articleId: 'article-kept',
    changeKind: 'importRoute.article.rankFields.updated',
    deltaId: 'rank-kept',
    watermark: 9_004,
  })

  const result = await intake(
    {limit: 1_024, sourcePartition, startSourceHighWaterMark: 9_001},
    getDatabase() as ReviewImportDeltaDirtyIntakeDatabase,
  )

  expect(result).toEqual({
    dirtyWorkCount: 2 * importComponentCount + 4,
    maxSourceHighWaterMark: 9_004,
    status: 'converted',
  })
  expect(await getReconciledCount('route-rank-fold')).toEqual({pending: 0, reconciled: 4})
  expect(
    await getDatabase().queryJson<{articleId: string; dirtyKind: string; rows: number}>(`
      SELECT article_id AS articleId, dirty_kind AS dirtyKind, CAST(count(*) AS INTEGER) AS rows
      FROM app.review_serving_dirty_work
      WHERE source_partition = '${sourcePartition}'
      GROUP BY ALL
      ORDER BY articleId, dirtyKind
    `),
  ).toEqual([
    {articleId: 'article-folded', dirtyKind: 'importRoute.article.added', rows: importComponentCount},
    {articleId: 'article-kept', dirtyKind: 'importRoute.article.added', rows: importComponentCount},
    {articleId: 'article-kept', dirtyKind: 'importRoute.article.rankFields.updated', rows: 4},
  ])
})

test('a spent intake deadline commits one bounded transaction and leaves the rest of the range for later', async () => {
  const intake = await getIntake()
  const sourcePartition = 'import-route:route-deadline'
  const params = {limit: 512, sourcePartition, startSourceHighWaterMark: 1_001}
  const deltasPerGroup = Math.floor(4_096 / (4 * importComponentCount))

  await insertRoute({
    projectIds: ['project-deadline-a', 'project-deadline-b', 'project-deadline-c', 'project-deadline-d'],
    routeId: 'route-deadline',
  })
  await insertAddedDeltas({
    count: 150,
    deltaPrefix: 'deadline',
    firstWatermark: 1_001,
    routeId: 'route-deadline',
    sourcePartition,
  })

  const first = await intake({...params, deadlineAtMs: 0}, getDatabase() as ReviewImportDeltaDirtyIntakeDatabase)

  expect(first).toEqual({
    dirtyWorkCount: deltasPerGroup * 4 * importComponentCount,
    maxSourceHighWaterMark: 1_000 + deltasPerGroup,
    status: 'converted',
  })
  expect(await getReconciledCount('route-deadline')).toEqual({
    pending: 150 - deltasPerGroup,
    reconciled: deltasPerGroup,
  })
  expect(await getDirtyWorkCounts(sourcePartition)).toEqual({
    claimStates: deltasPerGroup * 4 * importComponentCount,
    dirtyWork: deltasPerGroup * 4 * importComponentCount,
    mismatched: 0,
  })

  const rest = await intake(params, getDatabase() as ReviewImportDeltaDirtyIntakeDatabase)

  expect(rest).toEqual({
    dirtyWorkCount: (150 - deltasPerGroup) * 4 * importComponentCount,
    maxSourceHighWaterMark: 1_150,
    status: 'converted',
  })
  expect(await getReconciledCount('route-deadline')).toEqual({pending: 0, reconciled: 150})
  expect(await getDirtyWorkCounts(sourcePartition)).toEqual({
    claimStates: 150 * 4 * importComponentCount,
    dirtyWork: 150 * 4 * importComponentCount,
    mismatched: 0,
  })
})

test('import delta intake keeps reading windows after the sampled start until the budget or backlog ends', async () => {
  const intake = await getIntake()
  const {counts, database: countingDatabase} = createCountingDatabase()
  const sourcePartition = 'import-route:route-windows'

  await insertRoute({projectId: 'project-windows', routeId: 'route-windows'})
  await insertAddedDeltas({
    count: 50,
    deltaPrefix: 'windows',
    firstWatermark: 7_001,
    routeId: 'route-windows',
    sourcePartition,
  })
  await getDatabase().run(`
    UPDATE app.import_run_article_delta SET reconciled_at = current_timestamp
    WHERE import_route_id = 'route-windows' AND source_high_water_mark BETWEEN 7_011 AND 7_020
  `)

  const result = await intake(
    {deadlineAtMs: Date.now() + 60_000, limit: 8, sourcePartition, startSourceHighWaterMark: 7_001},
    countingDatabase,
  )
  const [dirtyWorkForReconciledRange] = await getDatabase().queryJson<{count: number}>(`
    SELECT CAST(count(*) AS INTEGER) AS count
    FROM app.review_serving_dirty_work
    WHERE source_partition = '${sourcePartition}'
      AND latest_source_high_water_mark BETWEEN 7_011 AND 7_020
  `)

  expect(result).toEqual({
    dirtyWorkCount: 40 * importComponentCount,
    maxSourceHighWaterMark: 7_050,
    status: 'converted',
  })
  expect(await getReconciledCount('route-windows')).toEqual({pending: 0, reconciled: 50})
  expect(dirtyWorkForReconciledRange).toEqual({count: 0})
  expect(counts.transactions).toBe(5)
})

test('a later import delta reopens completed dirty work and its claim state like the per-row upsert did', async () => {
  const intake = await getIntake()
  const sourcePartition = 'importRoute:route-reopen'

  await insertRoute({projectId: 'project-reopen', routeId: 'route-reopen'})
  await insertAddedDeltas({count: 2, deltaPrefix: 'reopen-a', firstWatermark: 2_001, routeId: 'route-reopen'})
  await intake(
    {limit: 512, sourcePartition, startSourceHighWaterMark: 2_001},
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
    {limit: 512, sourcePartition, startSourceHighWaterMark: 2_010},
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
