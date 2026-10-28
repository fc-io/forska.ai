import {afterAll, afterEach, beforeAll, describe, expect, mock, setDefaultTimeout, test} from 'bun:test'

import type {JudgmentJobStopConditions} from '../../../utils/judgmentJobStopConditions.ts'
import {createTempRuntimeRoot} from '../../test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('f1-judgment-job-stop-conditions')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.RUN_SERVER_JUDGING = 'false'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

const appReadOnlyDatabaseServiceModulePath = new URL('../../services/appReadOnlyDatabaseService.ts', import.meta.url)
  .href

type RefillModule = typeof import('./judgmentJobStopConditionRefill.ts')
type AdmittedArticlesModule = typeof import('./judgmentJobAdmittedArticles.ts')
type SqliteService = ReturnType<typeof import('./judgmentJobSqliteService.ts').getJudgmentJobSqliteService>

let database: {queryJson: <T>(statement: string) => Promise<T[]>; run: (statement: string) => Promise<void>} | null =
  null
let closeDatabase: (() => Promise<void>) | null = null
let refill: RefillModule | null = null
let admittedArticles: AdmittedArticlesModule | null = null
let sqliteService: SqliteService | null = null

const noConditions: JudgmentJobStopConditions = {
  stopAfterArticles: null,
  stopAfterTotalTokens: null,
  stopAt: null,
  stopWhenHumanAnsweredDone: false,
}

const getDatabase = () => {
  if (!database) {
    throw new Error('Database not initialized')
  }

  return database
}

const getRefill = () => {
  if (!refill) {
    throw new Error('Refill module not initialized')
  }

  return refill
}

const getAdmittedArticles = () => {
  if (!admittedArticles) {
    throw new Error('Admitted articles module not initialized')
  }

  return admittedArticles
}

const getSqliteService = () => {
  if (!sqliteService) {
    throw new Error('SQLite service not initialized')
  }

  return sqliteService
}

beforeAll(async () => {
  void mock.module(appReadOnlyDatabaseServiceModulePath, () => {
    const getTestReadOnlyDatabase = () => {
      return {
        close: async () => {
          return undefined
        },
        queryJson: <T>(statement: string) => {
          return getDatabase().queryJson<T>(statement)
        },
        queryJsonOwnerMain: <T>(statement: string) => {
          return getDatabase().queryJson<T>(statement)
        },
        validate: async () => {
          return undefined
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

  const [
    {migrateDuckdb},
    {getAppDatabaseService},
    {resetDuckdbServiceForTests},
    {resetServerRuntimeRoleForTests},
    sqliteModule,
  ] = await Promise.all([
    import('../../../db/migrateDuckdb.ts'),
    import('../../services/appDatabaseService.ts'),
    import('../../utils/duckdbService.ts'),
    import('../../utils/serverRuntimeRole.ts'),
    import('./judgmentJobSqliteService.ts'),
  ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()
  await migrateDuckdb()

  const appDatabase = getAppDatabaseService()

  database = appDatabase
  closeDatabase = () => {
    return appDatabase.close()
  }
  sqliteService = sqliteModule.getJudgmentJobSqliteService()
  refill = await import('./judgmentJobStopConditionRefill.ts')
  admittedArticles = await import('./judgmentJobAdmittedArticles.ts')
})

afterEach(() => {
  refill?.resetJudgmentJobStopConditionStateForTests()
  admittedArticles?.resetJudgmentJobJudgedArticleCountCacheForTests()
})

afterAll(async () => {
  await sqliteService?.closeAll()
  await closeDatabase?.()
  tempRuntimeRoot.cleanup()
  mock.restore()
})

type StopJobFixture = {
  articleIds: string[]
  jobId: string
  modelId: string
  otherModelId: string
  projectId: string
  promptIds: string[]
}

const createStopJobFixture = async (prefix: string, articleCount = 3, promptCount = 2): Promise<StopJobFixture> => {
  const suffix = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const connectionId = `${suffix}-connection`
  const modelId = `${suffix}-model`
  const otherModelId = `${suffix}-other-model`
  const projectId = `${suffix}-project`
  const jobId = `${suffix}-job`
  const articleIds = Array.from({length: articleCount}, (_value, index) => {
    return `${suffix}-article-${index + 1}`
  })
  const promptIds = Array.from({length: promptCount}, (_value, index) => {
    return `${suffix}-prompt-${index + 1}`
  })
  const db = getDatabase()

  await db.run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
  `)
  await db.run(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES
      ('${modelId}', '${connectionId}', 'Stop model', 'stop-model', 'Stop model', 'manual', TRUE),
      ('${otherModelId}', '${connectionId}', 'Other model', 'other-model', 'Other model', 'manual', TRUE)
  `)
  await db.run(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', 'Stop project', '${modelId}', TRUE, TRUE, FALSE, FALSE)
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
        return `('${promptId}-project-prompt', '${projectId}', '${promptId}', ${index}, TRUE)`
      })
      .join(', ')}
  `)
  await db.run(`
    INSERT INTO app.article (id, article_id, article_title)
    VALUES ${articleIds
      .map((articleId) => {
        return `('${articleId}', '${articleId}-external', 'Article ${articleId}')`
      })
      .join(', ')}
  `)
  await db.run(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES ${articleIds
      .map((articleId) => {
        return `('${articleId}-project-article', '${projectId}', '${articleId}')`
      })
      .join(', ')}
  `)
  await db.run(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state, created_at)
    VALUES ('${jobId}', '${projectId}', 'running', 'active', current_timestamp - INTERVAL 1 HOUR)
  `)
  await getSqliteService().initializeJob(jobId)

  return {articleIds, jobId, modelId, otherModelId, projectId, promptIds}
}

const insertJudgment = async ({
  articleId,
  createdAtSql = 'current_timestamp',
  deleted = false,
  fixture,
  modelId = fixture.modelId,
  promptId,
}: {
  articleId: string
  createdAtSql?: string
  deleted?: boolean
  fixture: StopJobFixture
  modelId?: string
  promptId: string
}) => {
  await getDatabase().run(`
    INSERT INTO app.judgment (
      id, article_id, prompt_id, model_id, project_id, use_title, use_abstract, use_fulltext,
      use_fulltext_no_images, use_metadata, system_prompt_variant, is_answered, created_at, deleted_at,
      delete_generation
    )
    VALUES (
      '${articleId}-${promptId}-${modelId}-${deleted ? 'deleted' : 'live'}', '${articleId}', '${promptId}', '${modelId}',
      '${fixture.projectId}', TRUE, TRUE, FALSE, FALSE, FALSE, 'legacy', TRUE, ${createdAtSql},
      ${deleted ? 'current_timestamp' : 'NULL'}, ${deleted ? 1 : 0}
    )
  `)
}

const getJobStopState = async (jobId: string) => {
  const [row] = await getDatabase().queryJson<{
    status: string
    stopReason: string | null
    stopReasonAt: unknown
    storageState: string
  }>(`
    SELECT status, storage_state AS storageState, stop_reason AS stopReason, stop_reason_at AS stopReasonAt
    FROM app.judgment_job
    WHERE id = '${jobId}'
  `)

  return row
}

const getPlan = (fixture: StopJobFixture, conditions: JudgmentJobStopConditions, now = new Date()) => {
  return getRefill().getJudgmentJobStopPlan({
    conditions,
    job: {id: fixture.jobId, projectId: fixture.projectId},
    now,
    serverJobId: 'server-stop',
    sqliteService: getSqliteService(),
  })
}

const clearReadyQueue = async (jobId: string) => {
  await getSqliteService().clearActiveQueue(jobId)
}

describe('stop condition evaluation', () => {
  const now = new Date('2026-10-11T12:00:00.000Z')

  test('reports each satisfied condition in priority order', () => {
    const {getSatisfiedStopReasons} = getRefill()

    expect(
      getSatisfiedStopReasons({
        admittedArticleCount: 2,
        conditions: {stopAfterArticles: 2, stopAfterTotalTokens: 10, stopAt: now, stopWhenHumanAnsweredDone: true},
        humanAnsweredDone: true,
        now,
        totalTokens: 10,
      }),
    ).toEqual(['deadline', 'token_budget', 'article_cap', 'human_answered_done'])
    expect(
      getSatisfiedStopReasons({
        admittedArticleCount: 1,
        conditions: {
          stopAfterArticles: 2,
          stopAfterTotalTokens: 11,
          stopAt: new Date(now.getTime() + 1),
          stopWhenHumanAnsweredDone: true,
        },
        humanAnsweredDone: false,
        now,
        totalTokens: 10,
      }),
    ).toEqual([])
    expect(
      getSatisfiedStopReasons({
        admittedArticleCount: null,
        conditions: noConditions,
        humanAnsweredDone: true,
        now,
        totalTokens: null,
      }),
    ).toEqual([])
  })

  test('keeps the first satisfied reason until it stops being satisfied', () => {
    const {pickFirstSatisfiedStopReason} = getRefill()

    expect(pickFirstSatisfiedStopReason(null, ['token_budget', 'article_cap'])).toBe('token_budget')
    expect(pickFirstSatisfiedStopReason('article_cap', ['deadline', 'article_cap'])).toBe('article_cap')
    expect(pickFirstSatisfiedStopReason('article_cap', ['deadline'])).toBe('deadline')
    expect(pickFirstSatisfiedStopReason('deadline', [])).toBeNull()
  })

  test('admits new articles only up to the cap and keeps every pair of admitted articles', () => {
    const {selectEntriesWithinArticleCap} = getRefill()
    const entries = [
      {articleId: 'a', promptId: 'p1'},
      {articleId: 'b', promptId: 'p1'},
      {articleId: 'b', promptId: 'p2'},
      {articleId: 'c', promptId: 'p1'},
      {articleId: 'a', promptId: 'p2'},
    ]

    expect(
      selectEntriesWithinArticleCap({
        admittedArticleIds: new Set(['a']),
        admittedCount: 1,
        cap: 2,
        entries,
        maxEntries: 10,
      }),
    ).toEqual({
      deferredEntries: [],
      entries: [
        {articleId: 'a', promptId: 'p1'},
        {articleId: 'b', promptId: 'p1'},
        {articleId: 'b', promptId: 'p2'},
        {articleId: 'a', promptId: 'p2'},
      ],
      newArticleIds: ['b'],
      skippedCount: 1,
    })
  })

  test('admits nothing new at the cap and defers entries beyond the ready deficit', () => {
    const {selectEntriesWithinArticleCap} = getRefill()

    expect(
      selectEntriesWithinArticleCap({
        admittedArticleIds: new Set(['a']),
        admittedCount: 2,
        cap: 2,
        entries: [
          {articleId: 'b', promptId: 'p1'},
          {articleId: 'a', promptId: 'p1'},
          {articleId: 'a', promptId: 'p2'},
        ],
        maxEntries: 1,
      }),
    ).toEqual({
      deferredEntries: [{articleId: 'a', promptId: 'p2'}],
      entries: [{articleId: 'a', promptId: 'p1'}],
      newArticleIds: [],
      skippedCount: 1,
    })
  })
})

describe('admitted article tracking', () => {
  test('queue inserts admit articles and the backfill adds articles judged by this job only', async () => {
    const fixture = await createStopJobFixture('admit', 5, 2)
    const [article1, article2, article3, article4, article5] = fixture.articleIds as [
      string,
      string,
      string,
      string,
      string,
    ]
    const [prompt1, prompt2] = fixture.promptIds as [string, string]
    const service = getSqliteService()

    await service.addReadyPrompts(
      fixture.jobId,
      [
        {articleId: article1, promptId: prompt1},
        {articleId: article1, promptId: prompt2},
      ],
      'server-stop',
    )
    await insertJudgment({articleId: article2, fixture, promptId: prompt1})
    await insertJudgment({articleId: article3, fixture, modelId: fixture.otherModelId, promptId: prompt1})
    await insertJudgment({
      articleId: article4,
      createdAtSql: 'current_timestamp - INTERVAL 2 HOUR',
      fixture,
      promptId: prompt1,
    })
    await insertJudgment({articleId: article5, deleted: true, fixture, promptId: prompt1})

    expect(await service.getAdmittedArticleState(fixture.jobId)).toEqual({backfilled: false, count: 1})
    expect(
      await getAdmittedArticles().getJudgmentJobJudgedArticleIds({db: getDatabase(), jobId: fixture.jobId}),
    ).toEqual([article2])

    const plan = await getPlan(fixture, {...noConditions, stopAfterArticles: 3})

    expect(await service.getAdmittedArticleState(fixture.jobId)).toEqual({backfilled: true, count: 2})
    expect(plan).toEqual({
      articleAdmission: {admittedCount: 2, cap: 3},
      humanAnsweredOnly: false,
      readyToPause: false,
      refill: 'normal',
      stopReason: null,
    })
    expect(await service.getAdmittedArticleIdsAmong(fixture.jobId, [article1, article3, article2])).toEqual(
      [article1, article2].sort(),
    )
    expect(await service.getAdmittedArticleIdsAfter(fixture.jobId, null, 10)).toEqual([article1, article2].sort())
    expect(
      await getAdmittedArticles().getJudgmentJobAdmittedArticleCount({
        db: getDatabase(),
        jobId: fixture.jobId,
        stopAfterArticles: 3,
      }),
    ).toBe(2)
    expect(
      await getAdmittedArticles().getJudgmentJobAdmittedArticleCount({
        db: getDatabase(),
        jobId: fixture.jobId,
        stopAfterArticles: null,
      }),
    ).toBeNull()
  })

  test('reads the judged article count from DuckDB when the job has no local SQLite state', async () => {
    const fixture = await createStopJobFixture('admit-drained', 2, 1)
    const [article1, article2] = fixture.articleIds as [string, string]
    const [prompt1] = fixture.promptIds as [string]

    await insertJudgment({articleId: article1, fixture, promptId: prompt1})
    await insertJudgment({articleId: article2, fixture, promptId: prompt1})
    await getSqliteService().deleteJob(fixture.jobId)

    expect(
      await getAdmittedArticles().getJudgmentJobAdmittedArticleCount({
        db: getDatabase(),
        jobId: fixture.jobId,
        stopAfterArticles: 1,
      }),
    ).toBe(2)
  })

  test('pending pairs of admitted articles exclude visible judgments and disabled prompts', async () => {
    const fixture = await createStopJobFixture('pending', 2, 3)
    const [article1, article2] = fixture.articleIds as [string, string]
    const [prompt1, prompt2, prompt3] = fixture.promptIds as [string, string, string]

    await insertJudgment({articleId: article1, fixture, promptId: prompt1})
    await insertJudgment({articleId: article1, fixture, modelId: fixture.otherModelId, promptId: prompt2})
    await getDatabase().run(`
      UPDATE app.project_prompt SET enabled = FALSE WHERE id = '${prompt3}-project-prompt'
    `)

    expect(
      await getAdmittedArticles().getPendingPairsForAdmittedArticles({
        articleIds: [article1, article2],
        db: getDatabase(),
        jobId: fixture.jobId,
      }),
    ).toEqual(
      [
        {articleId: article1, promptId: prompt2},
        {articleId: article2, promptId: prompt1},
        {articleId: article2, promptId: prompt2},
      ].sort((left, right) => {
        return `${left.articleId}${left.promptId}`.localeCompare(`${right.articleId}${right.promptId}`)
      }),
    )
  })
})

describe('soft stop', () => {
  test('the article cap finishes every pair of admitted articles before pausing', async () => {
    const fixture = await createStopJobFixture('cap', 3, 2)
    const [article1, article2, article3] = fixture.articleIds as [string, string, string]
    const [prompt1, prompt2] = fixture.promptIds as [string, string]
    const service = getSqliteService()
    const conditions = {...noConditions, stopAfterArticles: 2}
    const job = {id: fixture.jobId, projectId: fixture.projectId}

    await insertJudgment({articleId: article1, fixture, promptId: prompt1})
    await service.addReadyPrompts(fixture.jobId, [{articleId: article2, promptId: prompt1}], 'server-stop')

    const capPlan = await getPlan(fixture, conditions)

    expect(capPlan).toMatchObject({articleAdmission: null, readyToPause: false, refill: 'finishAdmitted'})
    expect(capPlan.stopReason).toBe('article_cap')
    expect(
      await getRefill().finishAdmittedArticlesForJob({
        job,
        readyDeficit: 10,
        serverJobId: 'server-stop',
        sqliteService: service,
      }),
    ).toBe(2)
    expect(await service.getReadyCount(fixture.jobId)).toBe(3)
    expect(await getRefill().pauseJudgmentJobWhenStopped({job, plan: capPlan, sqliteService: service})).toBe(false)

    await clearReadyQueue(fixture.jobId)
    await insertJudgment({articleId: article1, fixture, promptId: prompt2})
    await insertJudgment({articleId: article2, fixture, promptId: prompt1})
    await insertJudgment({articleId: article2, fixture, promptId: prompt2})

    const finishingPlan = await getPlan(fixture, conditions)

    expect(finishingPlan.readyToPause).toBe(false)
    expect(
      await getRefill().finishAdmittedArticlesForJob({
        job,
        readyDeficit: 10,
        serverJobId: 'server-stop',
        sqliteService: service,
      }),
    ).toBe(0)

    const pausePlan = await getPlan(fixture, conditions)

    expect(pausePlan).toMatchObject({readyToPause: true, refill: 'finishAdmitted', stopReason: 'article_cap'})
    expect(await getRefill().pauseJudgmentJobWhenStopped({job, plan: pausePlan, sqliteService: service})).toBe(true)

    const stopState = await getJobStopState(fixture.jobId)

    expect(stopState).toMatchObject({status: 'paused', stopReason: 'article_cap', storageState: 'draining'})
    expect(stopState?.stopReasonAt).not.toBeNull()
    expect(await service.getAdmittedArticleIdsAmong(fixture.jobId, [article3])).toEqual([])
  })

  test('a passed deadline stops the refill and pauses only after queued work drains', async () => {
    const fixture = await createStopJobFixture('deadline', 1, 1)
    const service = getSqliteService()
    const job = {id: fixture.jobId, projectId: fixture.projectId}
    const now = new Date()

    await service.addReadyPrompts(
      fixture.jobId,
      [{articleId: fixture.articleIds[0] ?? '', promptId: fixture.promptIds[0] ?? ''}],
      'server-stop',
    )

    const futurePlan = await getPlan(fixture, {...noConditions, stopAt: new Date(now.getTime() + 60_000)}, now)

    expect(futurePlan).toMatchObject({readyToPause: false, refill: 'normal', stopReason: null})

    const plan = await getPlan(fixture, {...noConditions, stopAt: now}, now)

    expect(plan).toMatchObject({readyToPause: true, refill: 'none', stopReason: 'deadline'})
    expect(await getRefill().pauseJudgmentJobWhenStopped({job, plan, sqliteService: service})).toBe(false)
    expect((await getJobStopState(fixture.jobId))?.status).toBe('running')

    await clearReadyQueue(fixture.jobId)

    expect(await getRefill().pauseJudgmentJobWhenStopped({job, plan, sqliteService: service})).toBe(true)
    expect(await getJobStopState(fixture.jobId)).toMatchObject({status: 'paused', stopReason: 'deadline'})
  })

  test('a passed deadline withdraws unclaimed ready prompts and pauses once claimed work finishes', async () => {
    const fixture = await createStopJobFixture('deadline-withdraw', 2, 2)
    const [article1, article2] = fixture.articleIds as [string, string]
    const [prompt1, prompt2] = fixture.promptIds as [string, string]
    const service = getSqliteService()
    const job = {id: fixture.jobId, projectId: fixture.projectId}
    const now = new Date()

    await service.addReadyPrompts(
      fixture.jobId,
      [
        {articleId: article1, promptId: prompt1},
        {articleId: article1, promptId: prompt2},
        {articleId: article2, promptId: prompt1},
        {articleId: article2, promptId: prompt2},
      ],
      'server-stop',
    )

    const [claimedPrompt] = await service.claimReadyPrompts(fixture.jobId, 'server-stop', 1)

    if (!claimedPrompt) {
      throw new Error('Failed to claim a ready prompt for the deadline withdraw test')
    }

    const plan = await getPlan(fixture, {...noConditions, stopAt: now}, now)

    expect(plan).toMatchObject({readyToPause: true, refill: 'none', stopReason: 'deadline'})
    expect(await getRefill().withdrawReadyPromptsWhenRefillStopped({job, plan, sqliteService: service})).toBe(3)
    expect(await service.getReadyCount(fixture.jobId)).toBe(0)
    expect(await service.getClaimedCount(fixture.jobId)).toBe(1)
    expect(await getRefill().pauseJudgmentJobWhenStopped({job, plan, sqliteService: service})).toBe(false)
    expect((await getJobStopState(fixture.jobId))?.status).toBe('running')

    await service.markPromptAsJudged(fixture.jobId, claimedPrompt.recordId)

    expect(await getRefill().withdrawReadyPromptsWhenRefillStopped({job, plan, sqliteService: service})).toBe(0)
    expect(await getRefill().pauseJudgmentJobWhenStopped({job, plan, sqliteService: service})).toBe(true)
    expect(await getJobStopState(fixture.jobId)).toMatchObject({status: 'paused', stopReason: 'deadline'})
  })

  test('only a deadline or token budget withdraws ready prompts', async () => {
    const fixture = await createStopJobFixture('cap-keeps-ready', 1, 2)
    const [article1] = fixture.articleIds as [string]
    const [prompt1, prompt2] = fixture.promptIds as [string, string]
    const service = getSqliteService()
    const job = {id: fixture.jobId, projectId: fixture.projectId}

    await service.addReadyPrompts(
      fixture.jobId,
      [
        {articleId: article1, promptId: prompt1},
        {articleId: article1, promptId: prompt2},
      ],
      'server-stop',
    )

    const capPlan = await getPlan(fixture, {...noConditions, stopAfterArticles: 1})
    const openPlan = await getPlan(fixture, {...noConditions, stopAt: new Date(Date.now() + 60_000)})

    expect(capPlan).toMatchObject({refill: 'finishAdmitted', stopReason: 'article_cap'})
    expect(openPlan).toMatchObject({refill: 'normal', stopReason: null})
    expect(await getRefill().withdrawReadyPromptsWhenRefillStopped({job, plan: capPlan, sqliteService: service})).toBe(
      0,
    )
    expect(await getRefill().withdrawReadyPromptsWhenRefillStopped({job, plan: openPlan, sqliteService: service})).toBe(
      0,
    )
    expect(await service.getReadyCount(fixture.jobId)).toBe(2)
  })

  test('the token budget compares against the job total token usage', async () => {
    const fixture = await createStopJobFixture('tokens', 1, 1)

    await getDatabase().run(`
      INSERT INTO app.token_use (id, judgment_job_id, requests, total_prompt_tokens, total_completion_tokens, total_tokens)
      VALUES
        ('${fixture.jobId}-token-1', '${fixture.jobId}', 1, 30, 10, 40),
        ('${fixture.jobId}-token-2', '${fixture.jobId}', 1, 50, 10, 60)
    `)

    expect(await getPlan(fixture, {...noConditions, stopAfterTotalTokens: 101})).toMatchObject({
      refill: 'normal',
      stopReason: null,
    })

    getRefill().resetJudgmentJobStopConditionStateForTests()

    expect(await getPlan(fixture, {...noConditions, stopAfterTotalTokens: 100})).toMatchObject({
      readyToPause: true,
      refill: 'none',
      stopReason: 'token_budget',
    })
  })

  test('the first satisfied condition is the recorded stop reason', async () => {
    const fixture = await createStopJobFixture('first-wins', 1, 1)
    const service = getSqliteService()
    const job = {id: fixture.jobId, projectId: fixture.projectId}

    await service.addReadyPrompts(
      fixture.jobId,
      [{articleId: fixture.articleIds[0] ?? '', promptId: fixture.promptIds[0] ?? ''}],
      'server-stop',
    )

    expect((await getPlan(fixture, {...noConditions, stopAfterArticles: 1})).stopReason).toBe('article_cap')

    const now = new Date()
    const plan = await getPlan(fixture, {...noConditions, stopAfterArticles: 1, stopAt: now}, now)

    expect(plan).toMatchObject({refill: 'none', stopReason: 'article_cap'})

    await clearReadyQueue(fixture.jobId)

    expect(await getRefill().pauseJudgmentJobWhenStopped({job, plan, sqliteService: service})).toBe(true)
    expect((await getJobStopState(fixture.jobId))?.stopReason).toBe('article_cap')
  })

  test('the human-answered condition pauses once the human-answered pass is exhausted', async () => {
    const fixture = await createStopJobFixture('human-done', 1, 1)
    const conditions = {...noConditions, stopWhenHumanAnsweredDone: true}

    expect(await getPlan(fixture, conditions)).toMatchObject({
      humanAnsweredOnly: true,
      readyToPause: false,
      refill: 'normal',
      stopReason: null,
    })

    getRefill().recordHumanAnsweredPassResult(fixture.jobId, true)

    const plan = await getPlan(fixture, conditions)

    expect(plan).toMatchObject({readyToPause: true, refill: 'normal', stopReason: 'human_answered_done'})
    expect(
      await getRefill().pauseJudgmentJobWhenStopped({
        job: {id: fixture.jobId, projectId: fixture.projectId},
        plan,
        sqliteService: getSqliteService(),
      }),
    ).toBe(true)
    expect((await getJobStopState(fixture.jobId))?.stopReason).toBe('human_answered_done')
  })

  test('a stop pause does not override a job the user already paused', async () => {
    const fixture = await createStopJobFixture('already-paused', 1, 1)

    await getDatabase().run(`UPDATE app.judgment_job SET status = 'paused' WHERE id = '${fixture.jobId}'`)

    const now = new Date()
    const plan = await getPlan(fixture, {...noConditions, stopAt: now}, now)

    expect(
      await getRefill().pauseJudgmentJobWhenStopped({
        job: {id: fixture.jobId, projectId: fixture.projectId},
        plan,
        sqliteService: getSqliteService(),
      }),
    ).toBe(false)
    expect(await getJobStopState(fixture.jobId)).toMatchObject({status: 'paused', stopReason: null})
  })
})
