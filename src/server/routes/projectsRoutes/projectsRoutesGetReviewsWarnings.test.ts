import {rmSync} from 'node:fs'

import {afterAll, afterEach, beforeAll, expect, test} from 'bun:test'
import {Elysia} from 'elysia'

const tempDbPath = `/tmp/f1-project-reviews-warnings-${process.pid}-${Date.now()}.duckdb`

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempDbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

type ReviewsWarningsResponse = {
  data: {
    enabledPromptCount: number
    indexing: {
      activeConsumerCount: number
      activeWorkCount: number
      blockedReason: 'paused_by_policy' | 'waiting_for_maintenance_worker' | null
      eligibleConsumerCount: number
      eligibleConsumerPresent: boolean
      inFlightArticleRefreshCount: number
      inFlightProjectRefreshCount: number
      inFlightRefreshCount: number
      lastProgressedAt: string | null
      lastStartedAt: string | null
      oldestQueuedAt: string | null
      pendingArticleRefreshCount: number
      pendingProjectRefreshCount: number
      pendingRefreshCount: number
      progressState: 'blocked' | 'completed' | 'failed' | 'processing' | 'queued' | 'stalled'
      queuedArticleRefreshCount: number
      queuedProjectRefreshCount: number
      queuedRefreshCount: number
      recoveryMode: 'none'
      requiredConsumerRole: 'maintenance-worker'
      retryAfterAt: string | null
      status: 'blocked' | 'failed' | 'not-needed' | 'ready' | 'refreshing' | 'stale'
    }
    projectId: string
    scope: {hasAnyArticlesInScope: boolean}
  }
}

type MartRefreshProgressSnapshot = {
  claimedQueuedArticleIds: string[]
  claimedQueuedProjectIds: string[]
  processingArticleIds: string[]
  processingProjectIds: string[]
}

type RefreshStateOverrides = {
  dirtyToken?: number
  lastCompletedRefreshToken?: number
  lastFailedAt?: string | null
  lastRequestedAt?: string | null
  lastStartedAt?: string | null
  leaseExpiresAt?: string | null
  refreshStatus?: 'failed' | 'idle' | 'running'
}

type LargeRebuildStateOverrides = {
  cursorArticleCreatedAt?: string | null
  cursorArticleId?: string | null
  lastError?: string | null
  refreshStatus?: 'failed' | 'idle' | 'running'
  rebuildPhase?: string
  refreshToken?: number
}

let app: {handle: (request: Request) => Promise<Response>} | null = null
let closeDatabase: (() => Promise<void>) | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null
let resetProgressSnapshotForTests: (() => void) | null = null
let setAutoDrainEnabledForTests: ((enabled: boolean) => void) | null = null
let setProgressSnapshotForTests: ((snapshot: MartRefreshProgressSnapshot) => void) | null = null

const insertProjectFixture = async (projectId: string) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode)
    VALUES ('connection-${projectId}', 'sglang', 'SGLang', TRUE, 'none')
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('model-${projectId}', 'connection-${projectId}', 'Qwen/Qwen3.5-122B-A10B', 'Qwen/Qwen3.5-122B-A10B', 'Qwen 122B', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', 'Warnings Project', 'model-${projectId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('prompt-${projectId}', 'Prompt body', 'hash-${projectId}')
  `)
  await runDatabase(`
    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
    VALUES ('project-prompt-${projectId}', '${projectId}', 'prompt-${projectId}', 1, TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('article-${projectId}', 'Indexed article')
  `)
  await runDatabase(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES ('project-article-${projectId}', '${projectId}', 'article-${projectId}')
  `)
}

const insertProjectRefreshState = async (projectId: string, overrides: RefreshStateOverrides = {}) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  const dirtyToken = overrides.dirtyToken ?? 1
  const lastCompletedRefreshToken = overrides.lastCompletedRefreshToken ?? 0
  const lastRequestedAt = overrides.lastRequestedAt ?? '2026-04-02T12:00:00.000Z'
  const lastStartedAt = overrides.lastStartedAt ?? null
  const lastFailedAt = overrides.lastFailedAt ?? null
  const leaseExpiresAt = overrides.leaseExpiresAt ?? null
  const refreshStatus = overrides.refreshStatus ?? 'idle'

  await runDatabase(`
    INSERT INTO app.project_mart_refresh_state (
      project_id,
      dirty_token,
      active_refresh_token,
      last_completed_refresh_token,
      last_requested_at,
      refresh_status,
      last_started_at,
      last_failed_at,
      lease_expires_at
    ) VALUES (
      '${projectId}',
      ${dirtyToken},
      ${refreshStatus === 'running' ? dirtyToken : 0},
      ${lastCompletedRefreshToken},
      ${lastRequestedAt === null ? 'NULL' : `TIMESTAMPTZ '${lastRequestedAt}'`},
      '${refreshStatus}',
      ${lastStartedAt === null ? 'NULL' : `TIMESTAMPTZ '${lastStartedAt}'`},
      ${lastFailedAt === null ? 'NULL' : `TIMESTAMPTZ '${lastFailedAt}'`},
      ${leaseExpiresAt === null ? 'NULL' : `TIMESTAMPTZ '${leaseExpiresAt}'`}
    )
  `)
}

const insertLargeRebuildState = async (projectId: string, overrides: LargeRebuildStateOverrides = {}) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  const refreshToken = overrides.refreshToken ?? 1
  const rebuildPhase = overrides.rebuildPhase ?? 'prompt_answer_fact'
  const refreshStatus = overrides.refreshStatus ?? 'idle'
  const cursorArticleId = overrides.cursorArticleId ?? null
  const cursorArticleCreatedAt = overrides.cursorArticleCreatedAt ?? null
  const lastError = overrides.lastError ?? null

  await runDatabase(`
    INSERT INTO app.project_mart_large_rebuild_state (
      project_id,
      refresh_token,
      rebuild_phase,
      cursor_article_created_at,
      cursor_article_id,
      refresh_status,
      last_error
    ) VALUES (
      '${projectId}',
      ${refreshToken},
      '${rebuildPhase}',
      ${cursorArticleCreatedAt === null ? 'NULL' : `TIMESTAMPTZ '${cursorArticleCreatedAt}'`},
      ${cursorArticleId === null ? 'NULL' : `'${cursorArticleId}'`},
      '${refreshStatus}',
      ${lastError === null ? 'NULL' : `'${lastError}'`}
    )
  `)
}

const insertDirtyArticleRefreshState = async (projectId: string, articleId: string, dirtyToken: number) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  await runDatabase(`
    INSERT INTO app.project_mart_refresh_article_state (
      project_id,
      article_id,
      first_dirty_token,
      last_dirty_token,
      updated_at
    ) VALUES (
      '${projectId}',
      '${articleId}',
      ${dirtyToken},
      ${dirtyToken},
      TIMESTAMPTZ '2026-04-02T12:01:00.000Z'
    )
  `)
}

const insertReviewServingRow = async (projectId: string, articleId: string) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  await runDatabase(`
    INSERT INTO app.project_review_serving_generation (project_id, active_generation)
    VALUES ('${projectId}', 1)
  `)
  await runDatabase(`
    INSERT INTO mart.review_article_serving (
      project_id,
      generation,
      article_id,
      article_created_at,
      article_updated_at,
      article_title,
      article_external_id,
      journal_title,
      url,
      full_text_pdf,
      full_text_fetched_at,
      full_text_conversion_status,
      source_metadata,
      has_all_llm_judgments,
      llm_judged_prompt_count,
      llm_judged_prompt_ids,
      enabled_prompt_count,
      human_answered_prompt_count,
      human_answered_prompt_ids,
      has_all_human_answers,
      review_opened,
      review_sections_completed,
      latest_llm_created_at,
      latest_human_updated_at,
      latest_review_updated_at,
      serving_updated_at
    ) VALUES (
      '${projectId}',
      1,
      '${articleId}',
      TIMESTAMPTZ '2026-04-02 12:00:00+00',
      NULL,
      'Indexed article',
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      FALSE,
      0,
      NULL,
      1,
      0,
      NULL,
      FALSE,
      FALSE,
      0,
      NULL,
      NULL,
      NULL,
      current_timestamp
    )
  `)
}

const postWarningsRequest = async (projectId: string) => {
  if (!app) {
    throw new Error('Test app not initialized')
  }

  const response = await app.handle(
    new Request('http://localhost/api/projectsreviewswarnings', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({projectId}),
    }),
  )

  return {body: (await response.json()) as ReviewsWarningsResponse, response}
}

beforeAll(async () => {
  const [
    {migrateDuckdb},
    {getAppDatabaseService},
    {resetDuckdbServiceForTests},
    {resetServerRuntimeRoleForTests},
    {getDuckdbMartRefreshService},
    {projectsRoutesGetReviewsWarnings},
  ] = await Promise.all([
    import('../../../db/migrateDuckdb.ts'),
    import('../../services/appDatabaseService.ts'),
    import('../../utils/duckdbService.ts'),
    import('../../utils/serverRuntimeRole.ts'),
    import('../../services/getDuckdbMartRefreshService.ts'),
    import('./projectsRoutesGetReviewsWarnings.ts'),
  ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()

  await migrateDuckdb()

  const database = getAppDatabaseService()

  closeDatabase = () => {
    return database.close()
  }
  runDatabase = (statement: string) => {
    return database.run(statement)
  }
  resetProgressSnapshotForTests = () => {
    getDuckdbMartRefreshService().resetProgressSnapshotForTests()
  }
  setAutoDrainEnabledForTests = (enabled) => {
    getDuckdbMartRefreshService().setAutoDrainEnabledForTests(enabled)
  }
  setProgressSnapshotForTests = (snapshot) => {
    getDuckdbMartRefreshService().setProgressSnapshotForTests(snapshot)
  }
  setAutoDrainEnabledForTests(false)
  app = new Elysia().use(projectsRoutesGetReviewsWarnings)
})

afterEach(() => {
  resetProgressSnapshotForTests?.()
})

afterAll(async () => {
  setAutoDrainEnabledForTests?.(true)
  await closeDatabase?.()
  rmSync(tempDbPath, {force: true})
  rmSync(`${tempDbPath}.duckdb-owner.history.json`, {force: true})
  rmSync(`${tempDbPath}.duckdb-owner.lock`, {force: true})
})

test('reviews warnings report ready when serving rows are fresh', async () => {
  const projectId = 'project-ready-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {dirtyToken: 1, lastCompletedRefreshToken: 1, refreshStatus: 'idle'})
  await insertReviewServingRow(projectId, `article-${projectId}`)

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.scope.hasAnyArticlesInScope).toBe(true)
  expect(body.data.enabledPromptCount).toBe(1)
  expect(body.data.indexing.pendingRefreshCount).toBe(0)
  expect(body.data.indexing.progressState).toBe('completed')
  expect(body.data.indexing.status).toBe('ready')
})

test('reviews warnings report refreshing from ledger and worker progress state', async () => {
  if (!runDatabase || !setProgressSnapshotForTests) {
    throw new Error('Test dependencies not initialized')
  }

  const projectId = 'project-refreshing-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {
    dirtyToken: 2,
    lastCompletedRefreshToken: 1,
    lastRequestedAt: '2026-04-02T12:00:00.000Z',
    lastStartedAt: '2026-04-02T12:05:00.000Z',
    refreshStatus: 'running',
  })
  await insertDirtyArticleRefreshState(projectId, `article-${projectId}`, 2)
  setProgressSnapshotForTests({
    claimedQueuedArticleIds: [`article-${projectId}`],
    claimedQueuedProjectIds: [projectId],
    processingArticleIds: [`article-${projectId}`],
    processingProjectIds: [projectId],
  })

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.scope.hasAnyArticlesInScope).toBe(true)
  expect(body.data.indexing.oldestQueuedAt).toBe('2026-04-02 12:00:00+00')
  expect(body.data.indexing.queuedProjectRefreshCount).toBe(0)
  expect(body.data.indexing.inFlightProjectRefreshCount).toBe(1)
  expect(body.data.indexing.pendingProjectRefreshCount).toBe(1)
  expect(body.data.indexing.queuedArticleRefreshCount).toBe(0)
  expect(body.data.indexing.inFlightArticleRefreshCount).toBe(1)
  expect(body.data.indexing.pendingArticleRefreshCount).toBe(1)
  expect(body.data.indexing.queuedRefreshCount).toBe(0)
  expect(body.data.indexing.inFlightRefreshCount).toBe(2)
  expect(body.data.indexing.pendingRefreshCount).toBe(2)
  expect(body.data.indexing.activeConsumerCount).toBe(1)
  expect(body.data.indexing.activeWorkCount).toBe(2)
  expect(body.data.indexing.eligibleConsumerPresent).toBe(true)
  expect(body.data.indexing.progressState).toBe('processing')
  expect(body.data.indexing.status).toBe('refreshing')
})

test('reviews warnings report stale when scope exists but review rollups are missing', async () => {
  const projectId = 'project-stale-warning'

  await insertProjectFixture(projectId)

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.scope.hasAnyArticlesInScope).toBe(true)
  expect(body.data.indexing.pendingRefreshCount).toBe(0)
  expect(body.data.indexing.progressState).toBe('stalled')
  expect(body.data.indexing.status).toBe('stale')
})

test('reviews warnings report failed when refresh work is still dirty after a failed attempt', async () => {
  const projectId = 'project-failed-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {
    dirtyToken: 3,
    lastCompletedRefreshToken: 2,
    lastFailedAt: '2026-04-02T12:07:00.000Z',
    lastRequestedAt: '2026-04-02T12:00:00.000Z',
    refreshStatus: 'failed',
  })

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.oldestQueuedAt).toBe('2026-04-02 12:00:00+00')
  expect(body.data.indexing.queuedProjectRefreshCount).toBe(1)
  expect(body.data.indexing.inFlightProjectRefreshCount).toBe(0)
  expect(body.data.indexing.pendingProjectRefreshCount).toBe(1)
  expect(body.data.indexing.pendingRefreshCount).toBe(1)
  expect(body.data.indexing.progressState).toBe('failed')
  expect(body.data.indexing.status).toBe('failed')
})

test('reviews warnings treat expired running leases as queued instead of in-flight', async () => {
  const projectId = 'project-expired-lease-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {
    dirtyToken: 2,
    lastCompletedRefreshToken: 1,
    lastRequestedAt: '2026-04-02T12:00:00.000Z',
    lastStartedAt: '2026-04-02T12:05:00.000Z',
    leaseExpiresAt: '2026-04-02T12:05:30.000Z',
    refreshStatus: 'running',
  })
  await insertDirtyArticleRefreshState(projectId, `article-${projectId}`, 2)

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.queuedProjectRefreshCount).toBe(1)
  expect(body.data.indexing.inFlightProjectRefreshCount).toBe(0)
  expect(body.data.indexing.pendingProjectRefreshCount).toBe(1)
  expect(body.data.indexing.queuedArticleRefreshCount).toBe(1)
  expect(body.data.indexing.inFlightArticleRefreshCount).toBe(0)
  expect(body.data.indexing.pendingArticleRefreshCount).toBe(1)
  expect(body.data.indexing.pendingRefreshCount).toBe(2)
  expect(body.data.indexing.progressState).toBe('queued')
  expect(body.data.indexing.status).toBe('refreshing')
})

test('reviews warnings report blocked when pending work has no local refresh consumer', async () => {
  const projectId = 'project-blocked-no-consumer-warning'
  const {withCurrentServerRoleOverride} = await import('../../utils/serverRuntimeRole.ts')

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {
    dirtyToken: 2,
    lastCompletedRefreshToken: 1,
    lastRequestedAt: '2026-04-02T12:00:00.000Z',
    refreshStatus: 'idle',
  })

  const {body, response} = await withCurrentServerRoleOverride('api', () => {
    return postWarningsRequest(projectId)
  })

  expect(response.status).toBe(200)
  expect(body.data.indexing.activeConsumerCount).toBe(0)
  expect(body.data.indexing.activeWorkCount).toBe(0)
  expect(body.data.indexing.blockedReason).toBe('waiting_for_maintenance_worker')
  expect(body.data.indexing.eligibleConsumerCount).toBe(0)
  expect(body.data.indexing.eligibleConsumerPresent).toBe(false)
  expect(body.data.indexing.pendingRefreshCount).toBe(1)
  expect(body.data.indexing.progressState).toBe('blocked')
  expect(body.data.indexing.requiredConsumerRole).toBe('maintenance-worker')
  expect(body.data.indexing.status).toBe('blocked')
})

test('reviews warnings report blocked when memory policy disables mart refresh drain', async () => {
  const projectId = 'project-blocked-low-memory-warning'
  const previousDuckdbMemoryLimit = process.env.DUCKDB_MEMORY_LIMIT

  process.env.DUCKDB_MEMORY_LIMIT = '6400MiB'

  try {
    await insertProjectFixture(projectId)
    await insertProjectRefreshState(projectId, {
      dirtyToken: 2,
      lastCompletedRefreshToken: 1,
      lastRequestedAt: '2026-04-02T12:00:00.000Z',
      refreshStatus: 'idle',
    })

    const {body, response} = await postWarningsRequest(projectId)

    expect(response.status).toBe(200)
    expect(body.data.indexing.blockedReason).toBe('paused_by_policy')
    expect(body.data.indexing.eligibleConsumerPresent).toBe(false)
    expect(body.data.indexing.progressState).toBe('blocked')
    expect(body.data.indexing.recoveryMode).toBe('none')
    expect(body.data.indexing.status).toBe('blocked')
  } finally {
    if (previousDuckdbMemoryLimit === undefined) {
      delete process.env.DUCKDB_MEMORY_LIMIT
    } else {
      process.env.DUCKDB_MEMORY_LIMIT = previousDuckdbMemoryLimit
    }
  }
})

test('reviews warnings report refreshing when a staged large rebuild is queued', async () => {
  const projectId = 'project-large-rebuild-queued-warning'

  await insertProjectFixture(projectId)
  await insertLargeRebuildState(projectId, {rebuildPhase: 'prompt_answer_fact', refreshStatus: 'idle', refreshToken: 5})

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.queuedProjectRefreshCount).toBe(1)
  expect(body.data.indexing.inFlightProjectRefreshCount).toBe(0)
  expect(body.data.indexing.pendingProjectRefreshCount).toBe(1)
  expect(body.data.indexing.status).toBe('refreshing')
})

test('reviews warnings report failed when a staged large rebuild has failed', async () => {
  const projectId = 'project-large-rebuild-failed-warning'

  await insertProjectFixture(projectId)
  await insertLargeRebuildState(projectId, {
    rebuildPhase: 'prompt_answer_fact',
    refreshStatus: 'failed',
    refreshToken: 5,
    lastError: 'Maximum call stack size exceeded',
  })

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.status).toBe('failed')
})
