import {afterAll, afterEach, beforeAll, expect, test} from 'bun:test'
import {Elysia} from 'elysia'

import {buildPromptConfigHash, buildReviewConfigHash} from '../../reviewServing/reviewProjectionIdentity.ts'
import {createTempRuntimeRoot} from '../../test/createTempRuntimeRoot.ts'

const tempRuntimeRoot = createTempRuntimeRoot('f1-project-reviews-warnings')
const tempDbPath = tempRuntimeRoot.duckdbPath

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
      blockedReason: 'paused_by_policy' | 'quarantine_barrier' | 'waiting_for_maintenance_worker' | null
      cleanup: {inFlightGenerationCleanupCount: number; lastProgressedAt: string | null}
      diagnostics: {
        duckdbQueues: {background: {queueDepth: number}; main: {queueDepth: number}}
        largeRebuild: {
          currentPhase: null | {
            committedRowCount: number
            lastRssBytes: number | null
            maxTempSpillBytes: number | null
            queueWaitMs: number | null
            rowsPerSecond: number | null
          }
          lastCycle: null | {
            phase: string | null
            queueWaitMs: number | null
            rowsPerSecond: number | null
            rssBytes: number | null
          }
        }
        processMemory: {rssBytes: number}
        tempSpill: {available: boolean; totalBytes: number | null}
      }
      eligibleConsumerCount: number
      eligibleConsumerPresent: boolean
      dirtyMaterialization: {
        failedCount: number
        incompleteCount: number
        pendingCount: number
        runningCount: number
        unreconciledCount: number
      }
      freshness: {
        hasIncompleteDirtyMaterialization: boolean
        hasUnresolvedQuarantineBarrier: boolean
        isFresh: boolean
        status: 'fresh' | 'pending' | 'stale'
        unresolvedQuarantineBarrierCount: number
      }
      inFlightArticleRefreshCount: number
      inFlightProjectRefreshCount: number
      inFlightRefreshCount: number
      largeRebuild: null | {
        refreshStatus: 'idle' | 'paused' | 'running' | null
        progress: null | {
          remainingCurrentPhaseArticleCount: number | null
          rowsPerMinute: number | null
          scopeArticleCount: number
        }
      }
      lastProgressedAt: string | null
      lastProcessedAt: string | null
      lastStartedAt: string | null
      oldestQueuedAt: string | null
      pendingArticleRefreshCount: number
      pendingProjectRefreshCount: number
      pendingRefreshCount: number
      progressState: 'blocked' | 'completed' | 'failed' | 'processing' | 'queued' | 'stalled'
      queuedArticleRefreshCount: number
      queuedProjectRefreshCount: number
      queuedRefreshCount: number
      quarantinedArticleRefreshCount: number
      quarantinedArticles: Array<{
        articleId: string
        createdAt: string | null
        detectedBy: string | null
        error: string
        updatedAt: string | null
      }>
      recoveryContext: Record<string, unknown> | null
      recoveryMode: 'archived_project_mart_recovery' | 'none' | 'retry_backoff'
      requiredConsumerRole: 'maintenance-worker'
      retryAfterAt: string | null
      search: {
        availability: 'ready' | 'indexing' | 'unavailable' | 'async'
        optionalComponent: boolean
        snapshotId: string | null
      }
      serving: {
        diagnostics: {quarantine: {retryableOutboxCount: number; unresolvedOutboxCount: number}}
        readable: boolean
        usable: boolean
      }
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
  lastCompletedDirtyToken?: number
  lastFailedAt?: string | null
  lastRequestedAt?: string | null
  lastStartedAt?: string | null
  leaseExpiresAt?: string | null
  refreshStatus?: 'failed' | 'idle' | 'running'
  workerId?: string | null
}

type LargeRebuildStateOverrides = {
  cursorArticleCreatedAt?: string | null
  cursorArticleId?: string | null
  lastError?: string | null
  refreshStatus?: 'failed' | 'idle' | 'running'
  rebuildPhase?: string
  refreshToken?: number
  workerId?: string | null
}

type ReviewRebuildChunkStatus = 'blocked_over_budget' | 'completed' | 'failed' | 'pending' | 'quarantined' | 'running'
type DirtyMaterializationStatus = 'completed' | 'failed' | 'pending' | 'running' | 'unreconciled'

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
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('connection-${projectId}', 'sglang', 'SGLang', TRUE, 'none', 'https://worker.example.test')
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled, variant, metadata_json)
    VALUES ('model-${projectId}', 'connection-${projectId}', 'Qwen/Qwen3.5-122B-A10B', 'Qwen/Qwen3.5-122B-A10B', 'Qwen 122B', 'manual', TRUE, 'thinking', '{"options":{"thinking":{"effort":"high"}}}'::JSON)
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
  const lastCompletedDirtyToken = overrides.lastCompletedDirtyToken ?? 0
  const lastRequestedAt = overrides.lastRequestedAt ?? '2026-04-02T12:00:00.000Z'
  const lastStartedAt = overrides.lastStartedAt ?? null
  const lastFailedAt = overrides.lastFailedAt ?? null
  const leaseExpiresAt = overrides.leaseExpiresAt ?? null
  const refreshStatus = overrides.refreshStatus ?? 'idle'
  const workerId = overrides.workerId ?? (refreshStatus === 'running' ? `worker-${projectId}` : null)

  await runDatabase(`
    INSERT INTO app.project_mart_refresh_state (
      project_id,
      dirty_token,
      active_dirty_token,
      last_completed_dirty_token,
      last_requested_at,
      refresh_status,
      last_started_at,
      last_failed_at,
      lease_expires_at,
      worker_id
    ) VALUES (
      '${projectId}',
      ${dirtyToken},
      ${refreshStatus === 'running' ? dirtyToken : 0},
      ${lastCompletedDirtyToken},
      ${lastRequestedAt === null ? 'NULL' : `TIMESTAMPTZ '${lastRequestedAt}'`},
      '${refreshStatus}',
      ${lastStartedAt === null ? 'NULL' : `TIMESTAMPTZ '${lastStartedAt}'`},
      ${lastFailedAt === null ? 'NULL' : `TIMESTAMPTZ '${lastFailedAt}'`},
      ${leaseExpiresAt === null ? 'NULL' : `TIMESTAMPTZ '${leaseExpiresAt}'`},
      ${workerId === null ? 'NULL' : `'${workerId}'`}
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
  const workerId = overrides.workerId ?? (refreshStatus === 'running' ? `worker-${projectId}` : null)

  await runDatabase(`
    INSERT INTO app.project_mart_large_rebuild_state (
      project_id,
      refresh_token,
      rebuild_phase,
      cursor_article_created_at,
      cursor_article_id,
      refresh_status,
      last_error,
      worker_id
    ) VALUES (
      '${projectId}',
      ${refreshToken},
      '${rebuildPhase}',
      ${cursorArticleCreatedAt === null ? 'NULL' : `TIMESTAMPTZ '${cursorArticleCreatedAt}'`},
      ${cursorArticleId === null ? 'NULL' : `'${cursorArticleId}'`},
      '${refreshStatus}',
      ${lastError === null ? 'NULL' : `'${lastError}'`},
      ${workerId === null ? 'NULL' : `'${workerId}'`}
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

const insertDirtyMaterializationState = async (input: {
  leaseExpiresAt?: string | null
  materializationOwner?: string | null
  projectId: string
  sourceKind: string
  status: DirtyMaterializationStatus
  targetDirtyToken: number
}) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  await runDatabase(`
    INSERT INTO app.project_mart_dirty_materialization_state (
      project_id,
      source_kind,
      target_dirty_token,
      source_scope_generation,
      source_scope_expected_row_count,
      materialization_status,
      materialization_owner,
      lease_expires_at,
      created_at,
      last_started_at,
      updated_at
    ) VALUES (
      '${input.projectId}',
      '${input.sourceKind}',
      ${input.targetDirtyToken},
      1,
      1,
      '${input.status}',
      ${input.materializationOwner === undefined || input.materializationOwner === null ? 'NULL' : `'${input.materializationOwner}'`},
      ${input.leaseExpiresAt === undefined || input.leaseExpiresAt === null ? 'NULL' : `TIMESTAMPTZ '${input.leaseExpiresAt}'`},
      TIMESTAMPTZ '2026-04-02T12:02:00.000Z',
      ${input.status === 'running' ? "TIMESTAMPTZ '2026-04-02T12:02:30.000Z'" : 'NULL'},
      TIMESTAMPTZ '2026-04-02T12:03:00.000Z'
    )
  `)
}

const insertReviewSourceChangeOutbox = async (projectId: string) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  await runDatabase(`
    INSERT INTO app.review_source_change_outbox (
      outbox_id,
      source_table,
      source_row_id,
      source_operation,
      source_partition,
      source_high_water_mark,
      idempotency_key,
      payload_version,
      recovery_payload_json,
      status,
      created_at,
      updated_at
    ) VALUES (
      'outbox-${projectId}',
      'app.review_change_delta',
      'review-change-${projectId}',
      'insert',
      'review-change:${projectId}',
      1,
      'outbox-key-${projectId}',
      1,
      '{}'::JSON,
      'pending',
      TIMESTAMPTZ '2026-04-02T12:00:00.000Z',
      TIMESTAMPTZ '2026-04-02T12:00:00.000Z'
    )
  `)
}

const insertFreshArticleRefreshLease = async (projectId: string, articleId: string) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  await runDatabase(`
    INSERT INTO app.maintenance_work_lease (
      id,
      work_kind,
      scope_kind,
      project_id,
      article_id,
      required_consumer_role,
      consumer_id,
      last_started_at,
      last_progressed_at,
      lease_expires_at,
      fresh_until_at
    ) VALUES (
      'test-article-refresh-lease-${projectId}',
      'review_index_article_refresh',
      'article',
      '${projectId}',
      '${articleId}',
      'maintenance-worker',
      'test-maintenance-worker',
      TIMESTAMPTZ '2026-04-02T12:05:00.000Z',
      TIMESTAMPTZ '2026-04-02T12:05:15.000Z',
      TIMESTAMPTZ '2035-04-02T12:05:30.000Z',
      TIMESTAMPTZ '2035-04-02T12:05:30.000Z'
    )
  `)
}

const insertFreshGenerationCleanupLease = async (projectId: string) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  await runDatabase(`
    INSERT INTO app.maintenance_work_lease (
      id,
      work_kind,
      scope_kind,
      project_id,
      article_id,
      required_consumer_role,
      consumer_id,
      last_started_at,
      last_progressed_at,
      lease_expires_at,
      fresh_until_at
    ) VALUES (
      'test-generation-cleanup-lease-${projectId}',
      'review_index_serving_generation_cleanup',
      'project',
      '${projectId}',
      NULL,
      'maintenance-worker',
      'test-maintenance-worker',
      TIMESTAMPTZ '2026-04-02T12:05:00.000Z',
      TIMESTAMPTZ '2026-04-02T12:05:20.000Z',
      TIMESTAMPTZ '2035-04-02T12:05:30.000Z',
      TIMESTAMPTZ '2035-04-02T12:05:30.000Z'
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

const insertReviewRebuildChunk = async (input: {
  chunkId: string
  createdAt: string
  leaseExpiresAt?: string | null
  leaseOwner?: string | null
  projectId: string
  requestId?: string | null
  retryAfter?: string | null
  status: ReviewRebuildChunkStatus
  updatedAt: string
}) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  await runDatabase(`
    INSERT INTO app.review_rebuild_chunk_manifest (
      chunk_id,
      request_id,
      project_id,
      projection_component,
      projection_identity,
      input_digest,
      input_watermark,
      chunk_start_key,
      chunk_end_key,
      output_base_generation,
      status,
      lease_owner,
      lease_expires_at,
      retry_after,
      created_at,
      updated_at
    ) VALUES (
      '${input.chunkId}',
      ${input.requestId === undefined || input.requestId === null ? 'NULL' : `'${input.requestId}'`},
      '${input.projectId}',
      'summary',
      'summary:identity-1',
      'summary-digest-v1',
      1,
      'article-a',
      'article-z',
      1,
      '${input.status}',
      ${input.leaseOwner === undefined || input.leaseOwner === null ? 'NULL' : `'${input.leaseOwner}'`},
      ${input.leaseExpiresAt === undefined || input.leaseExpiresAt === null ? 'NULL' : `TIMESTAMPTZ '${input.leaseExpiresAt}'`},
      ${input.retryAfter === undefined || input.retryAfter === null ? 'NULL' : `TIMESTAMPTZ '${input.retryAfter}'`},
      TIMESTAMPTZ '${input.createdAt}',
      TIMESTAMPTZ '${input.updatedAt}'
    )
  `)
}

const insertReviewRebuildRequest = async (input: {
  completedAt?: string | null
  createdAt: string
  projectId: string
  requestId: string
  status: 'admitted' | 'blocked_over_budget' | 'completed'
  updatedAt: string
}) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  await runDatabase(`
    INSERT INTO app.review_rebuild_request (
      request_id,
      project_id,
      reason,
      requested_components_json,
      source_watermarks_json,
      identity_json,
      status,
      admission_state,
      retry_policy_json,
      over_budget_reason,
      diagnostics_json,
      admitted_at,
      completed_at,
      created_at,
      updated_at
    ) VALUES (
      '${input.requestId}',
      '${input.projectId}',
      'test',
      '["summary"]'::JSON,
      '{}'::JSON,
      '{}'::JSON,
      '${input.status}',
      ${input.status === 'blocked_over_budget' ? "'blocked_over_budget'" : "'admitted'"},
      '{}'::JSON,
      ${input.status === 'blocked_over_budget' ? "'test over budget'" : 'NULL'},
      '{}'::JSON,
      TIMESTAMPTZ '${input.createdAt}',
      ${input.completedAt === undefined || input.completedAt === null ? 'NULL' : `TIMESTAMPTZ '${input.completedAt}'`},
      TIMESTAMPTZ '${input.createdAt}',
      TIMESTAMPTZ '${input.updatedAt}'
    )
  `)
}

const getReviewRebuildRequestCount = async (projectId: string) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  const {getAppDatabaseService} = await import('../../services/appDatabaseService.ts')
  const [row] = await getAppDatabaseService().queryJson<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.review_rebuild_request
    WHERE project_id = '${projectId}'
      AND reason = 'missingReviewServingSnapshot'
      AND status = 'admitted'
      AND admission_state = 'admitted'
  `)

  return Number(row?.count ?? 0)
}

const insertActiveReviewServingManifest = async (input: {
  includeSearchState: boolean
  optionalComponents: string[]
  projectId: string
  reviewConfigHash?: string | null
  snapshotId: string
  status?: 'active' | 'candidate' | 'failed' | 'retired'
}) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  const optional = input.includeSearchState
    ? [{baseGeneration: '1', component: 'search', patchWatermark: '0', projectionIdentity: 'search:identity-1'}]
    : []
  const required = ['projectScope', 'posting', 'queue', 'summary'].map((component) => {
    return {baseGeneration: '1', component, patchWatermark: '0', projectionIdentity: `${component}:identity-1`}
  })
  const reviewConfigHash =
    input.reviewConfigHash === undefined ? getFixtureReviewConfigHash(input.projectId) : input.reviewConfigHash
  const reviewConfigHashSql = reviewConfigHash === null ? 'NULL' : `'${reviewConfigHash}'`
  const status = input.status ?? 'active'

  await runDatabase(`
    INSERT INTO app.review_serving_snapshot_manifest (
      project_id,
      snapshot_id,
      snapshot_status,
      review_config_hash,
      composed_identity_json,
      component_state_json,
      required_components_json,
      optional_components_json,
      source_watermarks_json,
      activated_at,
      updated_at
    ) VALUES (
      '${input.projectId}',
      '${input.snapshotId}',
      '${status}',
      ${reviewConfigHashSql},
      '{}'::JSON,
      '${JSON.stringify({optional, required}).replaceAll("'", "''")}'::JSON,
      '${JSON.stringify(required).replaceAll("'", "''")}'::JSON,
      '${JSON.stringify(input.optionalComponents).replaceAll("'", "''")}'::JSON,
      '{}'::JSON,
      TIMESTAMPTZ '2026-04-02T12:08:00.000Z',
      TIMESTAMPTZ '2026-04-02T12:08:00.000Z'
    )
  `)
}

const getFixtureReviewConfigHash = (projectId: string) => {
  return buildReviewConfigHash({
    humanJudgmentMode: 'prompt',
    modelExecutionIdentity: {
      modelExecutionOptions: {thinking: {effort: 'high'}},
      modelId: `model-${projectId}`,
      providerBaseUrl: 'https://worker.example.test',
      providerConnectionId: `connection-${projectId}`,
      providerKind: 'sglang',
      remoteModelId: 'Qwen/Qwen3.5-122B-A10B',
      variant: 'thinking',
    },
    modelId: `model-${projectId}`,
    promptConfigs: [
      {
        promptConfigHash: buildPromptConfigHash({
          answerSchemaHash: null,
          promptId: `prompt-${projectId}`,
          promptTextHash: `hash-${projectId}`,
          settingsVersion: 'prompt-v1',
          thresholdVersion: null,
        }),
        promptId: `prompt-${projectId}`,
        promptOrder: 1,
      },
    ],
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  })
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

  const responseText = await response.text()
  try {
    return {body: JSON.parse(responseText) as ReviewsWarningsResponse, response}
  } catch (error) {
    throw new Error(`Failed to parse warnings response ${response.status}: ${responseText}`, {cause: error})
  }
}

const withServerMutationsDisabled = async <_T>(work: () => Promise<_T>) => {
  const {resetDuckdbOwnerConnectionsForTests} = await import('../../utils/duckdbOwnerConnections.ts')
  const previousValue = process.env.FORSKA_DISABLE_SERVER_MUTATIONS
  process.env.FORSKA_DISABLE_SERVER_MUTATIONS = 'true'
  await resetDuckdbOwnerConnectionsForTests()

  try {
    return await work()
  } finally {
    if (previousValue === undefined) {
      delete process.env.FORSKA_DISABLE_SERVER_MUTATIONS
    } else {
      process.env.FORSKA_DISABLE_SERVER_MUTATIONS = previousValue
    }
    await resetDuckdbOwnerConnectionsForTests()
  }
}

beforeAll(async () => {
  const [
    {migrateDuckdb},
    {getAppDatabaseService},
    {resetDuckdbServiceForTests},
    {resetServerRuntimeRoleForTests},
    {projectsRoutesGetReviewsWarnings},
  ] = await Promise.all([
    import('../../../db/migrateDuckdb.ts'),
    import('../../services/appDatabaseService.ts'),
    import('../../utils/duckdbService.ts'),
    import('../../utils/serverRuntimeRole.ts'),
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
  resetProgressSnapshotForTests = () => {}
  setAutoDrainEnabledForTests = () => {}
  setProgressSnapshotForTests = () => {}
  setAutoDrainEnabledForTests(false)
  app = new Elysia().use(projectsRoutesGetReviewsWarnings)
})

afterEach(() => {
  resetProgressSnapshotForTests?.()
})

afterAll(async () => {
  setAutoDrainEnabledForTests?.(true)
  await closeDatabase?.()
  tempRuntimeRoot.cleanup()
})

test('reviews warnings report ready when serving rows are fresh', async () => {
  const projectId = 'project-ready-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {dirtyToken: 1, lastCompletedDirtyToken: 1, refreshStatus: 'idle'})
  await insertReviewServingRow(projectId, `article-${projectId}`)
  await insertActiveReviewServingManifest({
    includeSearchState: false,
    optionalComponents: [],
    projectId,
    snapshotId: 'snapshot-ready-warning',
  })

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.scope.hasAnyArticlesInScope).toBe(true)
  expect(body.data.enabledPromptCount).toBe(1)
  expect(body.data.indexing.pendingRefreshCount).toBe(0)
  expect(body.data.indexing.progressState).toBe('completed')
  expect(body.data.indexing.serving).toMatchObject({readable: true, usable: true})
  expect(body.data.indexing.status).toBe('ready')
})

test.skip('retired legacy mart diagnostics: stale snapshots usable during refresh without hiding pending work', async () => {
  const projectId = 'project-stale-readable-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {dirtyToken: 2, lastCompletedDirtyToken: 1, refreshStatus: 'idle'})
  await insertReviewServingRow(projectId, `article-${projectId}`)
  await insertActiveReviewServingManifest({
    includeSearchState: false,
    optionalComponents: [],
    projectId,
    snapshotId: 'snapshot-stale-readable-warning',
    status: 'retired',
  })

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.serving.diagnostics.rebuildChunks).toMatchObject({failedCount: 0, pendingCount: 1})
  expect(body.data.indexing.pendingRefreshCount).toBe(1)
  expect(body.data.indexing.progressState).toBe('queued')
  expect(body.data.indexing.serving).toMatchObject({readable: true, usable: true})
  expect(body.data.indexing.status).toBe('refreshing')
})

test('reviews warnings report completed health for last-known-good serving with no pending work', async () => {
  const projectId = 'project-retired-completed-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {dirtyToken: 1, lastCompletedDirtyToken: 1, refreshStatus: 'idle'})
  await insertReviewServingRow(projectId, `article-${projectId}`)
  await insertActiveReviewServingManifest({
    includeSearchState: false,
    optionalComponents: [],
    projectId,
    snapshotId: 'snapshot-retired-completed-warning',
    status: 'retired',
  })

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.pendingRefreshCount).toBe(0)
  expect(body.data.indexing.progressState).toBe('completed')
  expect(body.data.indexing.serving).toMatchObject({readable: true, usable: true})
  expect(body.data.indexing.status).toBe('ready')
})

test('reviews warnings do not treat failed serving snapshots as progressable repair state', async () => {
  const projectId = 'project-failed-serving-snapshot-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {dirtyToken: 1, lastCompletedDirtyToken: 1, refreshStatus: 'idle'})
  await insertActiveReviewServingManifest({
    includeSearchState: false,
    optionalComponents: [],
    projectId,
    snapshotId: 'snapshot-failed-serving-warning',
    status: 'failed',
  })

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.scope.hasAnyArticlesInScope).toBe(true)
  expect(body.data.indexing.pendingRefreshCount).toBe(0)
  expect(body.data.indexing.progressState).toBe('stalled')
  expect(body.data.indexing.serving).toMatchObject({readable: false, usable: false})
  expect(body.data.indexing.status).toBe('stale')
})

test.skip('retired legacy maintenance lease diagnostics: bounded cleanup lease progress', async () => {
  const projectId = 'project-generation-cleanup-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {dirtyToken: 1, lastCompletedDirtyToken: 1, refreshStatus: 'idle'})
  await insertReviewServingRow(projectId, `article-${projectId}`)
  await insertActiveReviewServingManifest({
    includeSearchState: false,
    optionalComponents: [],
    projectId,
    snapshotId: 'snapshot-generation-cleanup-warning',
  })
  await insertFreshGenerationCleanupLease(projectId)

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.cleanup).toEqual({
    inFlightGenerationCleanupCount: 1,
    lastProgressedAt: '2026-04-02 12:05:20+00',
  })
  expect(body.data.indexing.pendingRefreshCount).toBe(0)
  expect(body.data.indexing.progressState).toBe('completed')
  expect(body.data.indexing.status).toBe('ready')
})

test('reviews warnings expose optional search diagnostic without blocking ready activation', async () => {
  const projectId = 'project-search-diagnostic-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {dirtyToken: 1, lastCompletedDirtyToken: 1, refreshStatus: 'idle'})
  await insertReviewServingRow(projectId, `article-${projectId}`)
  await insertActiveReviewServingManifest({
    includeSearchState: false,
    optionalComponents: ['search'],
    projectId,
    snapshotId: 'snapshot-search-indexing',
  })

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.search).toEqual({
    availability: 'indexing',
    optionalComponent: true,
    snapshotId: 'snapshot-search-indexing',
  })
  expect(body.data.indexing.pendingRefreshCount).toBe(0)
  expect(body.data.indexing.status).toBe('ready')
})

test('reviews warnings fold V4 rebuild chunks into visible progress', async () => {
  const projectId = 'project-v4-rebuild-progress-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {dirtyToken: 1, lastCompletedDirtyToken: 1, refreshStatus: 'idle'})
  await insertReviewServingRow(projectId, `article-${projectId}`)
  await insertActiveReviewServingManifest({
    includeSearchState: false,
    optionalComponents: [],
    projectId,
    snapshotId: 'snapshot-v4-rebuild-progress-warning',
  })
  await insertReviewRebuildChunk({
    chunkId: 'rebuild-chunk-pending-warning',
    createdAt: '2026-04-02T12:00:00.000Z',
    projectId,
    status: 'pending',
    updatedAt: '2026-04-02T12:00:00.000Z',
  })
  await insertReviewRebuildChunk({
    chunkId: 'rebuild-chunk-running-warning',
    createdAt: '2026-04-02T12:01:00.000Z',
    projectId,
    status: 'running',
    updatedAt: '2026-04-02T12:05:00.000Z',
  })
  await insertReviewRebuildChunk({
    chunkId: 'rebuild-chunk-blocked-warning',
    createdAt: '2026-04-02T11:59:00.000Z',
    projectId,
    status: 'blocked_over_budget',
    updatedAt: '2026-04-02T12:02:00.000Z',
  })

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.activeWorkCount).toBe(1)
  expect(body.data.indexing.inFlightRefreshCount).toBe(1)
  expect(body.data.indexing.oldestQueuedAt).toBe('2026-04-02 12:00:00+00')
  expect(body.data.indexing.pendingRefreshCount).toBe(2)
  expect(body.data.indexing.progressState).toBe('failed')
  expect(body.data.indexing.queuedRefreshCount).toBe(1)
  expect(body.data.indexing.status).toBe('failed')
})

test('reviews warnings ignore superseded terminal V4 rebuild chunks', async () => {
  const projectId = 'project-v4-superseded-terminal-rebuild-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {dirtyToken: 1, lastCompletedDirtyToken: 1, refreshStatus: 'idle'})
  await insertReviewServingRow(projectId, `article-${projectId}`)
  await insertActiveReviewServingManifest({
    includeSearchState: false,
    optionalComponents: [],
    projectId,
    snapshotId: 'snapshot-v4-superseded-terminal-rebuild-warning',
  })
  await insertReviewRebuildRequest({
    createdAt: '2026-04-02T12:00:00.000Z',
    projectId,
    requestId: 'request-v4-superseded-blocked-warning',
    status: 'blocked_over_budget',
    updatedAt: '2026-04-02T12:00:00.000Z',
  })
  await insertReviewRebuildChunk({
    chunkId: 'rebuild-chunk-superseded-blocked-warning',
    createdAt: '2026-04-02T12:00:00.000Z',
    projectId,
    requestId: 'request-v4-superseded-blocked-warning',
    status: 'blocked_over_budget',
    updatedAt: '2026-04-02T12:00:00.000Z',
  })
  await insertReviewRebuildRequest({
    completedAt: '2026-04-02T12:10:00.000Z',
    createdAt: '2026-04-02T12:09:00.000Z',
    projectId,
    requestId: 'request-v4-successful-warning',
    status: 'completed',
    updatedAt: '2026-04-02T12:10:00.000Z',
  })
  await insertReviewRebuildChunk({
    chunkId: 'rebuild-chunk-successful-warning',
    createdAt: '2026-04-02T12:09:00.000Z',
    projectId,
    requestId: 'request-v4-successful-warning',
    status: 'completed',
    updatedAt: '2026-04-02T12:10:00.000Z',
  })

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.pendingRefreshCount).toBe(0)
  expect(body.data.indexing.progressState).toBe('completed')
  expect(body.data.indexing.status).toBe('ready')
})

test('reviews warnings block queued V4 rebuild work when server mutation work is disabled', async () => {
  const projectId = 'project-v4-expired-rebuild-lease-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {dirtyToken: 1, lastCompletedDirtyToken: 1, refreshStatus: 'idle'})
  await insertReviewServingRow(projectId, `article-${projectId}`)
  await insertActiveReviewServingManifest({
    includeSearchState: false,
    optionalComponents: [],
    projectId,
    snapshotId: 'snapshot-v4-expired-rebuild-lease-warning',
  })
  await insertReviewRebuildChunk({
    chunkId: 'rebuild-chunk-expired-lease-warning',
    createdAt: '2026-04-02T11:59:00.000Z',
    leaseExpiresAt: '2026-04-02T12:00:00.000Z',
    leaseOwner: 'worker-dead',
    projectId,
    status: 'running',
    updatedAt: '2026-04-02T12:01:00.000Z',
  })

  const {body, response} = await withServerMutationsDisabled(() => {
    return postWarningsRequest(projectId)
  })

  expect(response.status).toBe(200)
  expect(body.data.indexing.activeWorkCount).toBe(0)
  expect(body.data.indexing.blockedReason).toBe('waiting_for_maintenance_worker')
  expect(body.data.indexing.eligibleConsumerCount).toBe(0)
  expect(body.data.indexing.eligibleConsumerPresent).toBe(false)
  expect(body.data.indexing.inFlightRefreshCount).toBe(0)
  expect(body.data.indexing.oldestQueuedAt).toBe('2026-04-02 11:59:00+00')
  expect(body.data.indexing.pendingRefreshCount).toBe(1)
  expect(body.data.indexing.progressState).toBe('blocked')
  expect(body.data.indexing.queuedRefreshCount).toBe(1)
  expect(body.data.indexing.status).toBe('blocked')
})

test('reviews warnings keep retryable V4 rebuild chunk failures queued', async () => {
  const projectId = 'project-v4-retryable-rebuild-failed-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {dirtyToken: 1, lastCompletedDirtyToken: 1, refreshStatus: 'idle'})
  await insertReviewServingRow(projectId, `article-${projectId}`)
  await insertActiveReviewServingManifest({
    includeSearchState: false,
    optionalComponents: [],
    projectId,
    snapshotId: 'snapshot-v4-retryable-rebuild-failed-warning',
  })
  await insertReviewRebuildChunk({
    chunkId: 'rebuild-chunk-retryable-failed-warning',
    createdAt: '2026-04-02T12:00:00.000Z',
    projectId,
    retryAfter: '2099-04-02T12:05:00.000Z',
    status: 'failed',
    updatedAt: '2026-04-02T12:01:00.000Z',
  })

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.pendingRefreshCount).toBe(1)
  expect(body.data.indexing.progressState).toBe('queued')
  expect(body.data.indexing.queuedRefreshCount).toBe(1)
  expect(body.data.indexing.status).toBe('refreshing')
})

test('reviews warnings keep pending V4 outbox barriers non-ready without a serving snapshot', async () => {
  const projectId = 'project-v4-outbox-barrier-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {dirtyToken: 1, lastCompletedDirtyToken: 1, refreshStatus: 'idle'})
  await insertReviewSourceChangeOutbox(projectId)

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.pendingRefreshCount).toBe(1)
  expect(body.data.indexing.progressState).toBe('queued')
  expect(body.data.indexing.serving.diagnostics.quarantine).toMatchObject({
    retryableOutboxCount: 1,
    unresolvedOutboxCount: 1,
  })
  expect(body.data.indexing.serving).toMatchObject({readable: false, usable: false})
  expect(body.data.indexing.status).toBe('refreshing')
})

test('reviews warnings search diagnostic ignores active snapshots for older review configs', async () => {
  const projectId = 'project-search-diagnostic-current-config-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {dirtyToken: 1, lastCompletedDirtyToken: 1, refreshStatus: 'idle'})
  await insertReviewServingRow(projectId, `article-${projectId}`)
  await insertActiveReviewServingManifest({
    includeSearchState: true,
    optionalComponents: ['search'],
    projectId,
    reviewConfigHash: 'old-review-config-hash',
    snapshotId: 'snapshot-search-old-config',
  })
  await insertActiveReviewServingManifest({
    includeSearchState: false,
    optionalComponents: ['search'],
    projectId,
    snapshotId: 'snapshot-search-current-config',
  })

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.search).toEqual({
    availability: 'indexing',
    optionalComponent: true,
    snapshotId: 'snapshot-search-current-config',
  })
})

test.skip('retired legacy mart diagnostics: quarantined article refreshes without pending healthy work', async () => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  const projectId = 'project-quarantined-article-warning'
  const articleId = `article-${projectId}`

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {dirtyToken: 1, lastCompletedDirtyToken: 1, refreshStatus: 'idle'})
  await insertDirtyArticleRefreshState(projectId, articleId, 1)
  await insertReviewServingRow(projectId, articleId)
  await runDatabase(`
    INSERT INTO app.project_mart_dirty_refresh_article_quarantine (
      project_id,
      article_id,
      dirty_token,
      error,
      detected_by,
      created_at,
      updated_at
    ) VALUES (
      '${projectId}',
      '${articleId}',
      1,
      'native crash repro',
      'test-suite',
      TIMESTAMPTZ '2026-04-02T12:02:00.000Z',
      TIMESTAMPTZ '2026-04-02T12:03:00.000Z'
    )
  `)

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.pendingArticleRefreshCount).toBe(0)
  expect(body.data.indexing.pendingProjectRefreshCount).toBe(1)
  expect(body.data.indexing.pendingRefreshCount).toBe(1)
  expect(body.data.indexing.blockedReason).toBe('quarantine_barrier')
  expect(body.data.indexing.freshness).toMatchObject({
    hasUnresolvedQuarantineBarrier: true,
    isFresh: false,
    status: 'stale',
    unresolvedQuarantineBarrierCount: 1,
  })
  expect(body.data.indexing.quarantinedArticleRefreshCount).toBe(1)
  expect(
    body.data.indexing.quarantinedArticles.map((article) => {
      return {articleId: article.articleId, detectedBy: article.detectedBy, error: article.error}
    }),
  ).toEqual([{articleId, detectedBy: 'test-suite', error: 'native crash repro'}])
  expect(body.data.indexing.progressState).toBe('blocked')
  expect(body.data.indexing.status).toBe('blocked')
})

test('reviews warnings request V4 repair without legacy judgment fact fallback outside the foreground response', async () => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  const projectId = 'project-missing-judgment-fact-warning'
  const articleId = `article-${projectId}`

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {dirtyToken: 1, lastCompletedDirtyToken: 1, refreshStatus: 'idle'})
  await insertReviewServingRow(projectId, articleId)
  await runDatabase(`
    INSERT INTO mart.project_scope_article (
      project_id,
      article_id,
      in_curated_scope,
      in_route_scope,
      article_created_at,
      article_updated_at
    ) VALUES (
      '${projectId}',
      '${articleId}',
      TRUE,
      FALSE,
      TIMESTAMPTZ '2026-04-02 12:00:00+00',
      NULL
    )
  `)
  await runDatabase(`
    INSERT INTO app.judgment (
      id,
      article_id,
      prompt_id,
      model_id,
      project_id,
      snapshot_project_id,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images,
      is_answered,
      answered_original,
      answered_original_as_array,
      confidence_original
    ) VALUES (
      'judgment-${projectId}',
      '${articleId}',
      'prompt-${projectId}',
      'model-${projectId}',
      '${projectId}',
      '${projectId}',
      TRUE,
      TRUE,
      FALSE,
      FALSE,
      TRUE,
      'yes',
      ['yes'],
      90
    )
  `)

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.queuedProjectRefreshCount).toBe(0)
  expect(body.data.indexing.queuedArticleRefreshCount).toBe(0)
  expect(body.data.indexing.pendingRefreshCount).toBe(0)
  expect(body.data.indexing.progressState).toBe('stalled')
  expect(body.data.indexing.serving).toMatchObject({readable: false, usable: false})
  expect(body.data.indexing.status).toBe('stale')
})

test.skip('retired legacy mart diagnostics: queued article refreshes do not gate V4 repair', async () => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  const projectId = 'project-queued-article-refresh-blocks-v4-repair'
  const articleId = `article-${projectId}`

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {dirtyToken: 1, lastCompletedDirtyToken: 1, refreshStatus: 'idle'})
  await insertDirtyArticleRefreshState(projectId, articleId, 2)
  await runDatabase(`
    INSERT INTO mart.project_scope_article (
      project_id,
      article_id,
      in_curated_scope,
      in_route_scope,
      article_created_at,
      article_updated_at
    ) VALUES (
      '${projectId}',
      '${articleId}',
      TRUE,
      FALSE,
      TIMESTAMPTZ '2026-04-02 12:00:00+00',
      NULL
    )
  `)

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(await getReviewRebuildRequestCount(projectId)).toBe(0)
  expect(body.data.indexing.queuedArticleRefreshCount).toBe(1)
  expect(body.data.indexing.queuedRefreshCount).toBe(1)
})

test.skip('retired legacy mart diagnostics: ledger and worker progress state', async () => {
  if (!runDatabase || !setProgressSnapshotForTests) {
    throw new Error('Test dependencies not initialized')
  }

  const projectId = 'project-refreshing-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {
    dirtyToken: 2,
    lastCompletedDirtyToken: 1,
    lastRequestedAt: '2026-04-02T12:00:00.000Z',
    lastStartedAt: '2026-04-02T12:05:00.000Z',
    leaseExpiresAt: '2035-04-02T12:05:30.000Z',
    refreshStatus: 'running',
  })
  await insertActiveReviewServingManifest({
    includeSearchState: false,
    optionalComponents: [],
    projectId,
    snapshotId: 'snapshot-refreshing-warning',
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

test.skip('retired legacy mart diagnostics: ledger-only running project refreshes without V4 state', async () => {
  const projectId = 'project-ledger-only-running-refresh-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {
    dirtyToken: 2,
    lastCompletedDirtyToken: 1,
    lastRequestedAt: '2026-04-02T12:00:00.000Z',
    lastStartedAt: '2026-04-02T12:05:00.000Z',
    leaseExpiresAt: '2035-04-02T12:05:30.000Z',
    refreshStatus: 'running',
    workerId: 'maintenance-worker-ledger-only',
  })

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.activeConsumerCount).toBe(1)
  expect(body.data.indexing.activeWorkCount).toBe(1)
  expect(body.data.indexing.inFlightProjectRefreshCount).toBe(1)
  expect(body.data.indexing.pendingProjectRefreshCount).toBe(1)
  expect(body.data.indexing.pendingRefreshCount).toBe(1)
  expect(body.data.indexing.progressState).toBe('processing')
  expect(body.data.indexing.serving).toMatchObject({readable: false, usable: false})
  expect(body.data.indexing.status).toBe('refreshing')
})

test.skip('retired legacy mart diagnostics: dirty articles in live project scope', async () => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  const projectId = 'project-live-scope-dirty-warning'
  const articleId = `article-${projectId}`
  const staleArticleId = `article-${projectId}-stale`

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {dirtyToken: 2, lastCompletedDirtyToken: 1, refreshStatus: 'idle'})
  await insertActiveReviewServingManifest({
    includeSearchState: false,
    optionalComponents: [],
    projectId,
    snapshotId: 'snapshot-live-scope-dirty-warning',
  })
  await runDatabase(`
    INSERT INTO app.import_route (id, route, name, active)
    VALUES ('route-${projectId}', 'route-${projectId}', 'Live Scope Route', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project_import_route (id, project_id, import_route_id)
    VALUES ('project-route-${projectId}', '${projectId}', 'route-${projectId}')
  `)
  await runDatabase(`
    INSERT INTO app.article_import_route (id, article_id, import_route_id)
    VALUES ('article-route-${projectId}', '${articleId}', 'route-${projectId}')
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('${staleArticleId}', 'Stale dirty article')
  `)
  await insertDirtyArticleRefreshState(projectId, articleId, 2)
  await insertDirtyArticleRefreshState(projectId, staleArticleId, 2)

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.queuedArticleRefreshCount).toBe(1)
  expect(body.data.indexing.pendingArticleRefreshCount).toBe(1)
  expect(body.data.indexing.pendingRefreshCount).toBe(2)
  expect(body.data.indexing.status).toBe('refreshing')
})

test('reviews warnings request bounded V4 repair when fresh idle serving is missing outside the foreground response', async () => {
  const projectId = 'project-missing-serving-bootstrap-warning'

  await insertProjectFixture(projectId)

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.scope.hasAnyArticlesInScope).toBe(true)
  expect(body.data.indexing.largeRebuild).toBe(null)
  expect(body.data.indexing.pendingRefreshCount).toBe(0)
  expect(body.data.indexing.progressState).toBe('stalled')
  expect(body.data.indexing.queuedProjectRefreshCount).toBe(0)
  expect(body.data.indexing.serving).toMatchObject({readable: false, usable: false})
  expect(body.data.indexing.status).toBe('stale')
})

test('reviews warnings request bounded V4 repair for stale idle legacy no-work state outside the foreground response', async () => {
  const projectId = 'project-missing-serving-stale-idle-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {
    dirtyToken: 2,
    lastCompletedDirtyToken: 1,
    lastRequestedAt: '2026-04-02T12:00:00.000Z',
    refreshStatus: 'idle',
  })

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.activeWorkCount).toBe(0)
  expect(body.data.indexing.queuedRefreshCount).toBe(0)
  expect(body.data.indexing.pendingRefreshCount).toBe(0)
  expect(body.data.indexing.progressState).toBe('stalled')
  expect(body.data.indexing.serving).toMatchObject({readable: false, usable: false})
  expect(body.data.indexing.status).toBe('stale')
})

test.skip('retired legacy mart diagnostics: queued dirty materializations before missing snapshot repair', async () => {
  const projectId = 'project-missing-serving-pending-dirty-materialization-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {dirtyToken: 2, lastCompletedDirtyToken: 1, refreshStatus: 'idle'})
  await insertDirtyMaterializationState({
    projectId,
    sourceKind: 'project_scope',
    status: 'pending',
    targetDirtyToken: 2,
  })

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.dirtyMaterialization).toMatchObject({failedCount: 0, pendingCount: 1})
  expect(body.data.indexing.pendingRefreshCount).toBeGreaterThan(0)
  expect(body.data.indexing.progressState).toBe('queued')
  expect(body.data.indexing.status).toBe('refreshing')
  expect(await getReviewRebuildRequestCount(projectId)).toBe(0)
})

test.skip('retired legacy mart diagnostics: running dirty materializations before missing snapshot repair', async () => {
  const projectId = 'project-missing-serving-running-dirty-materialization-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {dirtyToken: 2, lastCompletedDirtyToken: 1, refreshStatus: 'idle'})
  await insertDirtyMaterializationState({
    leaseExpiresAt: '2026-04-02T11:59:00.000Z',
    materializationOwner: null,
    projectId,
    sourceKind: 'project_scope',
    status: 'running',
    targetDirtyToken: 2,
  })

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.dirtyMaterialization).toMatchObject({activeOwnerCount: 0, runningCount: 1})
  expect(body.data.indexing.pendingRefreshCount).toBeGreaterThan(0)
  expect(body.data.indexing.progressState).toBe('queued')
  expect(body.data.indexing.status).toBe('refreshing')
  expect(await getReviewRebuildRequestCount(projectId)).toBe(0)
})

test.skip('retired legacy mart diagnostics: expired running legacy refresh before missing snapshot repair', async () => {
  const projectId = 'project-missing-serving-expired-running-refresh-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {
    dirtyToken: 2,
    lastCompletedDirtyToken: 1,
    lastStartedAt: '2026-04-02T11:58:00.000Z',
    leaseExpiresAt: '2026-04-02T11:59:00.000Z',
    refreshStatus: 'running',
  })

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.activeWorkCount).toBe(0)
  expect(body.data.indexing.pendingProjectRefreshCount).toBe(1)
  expect(body.data.indexing.pendingRefreshCount).toBe(1)
  expect(body.data.indexing.progressState).toBe('queued')
  expect(body.data.indexing.status).toBe('refreshing')
  expect(await getReviewRebuildRequestCount(projectId)).toBe(0)
})

test('reviews warnings report blocked V4 repair without retrying terminal missing snapshot work', async () => {
  const projectId = 'project-missing-serving-blocked-bootstrap-warning'

  await insertProjectFixture(projectId)
  await insertReviewRebuildRequest({
    createdAt: '2026-04-02T12:00:00.000Z',
    projectId,
    requestId: 'request-missing-serving-blocked-bootstrap-warning',
    status: 'blocked_over_budget',
    updatedAt: '2026-04-02T12:00:00.000Z',
  })
  await insertReviewRebuildChunk({
    chunkId: 'chunk-missing-serving-blocked-bootstrap-warning',
    createdAt: '2026-04-02T12:00:00.000Z',
    projectId,
    requestId: 'request-missing-serving-blocked-bootstrap-warning',
    status: 'blocked_over_budget',
    updatedAt: '2026-04-02T12:00:00.000Z',
  })

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.pendingRefreshCount).toBe(0)
  expect(body.data.indexing.progressState).toBe('failed')
  expect(body.data.indexing.status).toBe('failed')
  expect(await getReviewRebuildRequestCount(projectId)).toBe(0)
})

test('reviews warnings ignore stale terminal chunks after same request is re-admitted', async () => {
  const projectId = 'project-readmitted-request-stale-terminal-warning'
  const requestId = 'request-readmitted-request-stale-terminal-warning'

  await insertProjectFixture(projectId)
  await insertReviewRebuildRequest({
    createdAt: '2026-04-02T12:00:00.000Z',
    projectId,
    requestId,
    status: 'admitted',
    updatedAt: '2026-04-02T12:10:00.000Z',
  })
  await insertReviewRebuildChunk({
    chunkId: 'chunk-readmitted-request-stale-terminal-warning',
    createdAt: '2026-04-02T12:00:00.000Z',
    projectId,
    requestId,
    status: 'blocked_over_budget',
    updatedAt: '2026-04-02T12:00:00.000Z',
  })
  await insertReviewRebuildChunk({
    chunkId: 'chunk-readmitted-request-pending-warning',
    createdAt: '2026-04-02T12:10:00.000Z',
    projectId,
    requestId,
    status: 'pending',
    updatedAt: '2026-04-02T12:10:00.000Z',
  })

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.pendingRefreshCount).toBeGreaterThan(0)
  expect(body.data.indexing.progressState).toBe('queued')
  expect(body.data.indexing.status).toBe('refreshing')
})

test.skip('retired legacy mart diagnostics: fresh idle route scope before V4 repair', async () => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  const projectId = 'project-fresh-idle-route-scope-missing-v4-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {dirtyToken: 4, lastCompletedDirtyToken: 4, refreshStatus: 'idle'})
  await runDatabase(`
    DELETE FROM app.project_article
    WHERE project_id = '${projectId}'
  `)
  await runDatabase(`
    INSERT INTO app.import_route (id, route, name, active)
    VALUES ('route-${projectId}', 'route-${projectId}', 'Route Scope', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project_import_route (id, project_id, import_route_id)
    VALUES ('project-route-${projectId}', '${projectId}', 'route-${projectId}')
  `)
  await runDatabase(`
    INSERT INTO app.article_import_route (id, article_id, import_route_id)
    VALUES ('article-route-${projectId}', 'article-${projectId}', 'route-${projectId}')
  `)

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.scope.hasAnyArticlesInScope).toBe(true)
  expect(body.data.indexing.freshness.isFresh).toBe(true)
  expect(body.data.indexing.pendingRefreshCount).toBe(0)
  expect(body.data.indexing.progressState).toBe('stalled')
  expect(body.data.indexing.serving).toMatchObject({readable: false, usable: false})
  expect(body.data.indexing.status).toBe('stale')
})

test('reviews warnings do not bootstrap missing serving rows for archived prompt links', async () => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  const projectId = 'project-archived-prompt-link-bootstrap-warning'

  await insertProjectFixture(projectId)
  await runDatabase(`
    UPDATE app.project_prompt
    SET archived = TRUE
    WHERE id = 'project-prompt-${projectId}'
  `)

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.enabledPromptCount).toBe(0)
  expect(body.data.scope.hasAnyArticlesInScope).toBe(true)
  expect(body.data.indexing.largeRebuild).toBe(null)
  expect(body.data.indexing.pendingRefreshCount).toBe(0)
  expect(body.data.indexing.progressState).toBe('completed')
  expect(body.data.indexing.status).toBe('not-needed')
})

test('reviews warnings do not bootstrap missing serving rows for archived prompts', async () => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  const projectId = 'project-archived-prompt-bootstrap-warning'

  await insertProjectFixture(projectId)
  await runDatabase(`
    UPDATE app.prompt
    SET archived = TRUE
    WHERE id = 'prompt-${projectId}'
  `)

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.enabledPromptCount).toBe(0)
  expect(body.data.scope.hasAnyArticlesInScope).toBe(true)
  expect(body.data.indexing.largeRebuild).toBe(null)
  expect(body.data.indexing.pendingRefreshCount).toBe(0)
  expect(body.data.indexing.progressState).toBe('completed')
  expect(body.data.indexing.status).toBe('not-needed')
})

test('reviews warnings wait for candidate serving generation before queueing bootstrap rebuild', async () => {
  const projectId = 'project-candidate-serving-bootstrap-warning'

  await insertProjectFixture(projectId)
  await insertActiveReviewServingManifest({
    includeSearchState: false,
    optionalComponents: [],
    projectId,
    snapshotId: 'snapshot-candidate-bootstrap-warning',
    status: 'candidate',
  })

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.scope.hasAnyArticlesInScope).toBe(true)
  expect(body.data.indexing.largeRebuild).toBe(null)
  expect(body.data.indexing.pendingRefreshCount).toBe(0)
  expect(body.data.indexing.progressState).toBe('stalled')
  expect(body.data.indexing.status).toBe('stale')
})

test('reviews warnings wait for failed serving generation before queueing bootstrap rebuild', async () => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  const projectId = 'project-failed-serving-bootstrap-warning'

  await insertProjectFixture(projectId)
  await runDatabase(`
    INSERT INTO app.review_serving_dirty_work (
      dirty_work_id,
      project_id,
      scope_kind,
      scope_id,
      article_id,
      dirty_kind,
      source_partition,
      first_source_high_water_mark,
      latest_source_high_water_mark,
      status
    ) VALUES (
      'dirty-work-${projectId}',
      '${projectId}',
      'article',
      'article-${projectId}',
      'article-${projectId}',
      'review-change',
      'review-change:${projectId}',
      1,
      1,
      'failed'
    )
  `)

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.scope.hasAnyArticlesInScope).toBe(true)
  expect(body.data.indexing.largeRebuild).toBe(null)
  expect(body.data.indexing.pendingRefreshCount).toBe(1)
  expect(body.data.indexing.queuedProjectRefreshCount).toBe(0)
  expect(body.data.indexing.progressState).toBe('failed')
  expect(body.data.indexing.status).toBe('failed')
})

test('reviews warnings do not queue bootstrap rebuild for articles outside project dates', async () => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  const projectId = 'project-date-bounded-bootstrap-warning'

  await insertProjectFixture(projectId)
  await runDatabase(`
    UPDATE app.project
    SET date_from = TIMESTAMPTZ '2026-05-01T00:00:00.000Z'
    WHERE id = '${projectId}'
  `)
  await runDatabase(`
    UPDATE app.article
    SET article_created_at = TIMESTAMPTZ '2026-04-01T00:00:00.000Z'
    WHERE id = 'article-${projectId}'
  `)

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.scope.hasAnyArticlesInScope).toBe(false)
  expect(body.data.indexing.largeRebuild).toBe(null)
  expect(body.data.indexing.pendingRefreshCount).toBe(0)
  expect(body.data.indexing.progressState).toBe('completed')
  expect(body.data.indexing.status).toBe('not-needed')
})

test.skip('retired legacy maintenance lease diagnostics: fresh persisted article leases', async () => {
  const projectId = 'project-persisted-article-lease-warning'

  await insertProjectFixture(projectId)
  await insertDirtyArticleRefreshState(projectId, `article-${projectId}`, 1)
  await insertFreshArticleRefreshLease(projectId, `article-${projectId}`)

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.activeConsumerCount).toBe(1)
  expect(body.data.indexing.inFlightArticleRefreshCount).toBe(1)
  expect(body.data.indexing.queuedArticleRefreshCount).toBe(0)
  expect(body.data.indexing.progressState).toBe('processing')
  expect(body.data.indexing.lastStartedAt).toBe('2026-04-02 12:05:00+00')
  expect(body.data.indexing.lastProgressedAt).toBe('2026-04-02 12:05:15+00')
})

test.skip('retired legacy maintenance lease diagnostics: active project-scoped claims', async () => {
  const projectId = 'project-active-claim-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {
    dirtyToken: 2,
    lastCompletedDirtyToken: 1,
    lastRequestedAt: '2026-04-02T12:00:00.000Z',
    lastStartedAt: '2026-04-02T12:05:00.000Z',
    leaseExpiresAt: '2035-04-02T12:05:30.000Z',
    refreshStatus: 'running',
    workerId: 'maintenance-worker-active-claim',
  })
  await insertActiveReviewServingManifest({
    includeSearchState: false,
    optionalComponents: [],
    projectId,
    snapshotId: 'snapshot-active-claim-warning',
  })
  await insertDirtyArticleRefreshState(projectId, `article-${projectId}`, 2)

  const {body, response} = await withServerMutationsDisabled(() => {
    return postWarningsRequest(projectId)
  })

  expect(response.status).toBe(200)
  expect(body.data.indexing.activeConsumerCount).toBe(1)
  expect(body.data.indexing.activeWorkCount).toBe(2)
  expect(body.data.indexing.blockedReason).toBe(null)
  expect(body.data.indexing.eligibleConsumerCount).toBe(0)
  expect(body.data.indexing.eligibleConsumerPresent).toBe(false)
  expect(body.data.indexing.inFlightArticleRefreshCount).toBe(1)
  expect(body.data.indexing.inFlightProjectRefreshCount).toBe(1)
  expect(body.data.indexing.lastProgressedAt).not.toBe(null)
  expect(body.data.indexing.progressState).toBe('processing')
  expect(body.data.indexing.status).toBe('refreshing')
})

test.skip('retired legacy mart diagnostics: failed refresh with dirty work', async () => {
  const projectId = 'project-failed-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {
    dirtyToken: 3,
    lastCompletedDirtyToken: 2,
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

test.skip('retired legacy mart diagnostics: failed dirty materializations without V4 state', async () => {
  const projectId = 'project-failed-dirty-materialization-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {
    dirtyToken: 2,
    lastCompletedDirtyToken: 1,
    lastRequestedAt: '2026-04-02T12:00:00.000Z',
    refreshStatus: 'idle',
  })
  await insertDirtyMaterializationState({projectId, sourceKind: 'project_scope', status: 'failed', targetDirtyToken: 2})
  await insertDirtyMaterializationState({
    projectId,
    sourceKind: 'review_facts',
    status: 'unreconciled',
    targetDirtyToken: 2,
  })

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.dirtyMaterialization).toMatchObject({failedCount: 1, unreconciledCount: 1})
  expect(body.data.indexing.pendingProjectRefreshCount).toBe(1)
  expect(body.data.indexing.pendingRefreshCount).toBe(1)
  expect(body.data.indexing.progressState).toBe('failed')
  expect(body.data.indexing.status).toBe('failed')
})

test.skip('retired legacy maintenance lease diagnostics: expired running leases', async () => {
  const projectId = 'project-expired-lease-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {
    dirtyToken: 2,
    lastCompletedDirtyToken: 1,
    lastRequestedAt: '2026-04-02T12:00:00.000Z',
    lastStartedAt: '2026-04-02T12:05:00.000Z',
    leaseExpiresAt: '2026-04-02T12:05:30.000Z',
    refreshStatus: 'running',
  })
  await insertActiveReviewServingManifest({
    includeSearchState: false,
    optionalComponents: [],
    projectId,
    snapshotId: 'snapshot-expired-lease-warning',
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

test.skip('retired legacy owner diagnostics: pending work without local refresh consumer', async () => {
  const projectId = 'project-blocked-no-consumer-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {
    dirtyToken: 2,
    lastCompletedDirtyToken: 1,
    lastRequestedAt: '2026-04-02T12:00:00.000Z',
    refreshStatus: 'idle',
  })
  await insertActiveReviewServingManifest({
    includeSearchState: false,
    optionalComponents: [],
    projectId,
    snapshotId: 'snapshot-blocked-no-consumer-warning',
  })

  const {body, response} = await withServerMutationsDisabled(() => {
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

test.skip('retired legacy owner diagnostics: mart refresh drain disabled by memory policy', async () => {
  const projectId = 'project-blocked-low-memory-warning'
  const previousDuckdbMemoryLimit = process.env.DUCKDB_MEMORY_LIMIT

  process.env.DUCKDB_MEMORY_LIMIT = '5120MiB'

  try {
    await insertProjectFixture(projectId)
    await insertProjectRefreshState(projectId, {
      dirtyToken: 2,
      lastCompletedDirtyToken: 1,
      lastRequestedAt: '2026-04-02T12:00:00.000Z',
      refreshStatus: 'idle',
    })
    await insertActiveReviewServingManifest({
      includeSearchState: false,
      optionalComponents: [],
      projectId,
      snapshotId: 'snapshot-blocked-low-memory-warning',
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

test('reviews warnings keep V4 rebuild chunks refreshable when memory policy disables mart refresh drain', async () => {
  const projectId = 'project-v4-rebuild-low-memory-warning'
  const previousDuckdbMemoryLimit = process.env.DUCKDB_MEMORY_LIMIT

  process.env.DUCKDB_MEMORY_LIMIT = '5120MiB'

  try {
    await insertProjectFixture(projectId)
    await insertProjectRefreshState(projectId, {dirtyToken: 1, lastCompletedDirtyToken: 1, refreshStatus: 'idle'})
    await insertReviewServingRow(projectId, `article-${projectId}`)
    await insertActiveReviewServingManifest({
      includeSearchState: false,
      optionalComponents: [],
      projectId,
      snapshotId: 'snapshot-v4-low-memory-warning',
    })
    await insertReviewRebuildChunk({
      chunkId: 'rebuild-chunk-v4-low-memory-warning',
      createdAt: '2026-04-02T12:00:00.000Z',
      projectId,
      status: 'pending',
      updatedAt: '2026-04-02T12:00:00.000Z',
    })

    const {body, response} = await postWarningsRequest(projectId)

    expect(response.status).toBe(200)
    expect(body.data.indexing.blockedReason).toBe(null)
    expect(body.data.indexing.eligibleConsumerCount).toBe(1)
    expect(body.data.indexing.eligibleConsumerPresent).toBe(true)
    expect(body.data.indexing.pendingProjectRefreshCount).toBe(1)
    expect(body.data.indexing.pendingRefreshCount).toBe(1)
    expect(body.data.indexing.progressState).toBe('queued')
    expect(body.data.indexing.queuedRefreshCount).toBe(1)
    expect(body.data.indexing.status).toBe('refreshing')
  } finally {
    if (previousDuckdbMemoryLimit === undefined) {
      delete process.env.DUCKDB_MEMORY_LIMIT
    } else {
      process.env.DUCKDB_MEMORY_LIMIT = previousDuckdbMemoryLimit
    }
  }
})

test('reviews warnings ignore failed legacy large rebuild state while requesting V4 repair outside the foreground response', async () => {
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
  expect(body.data.indexing.largeRebuild).toBe(null)
  expect(body.data.indexing.pendingProjectRefreshCount).toBe(0)
  expect(body.data.indexing.pendingRefreshCount).toBe(0)
  expect(body.data.indexing.progressState).toBe('stalled')
  expect(body.data.indexing.serving).toMatchObject({readable: false, usable: false})
  expect(body.data.indexing.status).toBe('stale')
})

test('reviews warnings keep active serving ready when legacy large rebuild has failed', async () => {
  const projectId = 'project-active-serving-legacy-large-rebuild-failed-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {dirtyToken: 1, lastCompletedDirtyToken: 1, refreshStatus: 'idle'})
  await insertReviewServingRow(projectId, `article-${projectId}`)
  await insertActiveReviewServingManifest({
    includeSearchState: false,
    optionalComponents: [],
    projectId,
    snapshotId: 'snapshot-active-serving-legacy-large-rebuild-failed-warning',
  })
  await insertLargeRebuildState(projectId, {
    rebuildPhase: 'prompt_answer_fact',
    refreshStatus: 'failed',
    refreshToken: 5,
    lastError: 'Out of Memory Error: failed to pin block',
  })

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.largeRebuild).toBe(null)
  expect(body.data.indexing.pendingRefreshCount).toBe(0)
  expect(body.data.indexing.progressState).toBe('completed')
  expect(body.data.indexing.status).toBe('ready')
})

test('reviews warnings production api path remains owner-routed unless an ownerless backend is declared', async () => {
  const {classifyApiRoute, shouldApiRouteProxyToDuckdbOwner} = await import('../apiRouteClassification.ts')
  const classification = classifyApiRoute('/api/projectsreviewswarnings', 'POST')

  expect(classification).toBe('owner-dependent')
  expect(shouldApiRouteProxyToDuckdbOwner(classification)).toBe(true)
})
