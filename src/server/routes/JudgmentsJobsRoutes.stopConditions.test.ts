import {afterAll, afterEach, beforeAll, describe, expect, mock, setDefaultTimeout, test} from 'bun:test'
import {Elysia} from 'elysia'

import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('f1-judgments-jobs-stop-conditions')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

const providerRuntimeModelGuardModulePath = new URL('../providers/providerRuntimeModelGuard.ts', import.meta.url).href
const appReadOnlyDatabaseServiceModulePath = new URL('../services/appReadOnlyDatabaseService.ts', import.meta.url).href

type TestDatabase = {queryJson: <T>(statement: string) => Promise<T[]>; run: (statement: string) => Promise<void>}

let app: {handle: (request: Request) => Promise<Response>} | null = null
let database: TestDatabase | null = null
let closeDatabase: (() => Promise<void>) | null = null

const getApp = () => {
  if (!app) {
    throw new Error('Test app not initialized')
  }

  return app
}

const getDatabase = () => {
  if (!database) {
    throw new Error('Test database not initialized')
  }

  return database
}

beforeAll(async () => {
  void mock.module(providerRuntimeModelGuardModulePath, () => {
    return {
      assertStoredProviderModelRuntimeMatch: async () => {
        return undefined
      },
      getStoredProviderModelRuntimeMatch: async () => {
        return {message: null, ok: true, reason: null}
      },
    }
  })
  void mock.module(appReadOnlyDatabaseServiceModulePath, () => {
    const getTestReadOnlyDatabase = () => {
      return {
        queryJson: <T>(statement: string) => {
          return getDatabase().queryJson<T>(statement)
        },
      }
    }

    return {
      closeAppReadOnlyDatabaseServices: async () => {
        return undefined
      },
      getApiReadOnlyAppDatabaseService: getTestReadOnlyDatabase,
      getJudgeWorkerReadOnlyAppDatabaseService: getTestReadOnlyDatabase,
    }
  })

  const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] =
    await Promise.all([
      import('../../db/migrateDuckdb.ts'),
      import('../services/appDatabaseService.ts'),
      import('../utils/duckdbService.ts'),
      import('../utils/serverRuntimeRole.ts'),
    ])
  const {judgmentsJobsRoutes} = (await import(
    `./JudgmentsJobsRoutes.ts?stop-conditions=${Date.now()}`
  )) as typeof import('./JudgmentsJobsRoutes.ts')

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()
  await migrateDuckdb()

  const appDatabase = getAppDatabaseService()

  database = appDatabase
  closeDatabase = () => {
    return appDatabase.close()
  }
  app = new Elysia().use(judgmentsJobsRoutes)
})

afterEach(async () => {
  const [{getJudgmentJobSqliteService}, {resetJudgmentJobJudgedArticleCountCacheForTests}] = await Promise.all([
    import('../cron/judgmentsJobs/judgmentJobSqliteService.ts'),
    import('../cron/judgmentsJobs/judgmentJobAdmittedArticles.ts'),
  ])

  await getJudgmentJobSqliteService().closeAll()
  resetJudgmentJobJudgedArticleCountCacheForTests()
  const {resetJudgmentJobStopConditionDefaultsCacheForTests} =
    await import('../cron/judgmentsJobs/judgmentJobStopConditionDefaults.ts')
  resetJudgmentJobStopConditionDefaultsCacheForTests()
})

afterAll(async () => {
  await closeDatabase?.()
  tempRuntimeRoot.cleanup()
  mock.restore()
})

const createJobFixture = async ({
  prefix,
  status = 'paused',
  storageState = 'active',
}: {
  prefix: string
  status?: string
  storageState?: string
}) => {
  const suffix = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const connectionId = `${suffix}-connection`
  const modelId = `${suffix}-model`
  const projectId = `${suffix}-project`
  const jobId = `${suffix}-job`
  const db = getDatabase()

  await db.run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none')
  `)
  await db.run(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'Qwen/Qwen3.5-122B-A10B', 'Qwen/Qwen3.5-122B-A10B', 'Qwen 122B', 'manual', TRUE)
  `)
  await db.run(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', 'Stop Conditions Project', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await db.run(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state, created_at)
    VALUES ('${jobId}', '${projectId}', '${status}', '${storageState}', current_timestamp - INTERVAL 1 HOUR)
  `)

  return {jobId, modelId, projectId}
}

const patchJob = (jobId: string, body: Record<string, unknown>) => {
  return getApp().handle(
    new Request(`http://localhost/api/judgmentsjobs/${jobId}`, {
      body: JSON.stringify(body),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
}

const getJobDetail = async (jobId: string) => {
  const response = await getApp().handle(new Request(`http://localhost/api/judgmentsjobs/${jobId}`))

  return (await response.json()) as Record<string, unknown> & {totalTokenUsage: {totalTokens: number}}
}

const getStoredJob = async (jobId: string) => {
  const [job] = await getDatabase().queryJson<{status: string; stopReason: string | null; storageState: string}>(`
    SELECT status, storage_state AS storageState, stop_reason AS stopReason
    FROM app.judgment_job
    WHERE id = '${jobId}'
  `)

  return job
}

describe('PATCH stop conditions', () => {
  test.each([
    [{stopAfterArticles: 0}, 'stopAfterArticles must be a positive integer or null'],
    [{stopAfterArticles: 2.5}, 'stopAfterArticles must be a positive integer or null'],
    [{stopAfterArticles: 'many'}, 'stopAfterArticles must be a positive integer or null'],
    [{stopAfterTotalTokens: -5}, 'stopAfterTotalTokens must be a positive integer or null'],
    [{stopAt: '2020-01-01T00:00:00.000Z'}, 'stopAt must be a future ISO date-time or null'],
    [{stopAt: 'later'}, 'stopAt must be a future ISO date-time or null'],
    [{stopWhenHumanAnsweredDone: 'yes'}, 'stopWhenHumanAnsweredDone must be a boolean or null'],
  ])('rejects %p with 400', async (body, message) => {
    const {jobId} = await createJobFixture({prefix: 'invalid'})
    const response = await patchJob(jobId, body)

    expect(response.status).toBe(400)
    expect(await response.text()).toContain(message)
  })

  test('stores, returns and clears conditions without touching the job status', async () => {
    const {jobId} = await createJobFixture({prefix: 'store', status: 'running'})
    const stopAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    const response = await patchJob(jobId, {
      stopAfterArticles: 2000,
      stopAfterTotalTokens: 5_000_000_000,
      stopAt,
      stopWhenHumanAnsweredDone: true,
    })
    const body = (await response.json()) as {data: Record<string, unknown>}

    expect(response.status).toBe(200)
    expect(body.data).toMatchObject({
      status: 'running',
      stopAfterArticles: 2000,
      stopAfterTotalTokens: 5_000_000_000,
      stopAt,
      stopReason: null,
      stopWhenHumanAnsweredDone: true,
      storageState: 'active',
    })
    expect(await getJobDetail(jobId)).toMatchObject({
      admittedArticleCount: 0,
      status: 'running',
      stopAfterArticles: 2000,
      stopAfterTotalTokens: 5_000_000_000,
      stopAt,
      stopReason: null,
      stopReasonAt: null,
      stopWhenHumanAnsweredDone: true,
      totalTokenUsage: {totalTokens: 0},
    })

    const listResponse = await getApp().handle(new Request('http://localhost/api/judgmentsjobs'))
    const list = (await listResponse.json()) as {data: Array<Record<string, unknown>>}

    expect(
      list.data.find((job) => {
        return job.id === jobId
      }),
    ).toMatchObject({
      admittedArticleCount: 0,
      stopAfterArticles: 2000,
      stopAfterTotalTokens: 5_000_000_000,
      stopAt,
      stopReason: null,
      stopWhenHumanAnsweredDone: true,
      totalTokens: 0,
    })

    const clearResponse = await patchJob(jobId, {
      stopAfterArticles: null,
      stopAfterTotalTokens: null,
      stopAt: null,
      stopWhenHumanAnsweredDone: null,
    })

    expect(clearResponse.status).toBe(200)
    expect(await getJobDetail(jobId)).toMatchObject({
      admittedArticleCount: null,
      status: 'running',
      stopAfterArticles: null,
      stopAfterTotalTokens: null,
      stopAt: null,
      stopWhenHumanAnsweredDone: false,
    })
  })
})

describe('resume with stop conditions', () => {
  test('refuses to resume while the deadline has passed, then resumes and clears the stop reason once cleared', async () => {
    const {jobId} = await createJobFixture({prefix: 'resume-deadline'})

    await getDatabase().run(`
      UPDATE app.judgment_job
      SET stop_at = current_timestamp - INTERVAL 1 MINUTE,
          stop_reason = 'deadline',
          stop_reason_at = current_timestamp
      WHERE id = '${jobId}'
    `)

    const refused = await patchJob(jobId, {status: 'running'})

    expect(refused.status).toBe(409)
    expect(await refused.text()).toContain('Raise or clear the deadline stop condition to resume')
    expect(await getStoredJob(jobId)).toEqual({status: 'paused', stopReason: 'deadline', storageState: 'active'})

    const resumed = await patchJob(jobId, {status: 'running', stopAt: null})

    expect(resumed.status).toBe(200)
    expect(await getStoredJob(jobId)).toEqual({status: 'running', stopReason: null, storageState: 'active'})
  })

  test('refuses to resume while the token budget is used up', async () => {
    const {jobId} = await createJobFixture({prefix: 'resume-tokens'})

    await getDatabase().run(`
      INSERT INTO app.token_use (id, judgment_job_id, requests, total_prompt_tokens, total_completion_tokens, total_tokens)
      VALUES ('${jobId}-token', '${jobId}', 1, 70, 30, 100)
    `)

    expect((await patchJob(jobId, {stopAfterTotalTokens: 100})).status).toBe(200)

    const refused = await patchJob(jobId, {status: 'running'})

    expect(refused.status).toBe(409)
    expect(await refused.text()).toContain('Raise or clear the token budget stop condition to resume')

    expect((await patchJob(jobId, {stopAfterTotalTokens: 101})).status).toBe(200)
    expect((await patchJob(jobId, {status: 'running'})).status).toBe(200)
  })

  test('refuses to resume while the job has judged as many articles as the cap', async () => {
    const {jobId, modelId, projectId} = await createJobFixture({prefix: 'resume-cap'})

    await getDatabase().run(`
      INSERT INTO app.article (id, article_id, article_title)
      VALUES
        ('${jobId}-article-1', '${jobId}-article-1-external', 'Article 1'),
        ('${jobId}-article-2', '${jobId}-article-2-external', 'Article 2')
    `)
    await getDatabase().run(`
      INSERT INTO app.prompt (id, original_text)
      VALUES ('${jobId}-prompt-1', 'Prompt 1'), ('${jobId}-prompt-2', 'Prompt 2')
    `)
    await getDatabase().run(`
      INSERT INTO app.judgment (
        id, article_id, prompt_id, model_id, project_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images
      )
      VALUES
        ('${jobId}-judgment-1', '${jobId}-article-1', '${jobId}-prompt-1', '${modelId}', '${projectId}', TRUE, TRUE, FALSE, FALSE),
        ('${jobId}-judgment-2', '${jobId}-article-1', '${jobId}-prompt-2', '${modelId}', '${projectId}', TRUE, TRUE, FALSE, FALSE),
        ('${jobId}-judgment-3', '${jobId}-article-2', '${jobId}-prompt-1', '${modelId}', '${projectId}', TRUE, TRUE, FALSE, FALSE)
    `)

    expect((await patchJob(jobId, {stopAfterArticles: 2})).status).toBe(200)
    expect(await getJobDetail(jobId)).toMatchObject({admittedArticleCount: 2, stopAfterArticles: 2})

    const refused = await patchJob(jobId, {status: 'running'})

    expect(refused.status).toBe(409)
    expect(await refused.text()).toContain('Raise or clear the article cap stop condition to resume')
    expect((await patchJob(jobId, {status: 'running', stopAfterArticles: 3})).status).toBe(200)
  })

  test('the human-answered condition does not block resume', async () => {
    const {jobId} = await createJobFixture({prefix: 'resume-human'})

    await getDatabase().run(`
      UPDATE app.judgment_job
      SET stop_when_human_answered_done = TRUE,
          stop_reason = 'human_answered_done',
          stop_reason_at = current_timestamp
      WHERE id = '${jobId}'
    `)

    expect((await patchJob(jobId, {status: 'running'})).status).toBe(200)
    expect(await getStoredJob(jobId)).toEqual({status: 'running', stopReason: null, storageState: 'active'})
  })

  test('start clean applies the same stop condition guard', async () => {
    const {jobId} = await createJobFixture({prefix: 'start-clean-deadline'})

    await getDatabase().run(`
      UPDATE app.judgment_job SET stop_at = current_timestamp - INTERVAL 1 MINUTE WHERE id = '${jobId}'
    `)

    const refused = await getApp().handle(
      new Request(`http://localhost/api/judgmentsjobs/${jobId}/start-clean`, {method: 'POST'}),
    )

    expect(refused.status).toBe(409)
    expect(await refused.text()).toContain('Raise or clear the deadline stop condition to resume')
  })
})

const insertScopeFixture = async ({
  articleIds,
  jobId,
  projectId,
  promptIds,
}: {
  articleIds: string[]
  jobId: string
  projectId: string
  promptIds: string[]
}) => {
  const db = getDatabase()

  await db.run(`
    INSERT INTO app.article (id, article_id, article_title)
    VALUES ${articleIds
      .map((articleId) => {
        return `('${articleId}', '${articleId}-external', 'Article ${articleId}')`
      })
      .join(', ')}
  `)
  await db.run(`
    INSERT INTO app.prompt (id, original_text)
    VALUES ${promptIds
      .map((promptId) => {
        return `('${promptId}', 'Prompt ${promptId}')`
      })
      .join(', ')}
  `)
  await db.run(`
    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
    VALUES ${promptIds
      .map((promptId, index) => {
        return `('${jobId}-${promptId}-project-prompt', '${projectId}', '${promptId}', ${index}, TRUE)`
      })
      .join(', ')}
  `)
}

const getStopConditionDefaults = async (jobId: string) => {
  const response = await getApp().handle(
    new Request(`http://localhost/api/judgmentsjobs/${jobId}/stop-condition-defaults`),
  )

  return {
    body: (await response.json()) as {
      data: {
        admittedArticleCount: number
        articleCount: number
        humanJudgedArticleCount: number
        serverNow: string
        totalTokens: number
      }
    },
    status: response.status,
  }
}

describe('stop condition defaults', () => {
  test('counts scope articles, human-answered articles, admitted articles and tokens for the menu', async () => {
    const {jobId, modelId, projectId} = await createJobFixture({prefix: 'defaults-prompt', status: 'running'})
    const articleIds = [1, 2, 3, 4, 5].map((index) => {
      return `${jobId}-article-${index}`
    })
    const outOfScopeArticleId = `${jobId}-article-out-of-scope`
    const [article1, article2, article3] = articleIds as [string, string, string]
    const [prompt1, prompt2, prompt3] = [1, 2, 3].map((index) => {
      return `${jobId}-prompt-${index}`
    }) as [string, string, string]

    await insertScopeFixture({
      articleIds: [...articleIds, outOfScopeArticleId],
      jobId,
      projectId,
      promptIds: [prompt1, prompt2, prompt3],
    })
    await getDatabase().run(`
      UPDATE app.project_prompt SET enabled = FALSE WHERE id = '${jobId}-${prompt3}-project-prompt'
    `)
    await getDatabase().run(`
      INSERT INTO app.project_article (id, project_id, article_id)
      VALUES ${articleIds
        .map((articleId) => {
          return `('${articleId}-project-article', '${projectId}', '${articleId}')`
        })
        .join(', ')}
    `)
    await getDatabase().run(`
      INSERT INTO app.judgment_human (id, project_id, article_id, prompt_id, is_answered, answer)
      VALUES
        ('${jobId}-human-1', '${projectId}', '${article1}', '${prompt1}', TRUE, 'yes'),
        ('${jobId}-human-2', '${projectId}', '${article1}', '${prompt2}', TRUE, 'no'),
        ('${jobId}-human-3', '${projectId}', '${article2}', '${prompt3}', TRUE, 'yes'),
        ('${jobId}-human-4', '${projectId}', '${article3}', '${prompt1}', FALSE, NULL),
        ('${jobId}-human-5', '${projectId}', '${outOfScopeArticleId}', '${prompt1}', TRUE, 'yes')
    `)
    await getDatabase().run(`
      INSERT INTO app.judgment (
        id, article_id, prompt_id, model_id, project_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images
      )
      VALUES ('${jobId}-judgment-1', '${article1}', '${prompt1}', '${modelId}', '${projectId}', TRUE, TRUE, FALSE, FALSE)
    `)
    await getDatabase().run(`
      INSERT INTO app.token_use (id, judgment_job_id, requests, total_prompt_tokens, total_completion_tokens, total_tokens)
      VALUES ('${jobId}-token', '${jobId}', 1, 900, 100, 1000)
    `)

    const before = Date.now()
    const {body, status} = await getStopConditionDefaults(jobId)

    expect(status).toBe(200)
    expect(body.data).toMatchObject({
      admittedArticleCount: 1,
      articleCount: 5,
      humanJudgedArticleCount: 1,
      totalTokens: 1000,
    })
    expect(Date.parse(body.data.serverNow)).toBeGreaterThanOrEqual(before - 1000)
  })

  test('uses the review scope mart when it has rows and the summary answers in summary mode', async () => {
    const {jobId, projectId} = await createJobFixture({prefix: 'defaults-summary', status: 'paused'})
    const articleIds = [1, 2, 3].map((index) => {
      return `${jobId}-article-${index}`
    })
    const [article1, article2, article3] = articleIds as [string, string, string]

    await insertScopeFixture({articleIds, jobId, projectId, promptIds: [`${jobId}-prompt-1`]})
    await getDatabase().run(`UPDATE app.project SET human_judgment_mode = 'summary' WHERE id = '${projectId}'`)
    await getDatabase().run(`
      INSERT INTO mart.project_scope_article (
        project_id, article_id, in_curated_scope, in_route_scope, article_created_at, article_updated_at
      )
      VALUES
        ('${projectId}', '${article1}', TRUE, FALSE, current_timestamp, current_timestamp),
        ('${projectId}', '${article2}', FALSE, TRUE, current_timestamp, current_timestamp),
        ('${projectId}', '${article3}', TRUE, TRUE, current_timestamp, current_timestamp)
    `)
    await getDatabase().run(`
      INSERT INTO app.judgment_human_summary (id, project_id, article_id, answer, origin)
      VALUES
        ('${jobId}-summary-1', '${projectId}', '${article1}', 'yes', 'manual_override'),
        ('${jobId}-summary-2', '${projectId}', '${article2}', 'no', 'covidence_import'),
        ('${jobId}-summary-3', '${projectId}', '${article3}', NULL, 'manual_override')
    `)

    const {body, status} = await getStopConditionDefaults(jobId)

    expect(status).toBe(200)
    expect(body.data).toMatchObject({
      admittedArticleCount: 0,
      articleCount: 3,
      humanJudgedArticleCount: 2,
      totalTokens: 0,
    })
  })
})
