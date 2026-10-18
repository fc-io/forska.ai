import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

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

const nativeStrategyId = 'fts-0000000000n24img'
const oldNativeStrategyId = 'fts-0000000000n24old'

const insertStrategy = async (id: string, inputs: Record<string, unknown>) => {
  await getDependencies().database.run(`
    INSERT INTO app.full_text_strategy (id, label, inputs)
    VALUES ('${id}', 'native test', '${JSON.stringify(inputs)}'::JSON)
  `)
}

const writeJpegHeader = (path: string, width: number, height: number) => {
  const frame = [0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3]

  writeFileSync(path, Uint8Array.from([0xff, 0xd8, ...frame, 0xff, 0xd9]))
}

test('native-images plans budget each part with the img-tok estimates of the stored crops', async () => {
  const {getFullTextJudgingBlocks} = getDependencies().blocks
  const database = getDependencies().database
  const cropDirectory = mkdtempSync(join(tmpdir(), 'full-text-judging-blocks-crops-'))
  const cropPath = join(cropDirectory, 'fig-1.jpg')
  const nativeInputs = {
    canonicalTextVersion: 'canonical-v1',
    chunkPolicy: {maxPromptTokens: 24_000, mode: 'chunked'},
    figureMode: 'native_images',
    imageTransportVersion: 'img-v1',
  }

  writeJpegHeader(cropPath, 1383, 993)
  await insertStrategy(nativeStrategyId, {...nativeInputs, imageTokenEstimateVersion: 'img-tok-v1'})
  await insertStrategy(oldNativeStrategyId, nativeInputs)

  const fullText = `${getLongText('Native')}\n\nFigure 1: Flow\n[figure:1]`
  const getNativeRow = (fullTextStrategyId: string, imagePath: string) => {
    return {...getRow(fullText), articleId: 'article-2', fullTextAssets: [{imagePath, index: 1}], fullTextStrategyId}
  }

  try {
    const blocks = await getFullTextJudgingBlocks({
      database,
      rows: [
        getNativeRow(nativeStrategyId, cropPath),
        getNativeRow(oldNativeStrategyId, cropPath),
        {...getNativeRow(nativeStrategyId, `${cropPath}.missing.jpg`), articleId: 'article-3'},
      ],
      writable: false,
    })
    const block = blocks.get(`article-2|${nativeStrategyId}`) ?? null

    const imageTokenCounts = block?.chunkPlan?.chunks.map((chunk) => {
      return chunk.imageTokenCount
    })

    expect(imageTokenCounts?.length).toBeGreaterThan(1)
    expect(imageTokenCounts?.at(-1)).toBe(1696)
    expect(new Set(imageTokenCounts?.slice(0, -1))).toEqual(new Set([0]))
    expect(block?.strategy?.imageTokenEstimateVersion).toBe('img-tok-v1')
    expect(getFullTextJudgingBlockFromPayload(JSON.parse(JSON.stringify(block)))).toEqual(block)
    expect(blocks.get(`article-2|${oldNativeStrategyId}`)?.chunkPlan).toBeNull()
    expect(blocks.get(`article-3|${nativeStrategyId}`)?.chunkPlan).toBeNull()
  } finally {
    rmSync(cropDirectory, {force: true, recursive: true})
  }
})
