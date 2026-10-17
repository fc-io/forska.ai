import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import {getFullTextJudgingBlockFromPayload} from '../../agent/judge/fullTextJudgingInput.ts'
import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('full-text-judging-blocks')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

type Database = {
  close: () => Promise<void>
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

type Dependencies = {blocks: typeof import('./fullTextJudgingBlocks.ts'); database: Database}

const dependencies: {current: Dependencies | null} = {current: null}

const getDependencies = (): Dependencies => {
  if (!dependencies.current) {
    throw new Error('Test dependencies not initialized')
  }

  return dependencies.current
}

const strategyId = 'fts-00000000000c24a1'

const getLongText = (marker: string): string => {
  return Array.from({length: 10}, (_, section) => {
    const sentences = Array.from({length: 110}, (__, sentence) => {
      return `${marker} section ${section} sentence ${sentence} describes allocation, follow-up and the outcome measured in arm ${sentence % 3}.`
    }).join(' ')

    return `## Results > Part ${section + 1}\n\n${sentences}`
  }).join('\n\n')
}

const getRow = (fullText: string) => {
  return {
    articleId: 'article-1',
    articleSummary: 'Adults with chronic pain.',
    fullText,
    fullTextAssets: [],
    fullTextCanonicalVersion: 'canonical-v1',
    fullTextFigureModeBuilt: 'markers',
    fullTextStrategyId: strategyId,
  }
}

const getStoredPlans = () => {
  return getDependencies().database.queryJson<{chunkCount: number; planHash: string; textHash: string}>(`
    SELECT chunk_count AS chunkCount, plan_hash AS planHash, text_hash AS textHash
    FROM app.article_full_text_chunk_plan
    WHERE article_id = 'article-1'
  `)
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

  dependencies.current = {blocks: await import('./fullTextJudgingBlocks.ts'), database: getAppDatabaseService()}

  await getDependencies().database.run(`
    INSERT INTO app.full_text_strategy (id, label, inputs)
    VALUES ('${strategyId}', 'v1 test', '${JSON.stringify({
      canonicalTextVersion: 'canonical-v1',
      chunkPolicy: {maxPromptTokens: 24_000, mode: 'chunked'},
      figureDescriptionModelId: null,
      figureDescriptionPromptVersion: null,
      figureMode: 'none',
    })}'::JSON)
  `)
})

afterAll(async () => {
  await dependencies.current?.database.close()
  tempRuntimeRoot.cleanup()
})

test('the owner stores the chunk plan once and later blocks read it back from the cache', async () => {
  const {getFullTextJudgingBlocks} = getDependencies().blocks
  const database = getDependencies().database
  const row = getRow(getLongText('First'))
  const readOnly = await getFullTextJudgingBlocks({database, rows: [row], writable: false})

  expect(await getStoredPlans()).toEqual([])

  const first = await getFullTextJudgingBlocks({database, rows: [row, row], writable: true})
  const firstPlan = first.get(`article-1|${strategyId}`)?.chunkPlan

  expect(firstPlan?.chunkCount).toBeGreaterThan(1)
  expect(readOnly.get(`article-1|${strategyId}`)?.chunkPlan).toEqual(firstPlan ?? null)
  expect(await getStoredPlans()).toEqual([
    {chunkCount: firstPlan?.chunkCount ?? 0, planHash: firstPlan?.planHash ?? '', textHash: firstPlan?.textHash ?? ''},
  ])

  await database.run(`
    UPDATE app.article_full_text_chunk_plan
    SET plan_hash = 'cached-plan-marker'
    WHERE article_id = 'article-1'
  `)

  const cached = await getFullTextJudgingBlocks({database, rows: [row], writable: true})

  expect(cached.get(`article-1|${strategyId}`)?.chunkPlan?.planHash).toBe('cached-plan-marker')
})

test('a changed canonical text rebuilds and replaces the cached plan; blocks survive the snapshot payload', async () => {
  const {getFullTextJudgingBlocks} = getDependencies().blocks
  const database = getDependencies().database
  const rebuilt = await getFullTextJudgingBlocks({database, rows: [getRow(getLongText('Second'))], writable: true})
  const block = rebuilt.get(`article-1|${strategyId}`) ?? null
  const [stored] = await getStoredPlans()

  expect(block?.chunkPlan?.planHash).not.toBe('cached-plan-marker')
  expect(stored?.planHash).toBe(block?.chunkPlan?.planHash ?? '')
  expect(getFullTextJudgingBlockFromPayload(JSON.parse(JSON.stringify(block)))).toEqual(block)
})
