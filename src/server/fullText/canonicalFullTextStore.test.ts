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
      ...(body === undefined ? {} : {body: JSON.stringify(body), headers: {'content-type': 'application/json'}}),
      method: 'POST',
    }),
  )
}

const markerHash = '762c21377944f8b420eb7ab6ba87f8b8123c870bdbb40a6d38f4a87dd6db473b'

test('rebuild writes the marker-form canonical text, hash, version and form and appends a review-serving delta', async () => {
  await seedConvertedArticle({articleId: 'rebuild-article-1'})

  const result = await getStoreModule().rebuildCanonicalFullText({articleId: 'rebuild-article-1'})

  expect(result).toMatchObject({
    articleId: 'rebuild-article-1',
    changed: true,
    form: 'markers',
    hash: markerHash,
    version: 'canonical-v1',
  })
  expect(await getCanonicalArticle('rebuild-article-1')).toEqual({
    figureMode: 'markers',
    fullText: readFixture(`${fixtureName}.native_images.md`),
    hash: markerHash,
    version: 'canonical-v1',
  })
  expect(await getDeltaCount('rebuild-article-1')).toBeGreaterThan(0)
})

test('rebuilding with unchanged inputs writes nothing, and the legacy native_images form counts as markers', async () => {
  const deltasBefore = await getDeltaCount('rebuild-article-1')
  const unchanged = await getStoreModule().rebuildCanonicalFullText({articleId: 'rebuild-article-1'})

  await getDatabase().run(
    `UPDATE app.article SET full_text_figure_mode_built = 'native_images' WHERE id = 'rebuild-article-1'`,
  )

  const legacyForm = await getStoreModule().rebuildCanonicalFullText({articleId: 'rebuild-article-1'})

  expect(unchanged.changed).toBe(false)
  expect(legacyForm.changed).toBe(false)
  expect(await getDeltaCount('rebuild-article-1')).toBe(deltasBefore)
})

test('the rebuild route takes no figure mode: omitted or markers is accepted, any other mode is a 400', async () => {
  await getDatabase().run(`UPDATE app.article SET full_text_figure_mode_built = 'none' WHERE id = 'rebuild-article-1'`)

  const noBody = await postRebuild('rebuild-article-1', undefined)
  const markers = await postRebuild('rebuild-article-1', {figureMode: 'markers'})
  const none = await postRebuild('rebuild-article-1', {figureMode: 'none'})
  const nativeImages = await postRebuild('rebuild-article-1', {figureMode: 'native_images'})

  expect(noBody.status).toBe(200)
  expect(await noBody.json()).toMatchObject({changed: true, form: 'markers', hash: markerHash})
  expect(markers.status).toBe(200)
  expect(await markers.json()).toMatchObject({changed: false})
  expect(none.status).toBe(400)
  expect(await none.text()).toContain('figure mode none is applied when judging')
  expect(nativeImages.status).toBe(400)
  expect((await getCanonicalArticle('rebuild-article-1'))?.figureMode).toBe('markers')
})

test('the rebuild route refuses unknown articles and unconverted articles', async () => {
  await seedConvertedArticle({articleId: 'rebuild-article-unconverted', conversionStatus: null})

  const missing = await postRebuild('rebuild-article-missing', {})
  const unconverted = await postRebuild('rebuild-article-unconverted', {})

  expect(missing.status).toBe(404)
  expect(unconverted.status).toBe(409)
  expect(await unconverted.text()).toContain(
    'Article rebuild-article-unconverted has no successful full-text conversion',
  )
})

test('a layout file without the layout-v2 envelope asks for a reconversion instead of rebuilding', async () => {
  const blocks = (JSON.parse(readFixture(`${fixtureName}.layout.json`)) as {blocks: unknown[]}).blocks

  await seedConvertedArticle({articleId: 'rebuild-article-old-layout', layoutContent: JSON.stringify(blocks)})

  const response = await postRebuild('rebuild-article-old-layout', {})

  expect(response.status).toBe(409)
  expect(await response.text()).toContain(
    'Article rebuild-article-old-layout layout file assets/full-text-assets/rebuild-article-old-layout/layout.json is not layout-v2; reconvert the article',
  )
  expect((await getCanonicalArticle('rebuild-article-old-layout'))?.fullText).toBe('stale converter markdown')
})

test('converter output with NUL characters stores without them instead of breaking the SQL literal', async () => {
  await getDatabase().run(`INSERT INTO app.article (id, article_title) VALUES ('nul-article', 'nul-article')`)

  const canonical = await getStoreModule().storeConvertedFullText({
    articleId: 'nul-article',
    attempts: 1,
    mutationSource: 'test',
    result: {
      converterKind: 'mineru',
      converterMarkdownPath: 'assets/full-text-assets/nul-article/converter.md',
      converterVersion: '4.0.12',
      figures: [],
      html: '<p>Gender di\u0000erences</p>',
      layout: [{bbox: null, page: 1, text: 'Gender di\u0000erences in psychotropic use.', type: 'text'}],
      layoutPath: 'assets/full-text-assets/nul-article/layout.json',
      markdown: 'Gender di\u0000erences in psychotropic use.',
      optionsHash: 'options-hash',
    },
    runtimeConfig: {
      baseURL: 'http://127.0.0.1:8000',
      modelId: 'mineru-model',
      modelName: 'mineru-standard',
      providerConnectionId: 'mineru-connection',
      providerKind: 'mineru',
    },
  })
  const [row] = await getDatabase().queryJson<{html: string | null; status: string | null; text: string | null}>(`
    SELECT full_text AS text, full_text_html AS html, full_text_conversion_status AS status
    FROM app.article
    WHERE id = 'nul-article'
  `)

  expect(canonical.text).toBe('Gender dierences in psychotropic use.\n')
  expect(row).toEqual({html: '<p>Gender dierences</p>', status: 'success', text: canonical.text})
})

test('DuckDB parser errors while storing converter output are permanent and name the cause; other errors pass through', async () => {
  const {ConversionError} = await import('./converters/conversionError.ts')
  const parserError = await getDatabase()
    .run(`SELECT 'di\u0000erences'`)
    .catch((caught: unknown) => {
      return caught
    })
  const conflictError = new Error('TransactionContext Error: Catalog write-write conflict')
  const storeError = getStoreModule().getConvertedFullTextStoreError(parserError)

  expect(storeError).toBeInstanceOf(ConversionError)
  expect((storeError as InstanceType<typeof ConversionError>).isPermanent).toBe(true)
  expect((storeError as Error).message).toStartWith(
    'Storing the converted full text failed with a DuckDB parser error, which repeats on every attempt: ',
  )
  expect((storeError as Error).message).toContain('unterminated string literal')
  expect(getStoreModule().getConvertedFullTextStoreError(conflictError)).toBe(conflictError)
})
