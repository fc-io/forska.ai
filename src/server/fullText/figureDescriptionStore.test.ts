import {mkdir, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('figure-description-store')
const originalCwd = process.cwd()

process.chdir(tempRuntimeRoot.rootDirectory)
process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'
process.env.FIGURE_DESCRIPTION_BATCH_SIZE = '50'
process.env.FIGURE_DESCRIPTION_CONCURRENCY = '2'

const modelId = 'vlm-current'
const promptVersion = 'fig-desc-v1'

type DatabaseService = {
  close: () => Promise<void>
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

type StoredAsset = Record<string, unknown> & {index: number}

type ModelRequest = {caption: string; imageUrls: string[]; model: string}

type Dependencies = {
  articleAdminRoutes: {handle: (request: Request) => Promise<Response>}
  database: DatabaseService
  jobs: typeof import('../cron/figureDescriptionJobs.ts')
  store: typeof import('./figureDescriptionStore.ts')
}

const dependencies: {current: Dependencies | null} = {current: null}
const modelRequests: ModelRequest[] = []
const modelServer: {current: ReturnType<typeof globalThis.Bun.serve> | null} = {current: null}

const getDependencies = (): Dependencies => {
  if (!dependencies.current) {
    throw new Error('Test dependencies not initialized')
  }

  return dependencies.current
}

const getChatCompletion = (content: string) => {
  return {
    choices: [{finish_reason: 'stop', index: 0, message: {content, role: 'assistant'}}],
    created: 0,
    id: 'chatcmpl-test',
    model: modelId,
    object: 'chat.completion',
    usage: {completion_tokens: 10, prompt_tokens: 100, total_tokens: 110},
  }
}

const handleModelRequest = async (request: Request): Promise<Response> => {
  return new URL(request.url).pathname.endsWith('/chat/completions')
    ? handleChatCompletion(request)
    : Response.json({data: [{id: modelId, object: 'model'}], object: 'list'})
}

const handleChatCompletion = async (request: Request): Promise<Response> => {
  const body = (await request.json()) as {
    messages: Array<{content: string | Array<{image_url?: {url: string}; text?: string; type: string}>}>
    model: string
  }
  const content = body.messages[1]?.content
  const parts = Array.isArray(content) ? content : []
  const caption = parts.find((part) => {
    return part.type === 'text'
  })?.text
  const imageUrls = parts.flatMap((part) => {
    return part.image_url ? [part.image_url.url] : []
  })

  modelRequests.push({caption: caption ?? '', imageUrls, model: body.model})

  return caption?.includes('FAIL')
    ? new Response(JSON.stringify({error: {message: 'model overloaded'}}), {status: 500})
    : Response.json(getChatCompletion(JSON.stringify({description: `Figure showing ${caption?.split('\n')[0] ?? ''}`})))
}

const seedProject = async ({
  figureMode,
  id,
  archived = false,
}: {
  archived?: boolean
  figureMode: string
  id: string
}) => {
  await getDependencies().database.run(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, full_text_figure_mode, archived)
    VALUES ('${id}', '${id}', 'judge-model', TRUE, TRUE, TRUE, '${figureMode}', ${archived ? 'TRUE' : 'FALSE'})
  `)
}

const writeCrop = async (articleId: string, index: number, bytes: number[]) => {
  const directory = join(tempRuntimeRoot.rootDirectory, 'assets/full-text-assets', articleId)

  await mkdir(directory, {recursive: true})
  await writeFile(join(directory, `fig-${index}.jpg`), new Uint8Array(bytes))
}

const getAsset = (articleId: string, index: number, extra: Record<string, unknown> = {}) => {
  return {
    bbox: [0, 0, 10, 10],
    caption: `Figure ${index} of ${articleId}`,
    imagePath: `assets/full-text-assets/${articleId}/fig-${index}.jpg`,
    index,
    page: 1,
    ...extra,
  }
}

const seedArticle = async ({
  assets,
  conversionStatus = 'success',
  id,
  projectId,
  writeFiles = true,
}: {
  assets: Array<Record<string, unknown>>
  conversionStatus?: string
  id: string
  projectId: string | null
  writeFiles?: boolean
}) => {
  await Promise.all(
    assets.map((asset) => {
      return writeFiles ? writeCrop(id, Number(asset.index), [255, 216, Number(asset.index)]) : Promise.resolve()
    }),
  )
  await getDependencies().database.run(`
    INSERT INTO app.article (
      id, article_title, full_text, full_text_assets, full_text_conversion_status, full_text_canonical_hash
    ) VALUES (
      '${id}', '${id}', 'canonical text', CAST('${JSON.stringify(assets).replaceAll("'", "''")}' AS JSON),
      '${conversionStatus}', 'hash-${id}'
    )
  `)

  if (projectId) {
    await getDependencies().database.run(`
      INSERT INTO app.project_article (id, project_id, article_id) VALUES ('pa-${id}', '${projectId}', '${id}')
    `)
  }
}

const getStoredAssets = async (articleId: string): Promise<StoredAsset[]> => {
  const [row] = await getDependencies().database.queryJson<{assets: string}>(`
    SELECT CAST(full_text_assets AS VARCHAR) AS assets FROM app.article WHERE id = '${articleId}'
  `)

  return JSON.parse(row?.assets ?? '[]') as StoredAsset[]
}

const getDeltaCount = async (articleId: string): Promise<number> => {
  const [row] = await getDependencies().database.queryJson<{count: number | string}>(`
    SELECT COUNT(*) AS count FROM app.review_change_delta WHERE article_id = '${articleId}'
  `)

  return Number(row?.count ?? 0)
}

const getCandidateKeys = async () => {
  const candidates = await getDependencies().store.selectFigureDescriptionCandidates({
    limit: 50,
    target: {modelId, promptVersion},
  })

  return candidates.map((candidate) => {
    return `${candidate.articleId}#${candidate.asset.index}`
  })
}

const waitFor = async (predicate: () => Promise<boolean>, attempts = 100): Promise<boolean> => {
  return (await predicate())
    ? true
    : attempts <= 0
      ? false
      : new Promise((resolve) => {
          setTimeout(() => {
            resolve(waitFor(predicate, attempts - 1))
          }, 50)
        })
}

beforeAll(async () => {
  modelServer.current = globalThis.Bun.serve({fetch: handleModelRequest, port: 0})

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

  dependencies.current = {
    articleAdminRoutes: (await import('../routes/ArticleAdminRoutes.ts')).articleAdminRoutes,
    database: getAppDatabaseService(),
    jobs: await import('../cron/figureDescriptionJobs.ts'),
    store: await import('./figureDescriptionStore.ts'),
  }

  const database = getDependencies().database

  await database.run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('vlm-connection', 'llamacpp', 'Local VLM', TRUE, 'none', 'http://127.0.0.1:${modelServer.current.port}/v1')
  `)
  await database.run(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled, metadata_json)
    VALUES
      ('${modelId}', 'vlm-connection', '${modelId}', '${modelId}', '${modelId}', 'manual', TRUE,
       CAST('{"discovery":{"capabilities":{"supportsImageInput":true}}}' AS JSON)),
      ('judge-model', 'vlm-connection', 'judge-model', 'judge-model', 'judge-model', 'manual', TRUE, NULL)
  `)
  await database.run(`
    INSERT INTO app.user_config (id, name, email, role, figure_description_model_id)
    VALUES ('local-user', 'Local user', 'local@example.com', NULL, '${modelId}')
  `)
  await seedProject({figureMode: 'descriptions', id: 'project-descriptions'})
  await seedProject({figureMode: 'none', id: 'project-none'})
  await seedProject({archived: true, figureMode: 'descriptions', id: 'project-archived'})
  await database.run(`INSERT INTO app.import_route (id, route) VALUES ('route-a', '/api/datasources/import/pubmed')`)
  await database.run(`
    INSERT INTO app.project_import_route (id, project_id, import_route_id)
    VALUES ('pir-a', 'project-descriptions', 'route-a')
  `)

  await seedArticle({
    assets: [getAsset('a-new', 1), getAsset('a-new', 2)],
    id: 'a-new',
    projectId: 'project-descriptions',
  })
  await seedArticle({assets: [getAsset('b-none-project', 1)], id: 'b-none-project', projectId: 'project-none'})
  await seedArticle({
    assets: [
      getAsset('c-current', 1, {
        describedAt: '2026-10-17T00:00:00.000Z',
        description: 'Already described.',
        descriptionModelId: modelId,
        descriptionPromptVersion: promptVersion,
      }),
    ],
    id: 'c-current',
    projectId: null,
  })
  await database.run(`
    INSERT INTO app.article_import_route (id, article_id, import_route_id) VALUES ('air-c', 'c-current', 'route-a')
  `)
  await seedArticle({
    assets: [
      getAsset('d-stale-model', 1, {
        description: 'Old model text.',
        descriptionModelId: 'vlm-old',
        descriptionPromptVersion: promptVersion,
      }),
      getAsset('d-stale-model', 2, {
        description: 'Old prompt text.',
        descriptionModelId: modelId,
        descriptionPromptVersion: 'fig-desc-v0',
      }),
    ],
    id: 'd-stale-model',
    projectId: null,
  })
  await database.run(`
    INSERT INTO app.article_import_route (id, article_id, import_route_id) VALUES ('air-d', 'd-stale-model', 'route-a')
  `)
  await seedArticle({assets: [getAsset('e-archived', 1)], id: 'e-archived', projectId: 'project-archived'})
  await seedArticle({
    assets: [getAsset('f-failed-conversion', 1)],
    conversionStatus: 'failed',
    id: 'f-failed-conversion',
    projectId: 'project-descriptions',
  })
  await seedArticle({
    assets: [getAsset('g-flaky', 1, {caption: 'FAIL always'}), getAsset('g-flaky', 2)],
    id: 'g-flaky',
    projectId: 'project-descriptions',
  })
  await seedArticle({
    assets: [getAsset('h-missing-crop', 1)],
    id: 'h-missing-crop',
    projectId: 'project-descriptions',
    writeFiles: false,
  })
})

afterAll(async () => {
  await dependencies.current?.database.close()
  await modelServer.current?.stop(true)
  process.chdir(originalCwd)
  tempRuntimeRoot.cleanup()
})

test('selects figures of converted articles in active Descriptions projects that lack a current description', async () => {
  expect(await getCandidateKeys()).toEqual([
    'a-new#1',
    'a-new#2',
    'd-stale-model#1',
    'd-stale-model#2',
    'g-flaky#1',
    'g-flaky#2',
    'h-missing-crop#1',
  ])
})

test('the batch describes each figure once, writes the asset fields and appends a fullText delta', async () => {
  const deltasBefore = await getDeltaCount('a-new')
  const result = await getDependencies().jobs.runFigureDescriptionBatch()
  const assets = await getStoredAssets('a-new')
  const staleAssets = await getStoredAssets('d-stale-model')

  expect(result).toEqual({candidates: 7, outcomes: {described: 5, failed: 1, retry: 1}})
  expect(assets[0]).toMatchObject({
    bbox: [0, 0, 10, 10],
    caption: 'Figure 1 of a-new',
    description: 'Figure showing Caption: Figure 1 of a-new',
    descriptionModelId: modelId,
    descriptionPromptVersion: promptVersion,
    imagePath: 'assets/full-text-assets/a-new/fig-1.jpg',
    index: 1,
    page: 1,
  })
  expect(typeof assets[0]?.describedAt).toBe('string')
  expect(assets[1]?.description).toBe('Figure showing Caption: Figure 2 of a-new')
  expect(
    staleAssets.map((asset) => {
      return [asset.descriptionModelId, asset.descriptionPromptVersion]
    }),
  ).toEqual([
    [modelId, promptVersion],
    [modelId, promptVersion],
  ])
  expect(await getDeltaCount('a-new')).toBeGreaterThan(deltasBefore)
  expect(
    modelRequests.find((request) => {
      return request.caption.startsWith('Caption: Figure 1 of a-new')
    }),
  ).toEqual({
    caption: 'Caption: Figure 1 of a-new\n\nDescribe the attached figure.',
    imageUrls: ['data:image/jpeg;base64,/9gB'],
    model: modelId,
  })
})

test('failures are recorded per figure, retried up to three attempts, and never block the other figures', async () => {
  const missingCrop = (await getStoredAssets('h-missing-crop'))[0]
  const firstAttempt = await getStoredAssets('g-flaky')

  expect(missingCrop).toMatchObject({descriptionAttemptModelId: modelId, descriptionAttempts: 3})
  expect(String(missingCrop?.descriptionError)).toContain('ENOENT')
  expect(firstAttempt[0]).toMatchObject({descriptionAttempts: 1, descriptionAttemptPromptVersion: promptVersion})
  expect(String(firstAttempt[0]?.descriptionError)).toContain('500')
  expect(firstAttempt[1]?.description).toBe('Figure showing Caption: Figure 2 of g-flaky')

  await getDependencies().jobs.runFigureDescriptionBatch()
  const third = await getDependencies().jobs.runFigureDescriptionBatch()
  const flaky = await getStoredAssets('g-flaky')

  expect(third).toEqual({candidates: 1, outcomes: {failed: 1}})
  expect(flaky[0]).toMatchObject({descriptionAttempts: 3})
  expect(flaky[0]?.description).toBeUndefined()
  expect(await getCandidateKeys()).toEqual([])
  expect(await getDependencies().jobs.runFigureDescriptionBatch()).toEqual({candidates: 0, outcomes: {}})
})

test('a new model or prompt version re-describes, and failures under the old setting do not count', async () => {
  await getDependencies().database.run(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled, metadata_json)
    VALUES ('vlm-next', 'vlm-connection', 'vlm-next', 'vlm-next', 'vlm-next', 'manual', TRUE,
      CAST('{"discovery":{"capabilities":{"supportsImageInput":true}}}' AS JSON))
  `)

  const nextTarget = {modelId: 'vlm-next', promptVersion}
  const candidates = await getDependencies().store.selectFigureDescriptionCandidates({limit: 50, target: nextTarget})

  expect(
    candidates.map((candidate) => {
      return `${candidate.articleId}#${candidate.asset.index}`
    }),
  ).toEqual([
    'a-new#1',
    'a-new#2',
    'c-current#1',
    'd-stale-model#1',
    'd-stale-model#2',
    'g-flaky#1',
    'g-flaky#2',
    'h-missing-crop#1',
  ])
})

test('a write against a reconverted article is dropped as stale', async () => {
  const [candidate] = (
    await getDependencies().store.selectFigureDescriptionCandidates({
      limit: 50,
      target: {modelId, promptVersion: 'fig-desc-v2'},
    })
  ).filter((entry) => {
    return entry.articleId === 'a-new'
  })

  if (!candidate) {
    throw new Error('Expected an a-new candidate')
  }

  const outcome = await getDependencies().store.describeFigureCandidate({
    candidate: {...candidate, canonicalHash: 'hash-before-reconversion'},
    target: {modelId, promptVersion: 'fig-desc-v2'},
  })

  expect(outcome).toBe('stale')
  expect((await getStoredAssets('a-new'))[0]?.descriptionPromptVersion).toBe(promptVersion)
})

test('ensureFigureDescriptions describes what is missing and reports pending and failed counts', async () => {
  await seedArticle({
    assets: [getAsset('i-on-demand', 1), getAsset('i-on-demand', 2, {caption: 'FAIL on demand'})],
    id: 'i-on-demand',
    projectId: null,
  })

  const first = await getDependencies().store.ensureFigureDescriptions('i-on-demand')
  const second = await getDependencies().store.ensureFigureDescriptions('i-on-demand')
  const third = await getDependencies().store.ensureFigureDescriptions('i-on-demand')
  const done = await getDependencies().store.ensureFigureDescriptions('a-new')
  const unconverted = await getDependencies().store.ensureFigureDescriptions('f-failed-conversion')

  expect(first).toEqual({articleId: 'i-on-demand', described: 1, failed: 0, missing: 2, pending: 1, total: 2})
  expect(second).toEqual({articleId: 'i-on-demand', described: 1, failed: 0, missing: 1, pending: 1, total: 2})
  expect(third).toEqual({articleId: 'i-on-demand', described: 1, failed: 1, missing: 1, pending: 0, total: 2})
  expect(done).toEqual({articleId: 'a-new', described: 2, failed: 0, missing: 0, pending: 0, total: 2})
  expect(unconverted).toEqual({
    articleId: 'f-failed-conversion',
    described: 0,
    failed: 0,
    missing: 0,
    pending: 0,
    total: 0,
  })
})

test('POST /api/articles/:id/figure-descriptions/rebuild clears and re-describes one article', async () => {
  const requestsBefore = modelRequests.length
  const response = await getDependencies().articleAdminRoutes.handle(
    new Request('http://localhost/api/articles/a-new/figure-descriptions/rebuild', {method: 'POST'}),
  )
  const missing = await getDependencies().articleAdminRoutes.handle(
    new Request('http://localhost/api/articles/missing-article/figure-descriptions/rebuild', {method: 'POST'}),
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({articleId: 'a-new', figures: 2, status: 'started'})
  expect(missing.status).toBe(404)
  expect(
    await waitFor(async () => {
      const assets = await getStoredAssets('a-new')

      return assets.every((asset) => {
        return asset.descriptionModelId === modelId && typeof asset.description === 'string'
      })
    }),
  ).toBe(true)
  expect(modelRequests.length - requestsBefore).toBe(2)
})

test('ensureFigureDescriptions refuses to run without a figure-description model', async () => {
  await getDependencies().database.run('UPDATE app.user_config SET figure_description_model_id = NULL')

  const error = await getDependencies()
    .store.ensureFigureDescriptions('a-new')
    .then(
      () => {
        return null
      },
      (caught: unknown) => {
        return caught instanceof Error ? caught.message : String(caught)
      },
    )

  expect(error).toBe('No figure-description model is configured. Set it in Settings.')
  expect(await getDependencies().jobs.runFigureDescriptionBatch()).toEqual({candidates: 0, outcomes: {}})
})
