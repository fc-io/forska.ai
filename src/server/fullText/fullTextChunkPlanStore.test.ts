import {afterAll, beforeAll, beforeEach, expect, setDefaultTimeout, test} from 'bun:test'

import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('full-text-chunk-plan-store')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

const state: {
  database: {
    close: () => Promise<void>
    queryJson: <T>(statement: string) => Promise<T[]>
    run: (statement: string) => Promise<void>
  } | null
  store: typeof import('./fullTextChunkPlanStore.ts') | null
} = {database: null, store: null}

const getState = () => {
  if (!state.database || !state.store) {
    throw new Error('Test dependencies not initialized')
  }

  return {database: state.database, store: state.store}
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

  state.database = getAppDatabaseService()
  state.store = await import('./fullTextChunkPlanStore.ts')

  await state.database.run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('plan-connection', 'openai-compatible', 'LLM', TRUE, 'none', 'http://127.0.0.1:9/v1');
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('plan-model', 'plan-connection', 'judge', 'judge', 'Judge', 'discovered', TRUE);
  `)
})

afterAll(async () => {
  await state.database?.close()
  tempRuntimeRoot.cleanup()
})

beforeEach(async () => {
  await getState().database.run(`
    DELETE FROM app.article_full_text_chunk_plan;
    DELETE FROM app.judgment_job;
    DELETE FROM app.project;
    DELETE FROM app.article;
  `)
})

const insertPlans = async (keys: Array<[articleId: string, strategyId: string]>) => {
  await getState().database.run(`
    INSERT INTO app.article_full_text_chunk_plan (article_id, full_text_strategy_id, plan_hash, text_hash, chunk_count, chunks)
    VALUES ${keys
      .map(([articleId, strategyId]) => {
        return `('${articleId}', '${strategyId}', 'plan-${articleId}-${strategyId}', 'text', 1, '[]'::JSON)`
      })
      .join(', ')}
  `)
}

const getPlanKeys = async () => {
  const rows = await getState().database.queryJson<{articleId: string; strategyId: string}>(`
    SELECT article_id AS articleId, full_text_strategy_id AS strategyId
    FROM app.article_full_text_chunk_plan
    ORDER BY article_id, full_text_strategy_id
  `)

  return rows.map(({articleId, strategyId}) => {
    return `${articleId}|${strategyId}`
  })
}

test('a canonical write keeps the cached plans when the hash is unchanged and drops them when it changes', async () => {
  const {database, store} = getState()

  await database.run(`
    INSERT INTO app.article (id, article_title, full_text_canonical_hash)
    VALUES ('article-a', 'A', 'hash-1'), ('article-b', 'B', 'hash-1'), ('article-c', 'C', NULL)
  `)
  await insertPlans([
    ['article-a', 'fts-1'],
    ['article-a', 'fts-2'],
    ['article-b', 'fts-1'],
    ['article-c', 'fts-1'],
  ])

  await database.run(
    store.getDeleteChunkPlansForChangedCanonicalHashSql({articleId: 'article-a', canonicalHash: 'hash-1'}),
  )
  expect(await getPlanKeys()).toEqual(['article-a|fts-1', 'article-a|fts-2', 'article-b|fts-1', 'article-c|fts-1'])

  await database.run(
    store.getDeleteChunkPlansForChangedCanonicalHashSql({articleId: 'article-a', canonicalHash: 'hash-2'}),
  )
  await database.run(
    store.getDeleteChunkPlansForChangedCanonicalHashSql({articleId: 'article-c', canonicalHash: 'hash-1'}),
  )
  expect(await getPlanKeys()).toEqual(['article-b|fts-1'])
})

test('cleanup prunes plans whose strategy no project or job uses, oldest first and bounded per run', async () => {
  const {database, store} = getState()

  await database.run(`
    INSERT INTO app.project (id, name, model_id, full_text_strategy_id)
    VALUES ('project-live', 'Live', 'plan-model', 'fts-project'), ('project-archived', 'Archived', 'plan-model', 'fts-archived');
    UPDATE app.project SET archived = TRUE WHERE id = 'project-archived';
    INSERT INTO app.project (id, name, model_id) VALUES ('project-plain', 'Plain', 'plan-model');
    INSERT INTO app.judgment_job (id, project_id, status, full_text_strategy_id)
    VALUES ('job-plain', 'project-plain', 'paused', 'fts-job');
  `)
  await insertPlans([
    ['article-1', 'fts-project'],
    ['article-1', 'fts-gone'],
    ['article-2', 'fts-gone'],
    ['article-3', 'fts-job'],
    ['article-3', 'fts-archived'],
    ['article-4', 'fts-gone'],
  ])

  expect(await store.pruneOrphanedFullTextChunkPlans({maxRows: 2})).toBe(2)
  expect(await getPlanKeys()).toEqual([
    'article-1|fts-project',
    'article-3|fts-archived',
    'article-3|fts-job',
    'article-4|fts-gone',
  ])
  expect(await store.pruneOrphanedFullTextChunkPlans()).toBe(1)
  expect(await store.pruneOrphanedFullTextChunkPlans()).toBe(0)
  expect(await getPlanKeys()).toEqual(['article-1|fts-project', 'article-3|fts-archived', 'article-3|fts-job'])
})
