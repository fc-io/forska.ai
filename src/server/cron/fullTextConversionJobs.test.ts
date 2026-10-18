import {readFileSync} from 'node:fs'
import {mkdir, readdir, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'
import {strToU8, zipSync} from 'fflate'

import {localUserDefaults} from '../../utils/localUser.ts'
import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('full-text-conversion-jobs')
const originalCwd = process.cwd()
const middleJsonText = readFileSync(
  new URL('../fullText/converters/fixtures/mineruMiddleJson.json', import.meta.url),
  'utf8',
)

process.chdir(tempRuntimeRoot.rootDirectory)
process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

type ConvertedArticleRow = {
  fullText: string | null
  fullTextAssets: string | null
  fullTextCanonicalHash: string | null
  fullTextCanonicalVersion: string | null
  fullTextCharCount: number | string | null
  fullTextFigureModeBuilt: string | null
  fullTextConversionAttempts: number | null
  fullTextConversionMetadata: string | null
  fullTextConversionModelId: string | null
  fullTextConversionStatus: string | null
  fullTextHtml: string | null
}

let database: {
  close: () => Promise<void>
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
} | null = null
let jobsModule: typeof import('./fullTextConversionJobs.ts') | null = null
let ensureFullTextModule: typeof import('../utils/ensureFullText.ts') | null = null
let mineruServer: {stop: (force?: boolean) => void; url: URL} | null = null

const getMineruBaseURL = () => {
  return mineruServer?.url.toString().replace(/\/$/, '') ?? ''
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
  jobsModule = await import('./fullTextConversionJobs.ts')
  ensureFullTextModule = await import('../utils/ensureFullText.ts')
  mineruServer = globalThis.Bun.serve({
    fetch: () => {
      return new Response(
        zipSync({
          'images/page_2_image_10.jpg': new Uint8Array([255, 216, 255, 224, 42]),
          'markdown.md': strToU8('# Converted by MinerU\n\nBody text.\n'),
          'middle_json.json': strToU8(middleJsonText),
        }).slice(),
        {headers: {'content-type': 'application/zip'}},
      )
    },
    port: 0,
  })

  await database.run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('conversion-mineru-connection', 'mineru', 'MinerU', TRUE, 'none', '${getMineruBaseURL()}');

    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES (
      'conversion-mineru-model',
      'conversion-mineru-connection',
      'mineru-standard',
      'mineru-standard',
      'MinerU standard',
      'discovered',
      TRUE
    );

    DELETE FROM app.user_config;

    INSERT INTO app.user_config (id, name, email, role, full_text_conversion_model_id)
    VALUES (
      '${localUserDefaults.id}',
      '${localUserDefaults.name}',
      '${localUserDefaults.email}',
      NULL,
      'conversion-mineru-model'
    );
  `)
})

afterAll(async () => {
  mineruServer?.stop(true)
  await database?.close()
  process.chdir(originalCwd)
  tempRuntimeRoot.cleanup()
})

const seedArticleWithPdf = async (articleId: string) => {
  await mkdir(join(tempRuntimeRoot.rootDirectory, 'assets/article_pdfs'), {recursive: true})
  await writeFile(join(tempRuntimeRoot.rootDirectory, `assets/article_pdfs/${articleId}.pdf`), '%PDF-1.4 test')
  await database?.run(`
    INSERT INTO app.article (id, article_title, full_text_pdf)
    VALUES ('${articleId}', '${articleId}', 'assets/article_pdfs/${articleId}.pdf')
  `)
}

const getConvertedArticle = async (articleId: string): Promise<ConvertedArticleRow | undefined> => {
  const [row] =
    (await database?.queryJson<ConvertedArticleRow>(`
      SELECT
        full_text AS fullText,
        full_text_html AS fullTextHtml,
        CAST(full_text_assets AS VARCHAR) AS fullTextAssets,
        full_text_canonical_hash AS fullTextCanonicalHash,
        full_text_canonical_version AS fullTextCanonicalVersion,
        full_text_char_count AS fullTextCharCount,
        full_text_figure_mode_built AS fullTextFigureModeBuilt,
        full_text_conversion_status AS fullTextConversionStatus,
        full_text_conversion_model_id AS fullTextConversionModelId,
        CAST(full_text_conversion_metadata AS VARCHAR) AS fullTextConversionMetadata,
        full_text_conversion_attempts AS fullTextConversionAttempts
      FROM app.article
      WHERE id = '${articleId}'
    `)) ?? []

  return row
}

const expectedCanonicalTail = [
  'Figure 1: FIGURE 1 PRISMA flow diagram of study selection.',
  '[figure:1]',
  '',
  'TABLE1Characteristicsoftheincludedtrials.',
  '| Study | Country |',
  '| --- | --- |',
  '| Xia 2023 | China |',
  '',
].join('\n')
const expectedCanonicalHash = '2b8108ea6614217063c4a466f432daed11f5aaa1bada596d72e2d27a5de34424'

const expectCanonicalFullText = (text: string | null | undefined) => {
  expect(text?.startsWith('Figure 1 describes the process of literature retrieval and screening.')).toBe(true)
  expect(text?.endsWith(`(Table 1).\n\n${expectedCanonicalTail}`)).toBe(true)
  expect(text).not.toContain('Frontiers in Medicine')
  expect(text).not.toContain('Converted by MinerU')
}

const expectConvertedArticle = async (articleId: string) => {
  const row = await getConvertedArticle(articleId)

  expectCanonicalFullText(row?.fullText)
  expect(row?.fullTextCanonicalHash).toBe(expectedCanonicalHash)
  expect(row?.fullTextCanonicalVersion).toBe('canonical-v1')
  expect(row?.fullTextFigureModeBuilt).toBe('markers')
  expect(Number(row?.fullTextCharCount)).toBe(row?.fullText?.length ?? -1)
  expect(row?.fullTextHtml).toBeNull()
  expect(row?.fullTextConversionStatus).toBe('success')
  expect(row?.fullTextConversionModelId).toBe('conversion-mineru-model')
  expect(row?.fullTextConversionAttempts).toBe(1)
  expect(JSON.parse(row?.fullTextConversionMetadata ?? 'null')).toEqual({
    baseURL: getMineruBaseURL(),
    converterKind: 'mineru',
    converterMarkdownPath: `assets/full-text-assets/${articleId}/converter.md`,
    converterVersion: '4.0.12',
    layoutPath: `assets/full-text-assets/${articleId}/layout.json`,
    layoutVersion: 'layout-v2',
    modelId: 'conversion-mineru-model',
    modelName: 'mineru-standard',
    optionsHash: 'e9d85ef6fe205701cea9cf7f29abcc18f3ba884041b2f392facf5262be7ffb96',
    providerKind: 'mineru',
  })
  expect(JSON.parse(row?.fullTextAssets ?? 'null')).toEqual([
    {
      bbox: [0.082, 0.513, 0.488, 0.915],
      caption: 'FIGURE 1 PRISMA flow diagram of study selection.',
      imagePath: `assets/full-text-assets/${articleId}/fig-1.jpg`,
      index: 1,
      page: 3,
    },
  ])
  expect((await readdir(join(tempRuntimeRoot.rootDirectory, `assets/full-text-assets/${articleId}`))).sort()).toEqual([
    'converter.md',
    'fig-1.jpg',
    'layout.json',
  ])
  expect(
    readFileSync(join(tempRuntimeRoot.rootDirectory, `assets/full-text-assets/${articleId}/converter.md`), 'utf8'),
  ).toBe('# Converted by MinerU\n\nBody text.\n')
}

test('conversion cron stores canonical text, converter markdown file, figure assets and converter identity metadata', async () => {
  if (!jobsModule) {
    throw new Error('Test dependencies not initialized')
  }

  await seedArticleWithPdf('cron-article-1')
  await jobsModule.convertArticle({
    article: {
      fullTextConversionAttempts: null,
      fullTextPDF: 'assets/article_pdfs/cron-article-1.pdf',
      id: 'cron-article-1',
    },
    runtimeConfig: {
      baseURL: getMineruBaseURL(),
      modelId: 'conversion-mineru-model',
      modelName: 'mineru-standard',
      providerKind: 'mineru',
    },
  })

  await expectConvertedArticle('cron-article-1')
})

test('on-demand conversion uses the configured MinerU model and writes the same metadata and assets', async () => {
  if (!ensureFullTextModule || !database) {
    throw new Error('Test dependencies not initialized')
  }

  await seedArticleWithPdf('ensure-article-1')

  const result = await ensureFullTextModule.ensureFullText(
    {
      fullText: null,
      fullTextConversionStatus: null,
      fullTextPDF: 'assets/article_pdfs/ensure-article-1.pdf',
    } as Parameters<typeof ensureFullTextModule.ensureFullText>[0],
    'ensure-article-1',
  )

  expect(result.shouldSkip).toBe(false)
  expectCanonicalFullText(result.text)
  await expectConvertedArticle('ensure-article-1')
})

test('rebuilding from the stored layout.json and assets reproduces the conversion-time canonical bytes', async () => {
  const {rebuildCanonicalFullText} = await import('../fullText/canonicalFullTextStore.ts')
  const result = await rebuildCanonicalFullText({articleId: 'cron-article-1'})

  expect(result).toMatchObject({changed: false, hash: expectedCanonicalHash, version: 'canonical-v1'})
})

test('reconversion keeps cached chunk plans while the canonical hash is unchanged and drops them once it changes', async () => {
  if (!jobsModule || !database) {
    throw new Error('Test dependencies not initialized')
  }

  const reconvert = () => {
    return jobsModule?.convertArticle({
      article: {
        fullTextConversionAttempts: 1,
        fullTextPDF: 'assets/article_pdfs/cron-article-1.pdf',
        id: 'cron-article-1',
      },
      runtimeConfig: {
        baseURL: getMineruBaseURL(),
        modelId: 'conversion-mineru-model',
        modelName: 'mineru-standard',
        providerKind: 'mineru',
      },
    })
  }
  const countPlans = async () => {
    const [row] =
      (await database?.queryJson<{count: number | string}>(
        `SELECT COUNT(*) AS count FROM app.article_full_text_chunk_plan WHERE article_id = 'cron-article-1'`,
      )) ?? []

    return Number(row?.count ?? -1)
  }

  await database.run(`
    INSERT INTO app.article_full_text_chunk_plan (article_id, full_text_strategy_id, plan_hash, text_hash, chunk_count, chunks)
    VALUES ('cron-article-1', 'fts-cached', 'plan', 'text', 1, '[]'::JSON)
  `)
  await reconvert()
  expect(await countPlans()).toBe(1)

  await database.run(`UPDATE app.article SET full_text_canonical_hash = 'older-hash' WHERE id = 'cron-article-1'`)
  await reconvert()
  expect(await countPlans()).toBe(0)
  expect((await getConvertedArticle('cron-article-1'))?.fullTextCanonicalHash).toBe(expectedCanonicalHash)
})

test('a failed conversion records the converter kind and options hash next to the provider and model', async () => {
  if (!jobsModule || !database) {
    throw new Error('Test dependencies not initialized')
  }

  await database.run(`
    INSERT INTO app.article (id, article_title, full_text_pdf)
    VALUES ('cron-missing-pdf', 'cron-missing-pdf', 'assets/article_pdfs/cron-missing-pdf.pdf')
  `)
  await jobsModule.convertArticle({
    article: {
      fullTextConversionAttempts: null,
      fullTextPDF: 'assets/article_pdfs/cron-missing-pdf.pdf',
      id: 'cron-missing-pdf',
    },
    runtimeConfig: {
      baseURL: getMineruBaseURL(),
      modelId: 'conversion-mineru-model',
      modelName: 'mineru-standard',
      providerKind: 'mineru',
    },
  })

  const row = await getConvertedArticle('cron-missing-pdf')

  expect(row?.fullTextConversionStatus).toBe('failed')
  expect(JSON.parse(row?.fullTextConversionMetadata ?? 'null')).toEqual({
    baseURL: getMineruBaseURL(),
    converterKind: 'mineru',
    modelId: 'conversion-mineru-model',
    modelName: 'mineru-standard',
    optionsHash: 'e9d85ef6fe205701cea9cf7f29abcc18f3ba884041b2f392facf5262be7ffb96',
    providerKind: 'mineru',
  })
})

test('a failed on-demand conversion replaces the metadata of an earlier successful run', async () => {
  if (!ensureFullTextModule || !database) {
    throw new Error('Test dependencies not initialized')
  }

  await database.run(`
    INSERT INTO app.article (id, article_title, full_text_pdf, full_text_conversion_model_id, full_text_conversion_metadata)
    VALUES (
      'ensure-missing-pdf',
      'ensure-missing-pdf',
      'assets/article_pdfs/ensure-missing-pdf.pdf',
      'older-model',
      '{"converterKind":"docling","converterVersion":"docling 1.0.0","optionsHash":"older"}'::JSON
    )
  `)

  const result = await ensureFullTextModule.ensureFullText(
    {
      fullText: null,
      fullTextConversionStatus: null,
      fullTextPDF: 'assets/article_pdfs/ensure-missing-pdf.pdf',
    } as Parameters<typeof ensureFullTextModule.ensureFullText>[0],
    'ensure-missing-pdf',
  )
  const row = await getConvertedArticle('ensure-missing-pdf')

  expect(result.shouldSkip).toBe(true)
  expect(row?.fullTextConversionStatus).toBe('failed')
  expect(row?.fullTextConversionModelId).toBe('conversion-mineru-model')
  expect(JSON.parse(row?.fullTextConversionMetadata ?? 'null')).toEqual({
    baseURL: getMineruBaseURL(),
    converterKind: 'mineru',
    modelId: 'conversion-mineru-model',
    modelName: 'mineru-standard',
    optionsHash: 'e9d85ef6fe205701cea9cf7f29abcc18f3ba884041b2f392facf5262be7ffb96',
    providerKind: 'mineru',
  })
})
