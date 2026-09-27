import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {getAppDatabaseService} from '../server/services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../server/test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('migrate-resplit-oversplit-rebuild-chunks')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const migrationSql = readFileSync(
  resolve(import.meta.dir, 'duckdbMigrations', '0246_resplitOversplitRebuildChunks.sql'),
  'utf8',
)

let database: ReturnType<typeof getAppDatabaseService> | null = null

const getDatabase = () => {
  if (database === null) {
    throw new Error('Database not initialized')
  }

  return database
}

const insertChunk = async (input: {
  chunkId: string
  checksum?: string
  leaseOwner?: string
  oomCategory?: string
  parentChunkId?: string
  retryCount?: number
  status: string
}) => {
  const sqlText = (value: string | undefined) => {
    return value === undefined ? 'NULL' : `'${value}'`
  }

  await getDatabase().run(`
    INSERT INTO app.review_rebuild_chunk_manifest (
      chunk_id, project_id, projection_component, projection_identity, chunk_start_key, chunk_end_key, status,
      checksum, lease_owner, lease_expires_at, started_at, completed_at, request_id, parent_chunk_id, split_depth,
      retry_count, oom_category, estimated_input_rows
    ) VALUES (
      '${input.chunkId}', 'project-resplit', 'humanStatus', 'humanStatus:identity', 'a', 'z', '${input.status}',
      ${sqlText(input.checksum)}, ${sqlText(input.leaseOwner)},
      ${input.leaseOwner === undefined ? 'NULL' : "TIMESTAMPTZ '2026-09-27T12:00:00Z'"},
      ${input.status === 'pending' ? 'NULL' : "TIMESTAMPTZ '2026-09-27T10:00:00Z'"},
      ${input.status === 'completed' ? "TIMESTAMPTZ '2026-09-27T10:01:00Z'" : 'NULL'},
      'rebuild:resplit', ${sqlText(input.parentChunkId)}, ${input.parentChunkId === undefined ? 0 : 1},
      ${input.retryCount ?? 0}, ${sqlText(input.oomCategory)}, 214148
    )
  `)
}

const insertSplitParent = async (input: {
  children: {leaseOwner?: string; retryCount?: number; status: string}[]
  chunkId: string
  oomCategory?: string
}) => {
  await insertChunk({
    checksum: `split:${input.chunkId}`,
    chunkId: input.chunkId,
    oomCategory: input.oomCategory,
    status: 'completed',
  })
  await input.children.reduce<Promise<void>>(async (previous, child, index) => {
    await previous
    await insertChunk({...child, chunkId: `${input.chunkId}:child-${index}`, parentChunkId: input.chunkId})
  }, Promise.resolve())
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

test('the migration re-pends estimate-split parents whose children are all untouched and drops those children', async () => {
  await insertSplitParent({
    children: [{status: 'pending'}, {status: 'pending'}, {status: 'pending'}],
    chunkId: 'parent-untouched',
  })
  await insertSplitParent({children: [{status: 'pending'}, {status: 'completed'}], chunkId: 'parent-partly-done'})
  await insertSplitParent({
    children: [{status: 'pending'}, {leaseOwner: 'worker-1', status: 'running'}],
    chunkId: 'parent-running-child',
  })
  await insertSplitParent({
    children: [{status: 'pending'}, {retryCount: 1, status: 'pending'}],
    chunkId: 'parent-retried-child',
  })
  await insertSplitParent({
    children: [{status: 'pending'}, {status: 'pending'}],
    chunkId: 'parent-oom-split',
    oomCategory: 'duckdb_oom_split',
  })

  await getDatabase().run(migrationSql)

  expect(
    await getDatabase().queryJson<{checksum: string | null; chunkId: string; completed: boolean; status: string}>(`
      SELECT chunk_id AS chunkId, status, checksum, completed_at IS NOT NULL AS completed
      FROM app.review_rebuild_chunk_manifest
      WHERE parent_chunk_id IS NULL
      ORDER BY chunk_id
    `),
  ).toEqual([
    {checksum: 'split:parent-oom-split', chunkId: 'parent-oom-split', completed: true, status: 'completed'},
    {checksum: 'split:parent-partly-done', chunkId: 'parent-partly-done', completed: true, status: 'completed'},
    {checksum: 'split:parent-retried-child', chunkId: 'parent-retried-child', completed: true, status: 'completed'},
    {checksum: 'split:parent-running-child', chunkId: 'parent-running-child', completed: true, status: 'completed'},
    {checksum: null, chunkId: 'parent-untouched', completed: false, status: 'pending'},
  ])
  expect(
    await getDatabase().queryJson<{childCount: number; parentChunkId: string}>(`
      SELECT parent_chunk_id AS parentChunkId, COUNT(*)::INTEGER AS childCount
      FROM app.review_rebuild_chunk_manifest
      WHERE parent_chunk_id IS NOT NULL
      GROUP BY parent_chunk_id
      ORDER BY parent_chunk_id
    `),
  ).toEqual([
    {childCount: 2, parentChunkId: 'parent-oom-split'},
    {childCount: 2, parentChunkId: 'parent-partly-done'},
    {childCount: 2, parentChunkId: 'parent-retried-child'},
    {childCount: 2, parentChunkId: 'parent-running-child'},
  ])

  await getDatabase().run(migrationSql)

  expect(
    await getDatabase().queryJson<{count: number}>(`
      SELECT COUNT(*)::INTEGER AS count
      FROM app.review_rebuild_chunk_manifest
    `),
  ).toEqual([{count: 13}])
})
