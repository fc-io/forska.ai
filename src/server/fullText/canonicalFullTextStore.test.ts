import {readFileSync} from 'node:fs'
import {mkdir, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('canonical-full-text-store')
const originalCwd = process.cwd()
const fixtureName = 'frontiers-fmed-2023-1283512.mineru'

process.chdir(tempRuntimeRoot.rootDirectory)
process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

type CanonicalArticleRow = {
  figureMode: string | null
  fullText: string | null
  hash: string | null
  version: string | null
}

type DatabaseService = {
  close: () => Promise<void>
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

let database: DatabaseService | null = null
let storeModule: typeof import('./canonicalFullTextStore.ts') | null = null
let routes: {handle: (request: Request) => Promise<Response>} | null = null

const readFixture = (fileName: string): string => {
  return readFileSync(new URL(`./fixtures/canonical/${fileName}`, import.meta.url), 'utf8')
}

const getDatabase = (): DatabaseService => {
  if (!database) {
    throw new Error('Test dependencies not initialized')
  }

  return database
}

const getStoreModule = () => {
  if (!storeModule) {
    throw new Error('Test dependencies not initialized')
  }

  return storeModule
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
  storeModule = await import('./canonicalFullTextStore.ts')
  routes = (await import('../routes/ArticleAdminRoutes.ts')).articleAdminRoutes
})

afterAll(async () => {
  await database?.close()
  process.chdir(originalCwd)
  tempRuntimeRoot.cleanup()
})

const seedConvertedArticle = async ({
  articleId,
  conversionStatus = 'success',
  layoutContent = readFixture(`${fixtureName}.layout.json`),
}: {
  articleId: string
  conversionStatus?: string | null
  layoutContent?: string
}) => {
  const layoutPath = `assets/full-text-assets/${articleId}/layout.json`
  const metadata = {converterKind: 'mineru', layoutPath, layoutVersion: 'layout-v2'}

  await mkdir(join(tempRuntimeRoot.rootDirectory, `assets/full-text-assets/${articleId}`), {recursive: true})
  await writeFile(join(tempRuntimeRoot.rootDirectory, layoutPath), layoutContent)
  await getDatabase().run(`
    INSERT INTO app.article (
      id, article_title, full_text, full_text_assets, full_text_conversion_status, full_text_conversion_metadata
    )
    VALUES (
      '${articleId}',
      '${articleId}',
      'stale converter markdown',
      CAST('${readFixture(`${fixtureName}.assets.json`).replaceAll("'", "''")}' AS JSON),
      ${conversionStatus === null ? 'NULL' : `'${conversionStatus}'`},
      CAST('${JSON.stringify(metadata)}' AS JSON)
    )
  `)
}

const getCanonicalArticle = async (articleId: string): Promise<CanonicalArticleRow | undefined> => {
  const [row] = await getDatabase().queryJson<CanonicalArticleRow>(`
    SELECT
      full_text AS fullText,
      full_text_canonical_hash AS hash,
      full_text_canonical_version AS version,
      full_text_figure_mode_built AS figureMode
    FROM app.article
    WHERE id = '${articleId}'
  `)

  return row
}

const getDeltaCount = async (articleId: string): Promise<number> => {
  const [row] = await getDatabase().queryJson<{count: number | string}>(`
    SELECT COUNT(*) AS count FROM app.review_change_delta WHERE article_id = '${articleId}'
  `)

  return Number(row?.count ?? 0)
}

const postRebuild = async (articleId: string, body: unknown): Promise<Response> => {
  if (!routes) {
    throw new Error('Test dependencies not initialized')
  }

  return routes.handle(
    new Request(`http://localhost/api/articles/${articleId}/canonical-fulltext/rebuild`, {
      body: JSON.stringify(body),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
}

test('rebuild writes the canonical text, hash, version and figure mode and appends a review-serving delta', async () => {
  await seedConvertedArticle({articleId: 'rebuild-article-1'})

  const result = await getStoreModule().rebuildCanonicalFullText({articleId: 'rebuild-article-1', figureMode: 'none'})

  expect(result).toMatchObject({
    articleId: 'rebuild-article-1',
    changed: true,
    figureMode: 'none',
    hash: 'cece6ecb280c032b4ebbd648c99e4239e8e79d16012d317f04fad7ed1074294e',
    version: 'canonical-v1',
  })
  expect(await getCanonicalArticle('rebuild-article-1')).toEqual({
    figureMode: 'none',
    fullText: readFixture(`${fixtureName}.none.md`),
    hash: 'cece6ecb280c032b4ebbd648c99e4239e8e79d16012d317f04fad7ed1074294e',
    version: 'canonical-v1',
  })
  expect(await getDeltaCount('rebuild-article-1')).toBeGreaterThan(0)
})

test('rebuilding with unchanged inputs writes nothing', async () => {
  const deltasBefore = await getDeltaCount('rebuild-article-1')
  const result = await getStoreModule().rebuildCanonicalFullText({articleId: 'rebuild-article-1', figureMode: 'none'})

  expect(result.changed).toBe(false)
  expect(await getDeltaCount('rebuild-article-1')).toBe(deltasBefore)
})

test('the rebuild route switches the stored text to another figure mode', async () => {
  const response = await postRebuild('rebuild-article-1', {figureMode: 'native_images'})
  const body = (await response.json()) as {changed: boolean; figureMode: string; hash: string}

  expect(response.status).toBe(200)
  expect(body).toMatchObject({
    changed: true,
    figureMode: 'native_images',
    hash: '401b62d6e2f1b97f09afe6af3b5e8563b58bdfd48677bcc45bd3c63208f544c4',
  })
  expect(await getCanonicalArticle('rebuild-article-1')).toEqual({
    figureMode: 'native_images',
    fullText: readFixture(`${fixtureName}.native_images.md`),
    hash: '401b62d6e2f1b97f09afe6af3b5e8563b58bdfd48677bcc45bd3c63208f544c4',
    version: 'canonical-v1',
  })
})

test('the rebuild route refuses unknown figure modes, unknown articles and unconverted articles', async () => {
  await seedConvertedArticle({articleId: 'rebuild-article-unconverted', conversionStatus: null})

  const badMode = await postRebuild('rebuild-article-1', {figureMode: 'pictures'})
  const missing = await postRebuild('rebuild-article-missing', {figureMode: 'none'})
  const unconverted = await postRebuild('rebuild-article-unconverted', {figureMode: 'none'})

  expect(badMode.status).toBe(422)
  expect(missing.status).toBe(404)
  expect(unconverted.status).toBe(409)
  expect(await unconverted.text()).toContain(
    'Article rebuild-article-unconverted has no successful full-text conversion',
  )
  expect((await getCanonicalArticle('rebuild-article-1'))?.figureMode).toBe('native_images')
})

test('a layout file without the layout-v2 envelope asks for a reconversion instead of rebuilding', async () => {
  const blocks = (JSON.parse(readFixture(`${fixtureName}.layout.json`)) as {blocks: unknown[]}).blocks

  await seedConvertedArticle({articleId: 'rebuild-article-old-layout', layoutContent: JSON.stringify(blocks)})

  const response = await postRebuild('rebuild-article-old-layout', {figureMode: 'none'})

  expect(response.status).toBe(409)
  expect(await response.text()).toContain(
    'Article rebuild-article-old-layout layout file assets/full-text-assets/rebuild-article-old-layout/layout.json is not layout-v2; reconvert the article',
  )
  expect((await getCanonicalArticle('rebuild-article-old-layout'))?.fullText).toBe('stale converter markdown')
})
