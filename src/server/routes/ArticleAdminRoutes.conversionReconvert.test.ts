import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'
import {Elysia} from 'elysia'

import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('article-admin-conversion-reconvert')
const originalCwd = process.cwd()

process.chdir(tempRuntimeRoot.rootDirectory)
process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

type ArticleConversionRow = {
  fullText: string | null
  fullTextAssets: string | null
  fullTextCanonicalHash: string | null
  fullTextCanonicalVersion: string | null
  fullTextCharCount: number | null
  fullTextConversionAttempts: number | null
  fullTextConversionError: string | null
  fullTextConversionMetadata: string | null
  fullTextConversionModelId: string | null
  fullTextConversionStatus: string | null
  fullTextFigureModeBuilt: string | null
  fullTextHtml: string | null
  fullTextPDF: string | null
}

let app: {handle: (request: Request) => Promise<Response>} | null = null
let database: {
  close: () => Promise<void>
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
} | null = null

beforeAll(async () => {
  const [
    {migrateDuckdb},
    {getAppDatabaseService},
    {resetDuckdbServiceForTests},
    {resetServerRuntimeRoleForTests},
    {articleAdminRoutes},
    {articlesRoutes},
  ] = await Promise.all([
    import('../../db/migrateDuckdb.ts'),
    import('../services/appDatabaseService.ts'),
    import('../utils/duckdbService.ts'),
    import('../utils/serverRuntimeRole.ts'),
    import('./ArticleAdminRoutes.ts'),
    import('./ArticlesRoutes.ts'),
  ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()
  await migrateDuckdb()

  database = getAppDatabaseService()
  app = new Elysia().use(articleAdminRoutes).use(articlesRoutes)
})

afterAll(async () => {
  await database?.close()
  process.chdir(originalCwd)
  tempRuntimeRoot.cleanup()
})

const getDatabase = () => {
  if (!database) {
    throw new Error('Database not initialized')
  }

  return database
}

const getApp = () => {
  if (!app) {
    throw new Error('App not initialized')
  }

  return app
}

const cronFailureMetadata = {
  baseURL: 'http://127.0.0.1:8000',
  modelId: 'conversion-model',
  modelName: 'MinerU 4',
  providerKind: 'mineru',
}

const successMetadata = {
  ...cronFailureMetadata,
  converterKind: 'mineru',
  converterMarkdownPath: 'assets/full-text-assets/article/converter.md',
  converterVersion: '4.0.1',
  layoutPath: 'assets/full-text-assets/article/layout-v2.json',
  layoutVersion: 'layout-v2',
  optionsHash: 'options-hash-1',
}

const seedArticle = async (input: {
  attempts?: number
  canonicalVersion?: string | null
  error?: string | null
  fullText?: string | null
  fullTextPDF?: string | null
  id: string
  metadata?: Record<string, unknown> | null
  status: string | null
}) => {
  const metadataSql = input.metadata ? `'${JSON.stringify(input.metadata)}'::JSON` : 'NULL'
  const fullTextSql = input.fullText ? `'${input.fullText}'` : 'NULL'
  const canonicalVersionSql = input.canonicalVersion ? `'${input.canonicalVersion}'` : 'NULL'
  const pdfSql = input.fullTextPDF === undefined ? `'assets/article_pdfs/${input.id}.pdf'` : 'NULL'
  const hasText = input.fullText ? 'TRUE' : 'FALSE'
  const error =
    input.error === undefined ? (input.status === 'failed' ? 'MinerU returned HTTP 500' : null) : input.error
  const errorSql = error === null ? 'NULL' : `'${error}'`

  await getDatabase().run(`
    INSERT INTO app.article (
      id,
      article_title,
      full_text_pdf,
      full_text,
      full_text_html,
      full_text_assets,
      full_text_canonical_hash,
      full_text_canonical_version,
      full_text_figure_mode_built,
      full_text_char_count,
      full_text_conversion_status,
      full_text_conversion_error,
      full_text_conversion_attempts,
      full_text_conversion_model_id,
      full_text_conversion_metadata,
      updated_at
    ) VALUES (
      '${input.id}',
      '${input.id} title',
      ${pdfSql},
      ${fullTextSql},
      CASE WHEN ${hasText} THEN '<p>${input.id}</p>' ELSE NULL END,
      CASE WHEN ${hasText} THEN '[]'::JSON ELSE NULL END,
      CASE WHEN ${hasText} THEN 'canonical-hash' ELSE NULL END,
      ${canonicalVersionSql},
      CASE WHEN ${hasText} THEN 'native_images' ELSE NULL END,
      CASE WHEN ${hasText} THEN 42 ELSE NULL END,
      ${input.status ? `'${input.status}'` : 'NULL'},
      ${errorSql},
      ${input.attempts ?? (input.status === 'failed' ? 3 : 0)},
      ${input.metadata ? `'conversion-model'` : 'NULL'},
      ${metadataSql},
      TIMESTAMPTZ '2026-10-17 10:00:00+00'
    )
  `)
}

const getArticleConversionRow = async (id: string) => {
  const [row] = await getDatabase().queryJson<ArticleConversionRow>(`
    SELECT
      full_text AS fullText,
      CAST(full_text_assets AS VARCHAR) AS fullTextAssets,
      full_text_canonical_hash AS fullTextCanonicalHash,
      full_text_canonical_version AS fullTextCanonicalVersion,
      full_text_char_count AS fullTextCharCount,
      full_text_conversion_attempts AS fullTextConversionAttempts,
      full_text_conversion_error AS fullTextConversionError,
      CAST(full_text_conversion_metadata AS VARCHAR) AS fullTextConversionMetadata,
      full_text_conversion_model_id AS fullTextConversionModelId,
      full_text_conversion_status AS fullTextConversionStatus,
      full_text_figure_mode_built AS fullTextFigureModeBuilt,
      full_text_html AS fullTextHtml,
      full_text_pdf AS fullTextPDF
    FROM app.article
    WHERE id = '${id}'
  `)

  return row
}

const getReviewDeltaCount = async (articleId: string) => {
  const [row] = await getDatabase().queryJson<{count: number | string}>(`
    SELECT COUNT(*) AS count
    FROM app.review_change_delta
    WHERE article_id = '${articleId}'
  `)

  return Number(row?.count ?? 0)
}

const postReconvert = async (body: unknown) => {
  const response = await getApp().handle(
    new Request('http://localhost/api/articles/conversion-reconvert', {
      body: JSON.stringify(body),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )

  const text = await response.text()

  return {body: response.status === 200 ? (JSON.parse(text) as unknown) : text, status: response.status}
}

test('conversion stats list the converter kind, version, options hash and canonical version a failed row carries', async () => {
  await seedArticle({id: 'stats-cron-failure', metadata: cronFailureMetadata, status: 'failed'})
  await seedArticle({
    canonicalVersion: 'canonical-v1',
    fullText: 'old text',
    id: 'stats-prior-success',
    metadata: successMetadata,
    status: 'failed',
  })
  await seedArticle({id: 'stats-no-metadata', metadata: null, status: 'failed'})

  const response = await getApp().handle(new Request('http://localhost/api/articles/conversion-stats'))
  const body = (await response.json()) as {lastFailed: Array<Record<string, unknown>>; totalFailed: number}
  const rowsById = new Map(
    body.lastFailed.map((row) => {
      return [row.id, row]
    }),
  )

  expect(response.status).toBe(200)
  expect(rowsById.get('stats-cron-failure')).toMatchObject({
    canonicalVersion: null,
    converterKind: null,
    converterVersion: null,
    modelName: 'MinerU 4',
    optionsHash: null,
    providerKind: 'mineru',
  })
  expect(rowsById.get('stats-prior-success')).toMatchObject({
    canonicalVersion: 'canonical-v1',
    converterKind: 'mineru',
    converterVersion: '4.0.1',
    modelName: 'MinerU 4',
    optionsHash: 'options-hash-1',
    providerKind: 'mineru',
  })
  expect(rowsById.get('stats-no-metadata')).toMatchObject({
    canonicalVersion: null,
    converterKind: null,
    converterVersion: null,
    modelName: null,
    optionsHash: null,
    providerKind: null,
  })
})

test('reconvert clears the failed state and converted text of a failed row and keeps its PDF', async () => {
  await seedArticle({
    canonicalVersion: 'canonical-v1',
    fullText: 'old text',
    id: 'reconvert-with-text',
    metadata: successMetadata,
    status: 'failed',
  })

  const result = await postReconvert({articleId: 'reconvert-with-text'})

  expect(result).toEqual({
    body: {articleId: 'reconvert-with-text', clearedConvertedText: true, success: true},
    status: 200,
  })
  expect(await getArticleConversionRow('reconvert-with-text')).toEqual({
    fullText: null,
    fullTextAssets: null,
    fullTextCanonicalHash: null,
    fullTextCanonicalVersion: null,
    fullTextCharCount: null,
    fullTextConversionAttempts: 0,
    fullTextConversionError: null,
    fullTextConversionMetadata: null,
    fullTextConversionModelId: null,
    fullTextConversionStatus: null,
    fullTextFigureModeBuilt: null,
    fullTextHtml: null,
    fullTextPDF: 'assets/article_pdfs/reconvert-with-text.pdf',
  })
  expect(await getReviewDeltaCount('reconvert-with-text')).toBeGreaterThan(0)
})

test('reconvert of a failed row without converted text appends no review serving delta', async () => {
  await seedArticle({id: 'reconvert-cron-failure', metadata: cronFailureMetadata, status: 'failed'})

  const result = await postReconvert({articleId: 'reconvert-cron-failure'})
  const row = await getArticleConversionRow('reconvert-cron-failure')

  expect(result).toEqual({
    body: {articleId: 'reconvert-cron-failure', clearedConvertedText: false, success: true},
    status: 200,
  })
  expect(row).toMatchObject({
    fullText: null,
    fullTextConversionAttempts: 0,
    fullTextConversionError: null,
    fullTextConversionStatus: null,
    fullTextPDF: 'assets/article_pdfs/reconvert-cron-failure.pdf',
  })
  expect(await getReviewDeltaCount('reconvert-cron-failure')).toBe(0)
})

test('reconvert answers 404 for an unknown article', async () => {
  expect(await postReconvert({articleId: 'reconvert-missing'})).toEqual({
    body: 'Article reconvert-missing not found',
    status: 404,
  })
})

test('reconvert answers 409 for a failed row without a PDF and leaves it failed', async () => {
  await seedArticle({fullTextPDF: null, id: 'reconvert-no-pdf', metadata: cronFailureMetadata, status: 'failed'})

  const result = await postReconvert({articleId: 'reconvert-no-pdf'})

  expect(result).toEqual({
    body: 'Article reconvert-no-pdf has no PDF; fetch or upload one before reconverting',
    status: 409,
  })
  expect(await getArticleConversionRow('reconvert-no-pdf')).toMatchObject({
    fullTextConversionAttempts: 3,
    fullTextConversionError: 'MinerU returned HTTP 500',
    fullTextConversionStatus: 'failed',
  })
})

test('reconvert recovers a conversion failure stored before failed was a status (NULL status, error, no text)', async () => {
  await seedArticle({
    attempts: 1,
    error: 'Storing the converted full text failed',
    id: 'reconvert-pre-status',
    status: null,
  })

  expect(await postReconvert({articleId: 'reconvert-pre-status'})).toEqual({
    body: {articleId: 'reconvert-pre-status', clearedConvertedText: false, success: true},
    status: 200,
  })
  expect(await getArticleConversionRow('reconvert-pre-status')).toMatchObject({
    fullText: null,
    fullTextConversionAttempts: 0,
    fullTextConversionError: null,
    fullTextConversionStatus: null,
    fullTextPDF: 'assets/article_pdfs/reconvert-pre-status.pdf',
  })
})

test('reconvert accepts an article with a PDF and no full text, and one whose text carries a recorded error', async () => {
  await seedArticle({id: 'reconvert-no-text', status: null})
  await seedArticle({
    canonicalVersion: 'canonical-v1',
    error: 'Figure crop 3 could not be written',
    fullText: 'converted text',
    id: 'reconvert-text-with-error',
    metadata: successMetadata,
    status: 'success',
  })

  expect(await postReconvert({articleId: 'reconvert-no-text'})).toMatchObject({status: 200})
  expect(await postReconvert({articleId: 'reconvert-text-with-error'})).toEqual({
    body: {articleId: 'reconvert-text-with-error', clearedConvertedText: true, success: true},
    status: 200,
  })
  expect(await getArticleConversionRow('reconvert-text-with-error')).toMatchObject({
    fullText: null,
    fullTextConversionError: null,
    fullTextConversionStatus: null,
  })
})

test.each([
  ['success', 'reconvert-success', 'success'],
  ['pending', 'reconvert-pending-with-text', 'pending'],
  [null, 'reconvert-null-with-text', 'not started'],
])(
  'reconvert answers 409 for converted text with a %p conversion and no error, and leaves the row untouched',
  async (status, id, label) => {
    await seedArticle({
      canonicalVersion: 'canonical-v1',
      fullText: 'converted text',
      id,
      metadata: successMetadata,
      status,
    })
    const before = await getArticleConversionRow(id)

    const result = await postReconvert({articleId: id})

    expect(result).toEqual({
      body: `Article ${id} has converted full text (conversion ${label}) and no recorded conversion error; only articles without full text, with a failed conversion or with a recorded conversion error can be reconverted`,
      status: 409,
    })
    expect(await getArticleConversionRow(id)).toEqual(before)
  },
)

test.each([
  [{}, 'must be a string (was missing)'],
  [{articleId: ''}, 'must be non-empty'],
  [{articleId: 7}, 'must be a string (was a number)'],
])('reconvert rejects the body %p with 422', async (body, summary) => {
  expect(await postReconvert(body)).toEqual({body: expect.stringContaining(summary), status: 422})
})
