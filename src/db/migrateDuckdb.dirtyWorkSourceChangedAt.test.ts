import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {getAppDatabaseService} from '../server/services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../server/test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('migrate-dirty-work-source-changed-at')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const migrationSql = readFileSync(
  resolve(import.meta.dir, 'duckdbMigrations', '0247_reviewServingDirtyWorkSourceChangedAt.sql'),
  'utf8',
)

let database: ReturnType<typeof getAppDatabaseService> | null = null

const getDatabase = () => {
  if (database === null) {
    throw new Error('Database not initialized')
  }

  return database
}

const insertDirtyWork = async (input: {
  dirtyWorkId: string
  firstSourceHighWaterMark: number
  latestSourceHighWaterMark: number
  sourceChangedAt?: string
  status: string
}) => {
  await getDatabase().run(`
    INSERT INTO app.review_serving_dirty_work (
      dirty_work_id, project_id, scope_kind, scope_id, article_id, projection_component, projection_identity,
      dirty_kind, source_partition, first_source_high_water_mark, latest_source_high_water_mark, status,
      created_at, updated_at, source_changed_at
    ) VALUES (
      '${input.dirtyWorkId}', 'project-backfill', 'article', 'project-backfill:article-1', 'article-1',
      'judgmentInputContent', 'judgmentInputContent:identity', 'article.judgmentInput.updated', 'article:all',
      ${input.firstSourceHighWaterMark}, ${input.latestSourceHighWaterMark}, '${input.status}',
      TIMESTAMPTZ '2026-09-27T20:00:00Z', TIMESTAMPTZ '2026-09-28T08:00:00Z',
      ${input.sourceChangedAt === undefined ? 'NULL' : `TIMESTAMPTZ '${input.sourceChangedAt}'`}
    )
  `)
}

beforeAll(async () => {
  const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] =
    await Promise.all([
      import('./migrateDuckdb.ts'),
      import('../server/services/appDatabaseService.ts'),
      import('../server/utils/duckdbService.ts'),
      import('../server/utils/serverRuntimeRole.ts'),
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

test('the migration dates open rows with one merged change from creation and other open rows from their last update', async () => {
  await insertDirtyWork({
    dirtyWorkId: 'dirty-single-change-released',
    firstSourceHighWaterMark: 7,
    latestSourceHighWaterMark: 7,
    status: 'pending',
  })
  await insertDirtyWork({
    dirtyWorkId: 'dirty-single-change-parked',
    firstSourceHighWaterMark: 7,
    latestSourceHighWaterMark: 7,
    status: 'blocked_by_rebuild',
  })
  await insertDirtyWork({
    dirtyWorkId: 'dirty-merged-changes',
    firstSourceHighWaterMark: 7,
    latestSourceHighWaterMark: 9,
    status: 'pending',
  })
  await insertDirtyWork({
    dirtyWorkId: 'dirty-completed',
    firstSourceHighWaterMark: 7,
    latestSourceHighWaterMark: 7,
    status: 'completed',
  })
  await insertDirtyWork({
    dirtyWorkId: 'dirty-already-dated',
    firstSourceHighWaterMark: 7,
    latestSourceHighWaterMark: 7,
    sourceChangedAt: '2026-09-28T07:00:00Z',
    status: 'pending',
  })

  await getDatabase().run(migrationSql)

  expect(
    await getDatabase().queryJson<{dirtyWorkId: string; sourceChangedAt: string | null}>(`
      SELECT
        dirty_work_id AS dirtyWorkId,
        strftime(source_changed_at AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%SZ') AS sourceChangedAt
      FROM app.review_serving_dirty_work
      WHERE project_id = 'project-backfill'
      ORDER BY dirty_work_id
    `),
  ).toEqual([
    {dirtyWorkId: 'dirty-already-dated', sourceChangedAt: '2026-09-28T07:00:00Z'},
    {dirtyWorkId: 'dirty-completed', sourceChangedAt: null},
    {dirtyWorkId: 'dirty-merged-changes', sourceChangedAt: '2026-09-28T08:00:00Z'},
    {dirtyWorkId: 'dirty-single-change-parked', sourceChangedAt: '2026-09-27T20:00:00Z'},
    {dirtyWorkId: 'dirty-single-change-released', sourceChangedAt: '2026-09-27T20:00:00Z'},
  ])
})
