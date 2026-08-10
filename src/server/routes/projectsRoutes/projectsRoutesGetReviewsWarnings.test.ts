import {rmSync, writeFileSync} from 'node:fs'

import {afterAll, beforeAll, expect, test} from 'bun:test'
import {Elysia} from 'elysia'

import {buildPromptConfigHash, buildReviewConfigHash} from '../../reviewServing/reviewProjectionIdentity.ts'
import type {ReviewServingProjectionComponent} from '../../reviewServing/reviewServingContracts.ts'
import {createTempRuntimeRoot} from '../../test/createTempRuntimeRoot.ts'
import {prepareDuckdbExclusiveWork, resetDuckdbExclusiveWorkForTests} from '../../utils/duckdbExclusiveWork.ts'

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
      blockedReason:
        | 'duckdb_exclusive_work_active'
        | 'operator_intervention_required'
        | 'paused_by_policy'
        | 'quarantine_barrier'
        | 'waiting_for_maintenance_worker'
        | null
      cleanup: {inFlightGenerationCleanupCount: number; lastProgressedAt: string | null}
      coverage: {
        detailReadyArticleCount: number | null
        reviewPageReadyArticleCount: number
        searchReadyArticleCount: number | null
        totalArticleCount: number
      }
      eligibleConsumerCount: number
      eligibleConsumerPresent: boolean
      inFlightArticleRefreshCount: number
      inFlightProjectRefreshCount: number
      inFlightRefreshCount: number
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
        diagnostics: {
          rebuildChunks: {
            blockedQueuedCount?: number
            claimableCount?: number
            expiredLeaseCount?: number
            failedCount: number
            pendingCount: number
            quarantinedCount?: number
            terminalQuarantinedCount?: number
          }
          quarantine: {quarantinedOutboxCount: number; retryableOutboxCount: number; unresolvedOutboxCount: number}
        }
        readable: boolean
        usable: boolean
      }
      status: 'blocked' | 'failed' | 'not-needed' | 'ready' | 'refreshing' | 'stale'
    }
    projectId: string
    scope: {hasAnyArticlesInScope: boolean}
  }
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
type ReviewRebuildRequestStatus = 'admitted' | 'blocked_over_budget' | 'completed' | 'failed'

let app: {handle: (request: Request) => Promise<Response>} | null = null
let closeDatabase: (() => Promise<void>) | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null

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

const insertReviewSourceChangeOutbox = async (projectId: string, status: 'pending' | 'quarantined' = 'pending') => {
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
      '${status}',
      TIMESTAMPTZ '2026-04-02T12:00:00.000Z',
      TIMESTAMPTZ '2026-04-02T12:00:00.000Z'
    )
  `)
}

const insertReviewServingRow = async (projectId: string, articleId: string) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }
  void articleId

  await runDatabase(`
    INSERT INTO app.project_review_serving_generation (project_id, active_generation)
    VALUES ('${projectId}', 1)
  `)
}

const insertReviewRebuildChunk = async (input: {
  chunkId: string
  component?: ReviewServingProjectionComponent
  createdAt: string
  lastError?: string | null
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

  const component = input.component ?? 'summary'

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
      last_error,
      retry_after,
      created_at,
      updated_at
    ) VALUES (
      '${input.chunkId}',
      ${input.requestId === undefined || input.requestId === null ? 'NULL' : `'${input.requestId}'`},
      '${input.projectId}',
      '${component}',
      '${component}:identity-1',
      '${component}-digest-v1',
      1,
      'article-a',
      'article-z',
      1,
      '${input.status}',
      ${input.leaseOwner === undefined || input.leaseOwner === null ? 'NULL' : `'${input.leaseOwner}'`},
      ${input.leaseExpiresAt === undefined || input.leaseExpiresAt === null ? 'NULL' : `TIMESTAMPTZ '${input.leaseExpiresAt}'`},
      ${input.lastError === undefined || input.lastError === null ? 'NULL' : `'${input.lastError.replaceAll("'", "''")}'`},
      ${input.retryAfter === undefined || input.retryAfter === null ? 'NULL' : `TIMESTAMPTZ '${input.retryAfter}'`},
      TIMESTAMPTZ '${input.createdAt}',
      TIMESTAMPTZ '${input.updatedAt}'
    )
  `)
}

const insertReviewRebuildRequest = async (input: {
  completedAt?: string | null
  createdAt: string
  failedAt?: string | null
  lastError?: string | null
  priority?: number
  projectId: string
  reason?: string
  requestId: string
  requestedComponents?: readonly ReviewServingProjectionComponent[]
  status: ReviewRebuildRequestStatus
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
      priority,
      status,
      admission_state,
      retry_policy_json,
      over_budget_reason,
      diagnostics_json,
      admitted_at,
      completed_at,
      failed_at,
      last_error,
      created_at,
      updated_at
    ) VALUES (
      '${input.requestId}',
      '${input.projectId}',
      '${input.reason ?? 'test'}',
      '${JSON.stringify(input.requestedComponents ?? ['summary']).replaceAll("'", "''")}'::JSON,
      '{}'::JSON,
      '{}'::JSON,
      ${input.priority ?? 100},
      '${input.status}',
      ${input.status === 'blocked_over_budget' ? "'blocked_over_budget'" : "'admitted'"},
      '{}'::JSON,
      ${input.status === 'blocked_over_budget' ? "'test over budget'" : 'NULL'},
      '{}'::JSON,
      ${input.status === 'admitted' || input.status === 'completed' || input.status === 'failed' ? `TIMESTAMPTZ '${input.createdAt}'` : 'NULL'},
      ${input.completedAt === undefined || input.completedAt === null ? 'NULL' : `TIMESTAMPTZ '${input.completedAt}'`},
      ${input.failedAt === undefined || input.failedAt === null ? 'NULL' : `TIMESTAMPTZ '${input.failedAt}'`},
      ${input.lastError === undefined || input.lastError === null ? 'NULL' : `'${input.lastError.replaceAll("'", "''")}'`},
      TIMESTAMPTZ '${input.createdAt}',
      TIMESTAMPTZ '${input.updatedAt}'
    )
  `)
}

const getReviewRebuildRequestMetadata = async (requestId: string) => {
  const {getAppDatabaseService} = await import('../../services/appDatabaseService.ts')
  const [row] = await getAppDatabaseService().queryJson<{priority: number; updatedAt: string}>(`
    SELECT priority, updated_at AS updatedAt
    FROM app.review_rebuild_request
    WHERE request_id = '${requestId}'
  `)

  if (row === undefined) {
    throw new Error(`Missing review rebuild request ${requestId}`)
  }

  return {priority: Number(row.priority), updatedAt: row.updatedAt}
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
  selectedImportSnapshotId?: string | null
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
      selected_import_snapshot_id,
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
      ${input.selectedImportSnapshotId === undefined || input.selectedImportSnapshotId === null ? 'NULL' : `'${input.selectedImportSnapshotId}'`},
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

const withReviewServingProjectorPaused = async <_T>(work: () => Promise<_T>) => {
  const pauseMarkerPath = `${tempDbPath}.review-serving-projector-paused`
  writeFileSync(pauseMarkerPath, 'operator recovery pause')

  try {
    return await work()
  } finally {
    rmSync(pauseMarkerPath, {force: true})
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

  await database.maintenance('checkpoint')

  closeDatabase = () => {
    return database.close()
  }
  runDatabase = (statement: string) => {
    return database.run(statement)
  }
  app = new Elysia().use(projectsRoutesGetReviewsWarnings)
})

test('reviews warnings block invalid candidate snapshots that cannot be activated safely', async () => {
  const projectId = 'project-candidate-invalid-selected-import-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {dirtyToken: 1, lastCompletedDirtyToken: 1, refreshStatus: 'idle'})
  await insertReviewServingRow(projectId, `article-${projectId}`)
  await insertActiveReviewServingManifest({
    includeSearchState: false,
    optionalComponents: [],
    projectId,
    selectedImportSnapshotId: 'selected-import-candidate-warning',
    snapshotId: 'snapshot-candidate-invalid-selected-import-warning',
    status: 'candidate',
  })
  await runDatabase?.(`
    INSERT INTO app.review_selected_import_snapshot (
      selected_import_snapshot_id,
      project_id,
      project_scope_identity,
      source_delta_high_water,
      status,
      updated_at
    ) VALUES (
      'selected-import-candidate-warning',
      '${projectId}',
      'projectScope:identity-1',
      1,
      'candidate',
      current_timestamp
    )
  `)

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.activeWorkCount).toBe(0)
  expect(body.data.indexing.blockedReason).toBe('operator_intervention_required')
  expect(body.data.indexing.pendingRefreshCount).toBe(0)
  expect(body.data.indexing.progressState).toBe('blocked')
  expect(body.data.indexing.status).toBe('blocked')
})

test('reviews warnings keep invalid bootstrap candidates refreshing while rebuild chunks can progress', async () => {
  const projectId = 'project-candidate-invalid-selected-import-progressing-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {dirtyToken: 1, lastCompletedDirtyToken: 1, refreshStatus: 'idle'})
  await insertReviewServingRow(projectId, `article-${projectId}`)
  await insertActiveReviewServingManifest({
    includeSearchState: false,
    optionalComponents: [],
    projectId,
    selectedImportSnapshotId: 'selected-import-candidate-progressing-warning',
    snapshotId: 'snapshot-candidate-invalid-selected-import-progressing-warning',
    status: 'candidate',
  })
  await runDatabase?.(`
    INSERT INTO app.review_selected_import_snapshot (
      selected_import_snapshot_id,
      project_id,
      project_scope_identity,
      source_delta_high_water,
      status,
      updated_at
    ) VALUES (
      'selected-import-candidate-progressing-warning',
      '${projectId}',
      'projectScope:identity-1',
      1,
      'candidate',
      current_timestamp
    )
  `)
  await insertReviewRebuildChunk({
    chunkId: 'chunk-candidate-invalid-selected-import-progressing-warning',
    component: 'selectedImport',
    createdAt: '2026-06-23T10:00:00.000Z',
    projectId,
    status: 'pending',
    updatedAt: '2026-06-23T10:00:00.000Z',
  })

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.blockedReason).toBe(null)
  expect(body.data.indexing.pendingRefreshCount).toBe(1)
  expect(body.data.indexing.progressState).toBe('queued')
  expect(body.data.indexing.status).toBe('refreshing')
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

test('reviews warnings preserve failed latest terminal rebuild request behind serving rows', async () => {
  const projectId = 'project-latest-terminal-rebuild-failed-with-serving-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {dirtyToken: 1, lastCompletedDirtyToken: 1, refreshStatus: 'idle'})
  await insertReviewServingRow(projectId, `article-${projectId}`)
  await insertActiveReviewServingManifest({
    includeSearchState: false,
    optionalComponents: [],
    projectId,
    snapshotId: 'snapshot-latest-terminal-rebuild-failed-with-serving-warning',
  })
  await insertReviewRebuildRequest({
    createdAt: '2026-04-02T12:00:00.000Z',
    failedAt: '2026-04-02T12:01:00.000Z',
    lastError: 'foreground rebuild failed',
    projectId,
    requestId: 'request-latest-terminal-rebuild-failed-with-serving-warning',
    status: 'failed',
    updatedAt: '2026-04-02T12:01:00.000Z',
  })

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.pendingRefreshCount).toBe(0)
  expect(body.data.indexing.progressState).toBe('failed')
  expect(body.data.indexing.serving.diagnostics.rebuildChunks).toMatchObject({failedCount: 1, pendingCount: 0})
  expect(body.data.indexing.serving).toMatchObject({readable: true, usable: true})
  expect(body.data.indexing.status).toBe('failed')
})

test('reviews warnings ignore failed requestless bootstrap bookkeeping behind serving rows', async () => {
  const projectId = 'project-requestless-bootstrap-terminal-with-serving-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {dirtyToken: 1, lastCompletedDirtyToken: 1, refreshStatus: 'idle'})
  await insertReviewServingRow(projectId, `article-${projectId}`)
  await insertActiveReviewServingManifest({
    includeSearchState: false,
    optionalComponents: [],
    projectId,
    snapshotId: 'snapshot-requestless-bootstrap-terminal-with-serving-warning',
  })
  await insertReviewRebuildRequest({
    createdAt: '2026-04-02T12:00:00.000Z',
    failedAt: '2026-04-02T12:01:00.000Z',
    lastError: 'superseded requestless bootstrap snapshot',
    projectId,
    reason: 'requestless_bootstrap_rebuild',
    requestId: 'requestless-bootstrap:terminal-with-serving-warning',
    status: 'failed',
    updatedAt: '2026-04-02T12:01:00.000Z',
  })
  await insertReviewRebuildChunk({
    chunkId: 'chunk-requestless-bootstrap-quarantined-with-serving-warning',
    createdAt: '2026-04-02T12:00:00.000Z',
    lastError: 'superseded requestless bootstrap snapshot',
    projectId,
    requestId: 'requestless-bootstrap:terminal-with-serving-warning',
    status: 'quarantined',
    updatedAt: '2026-04-02T12:01:00.000Z',
  })

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.pendingRefreshCount).toBe(0)
  expect(body.data.indexing.progressState).toBe('completed')
  expect(body.data.indexing.serving.diagnostics.rebuildChunks).toMatchObject({
    failedCount: 0,
    pendingCount: 0,
    quarantinedCount: 1,
    terminalQuarantinedCount: 0,
  })
  expect(body.data.indexing.serving).toMatchObject({readable: true, usable: true})
  expect(body.data.indexing.status).toBe('ready')
})

test('reviews warnings do not expose candidate snapshots as readable review pages', async () => {
  const projectId = 'project-candidate-serving-snapshot-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {dirtyToken: 1, lastCompletedDirtyToken: 1, refreshStatus: 'idle'})
  await insertReviewServingRow(projectId, `article-${projectId}`)
  await insertActiveReviewServingManifest({
    includeSearchState: false,
    optionalComponents: [],
    projectId,
    snapshotId: 'snapshot-candidate-serving-warning',
    status: 'candidate',
  })

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.pendingRefreshCount).toBe(1)
  expect(body.data.indexing.progressState).toBe('stalled')
  expect(body.data.indexing.serving).toMatchObject({readable: false, usable: false})
  expect(body.data.indexing.status).toBe('refreshing')
})

test('reviews warnings report review indexing paused while DuckDB exclusive import work is active', async () => {
  const projectId = 'project-candidate-exclusive-import-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {dirtyToken: 1, lastCompletedDirtyToken: 1, refreshStatus: 'idle'})
  await insertReviewServingRow(projectId, `article-${projectId}`)
  await insertActiveReviewServingManifest({
    includeSearchState: false,
    optionalComponents: [],
    projectId,
    snapshotId: 'snapshot-candidate-exclusive-import-warning',
    status: 'candidate',
  })

  const handle = await prepareDuckdbExclusiveWork({
    kind: 'project_transfer_import',
    phase: 'commit',
    sessionId: 'session-exclusive-warning',
  })

  try {
    const {body, response} = await postWarningsRequest(projectId)

    expect(response.status).toBe(200)
    expect(body.data.indexing.blockedReason).toBe('duckdb_exclusive_work_active')
    expect(body.data.indexing.eligibleConsumerPresent).toBe(false)
    expect(body.data.indexing.pendingRefreshCount).toBe(1)
    expect(body.data.indexing.progressState).toBe('blocked')
    expect(body.data.indexing.status).toBe('blocked')
  } finally {
    await handle.release()
    resetDuckdbExclusiveWorkForTests()
  }
})

test('reviews warnings block candidate-only snapshots when server mutation work is disabled', async () => {
  const projectId = 'project-candidate-disabled-mutations-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {dirtyToken: 1, lastCompletedDirtyToken: 1, refreshStatus: 'idle'})
  await insertReviewServingRow(projectId, `article-${projectId}`)
  await insertActiveReviewServingManifest({
    includeSearchState: false,
    optionalComponents: [],
    projectId,
    snapshotId: 'snapshot-candidate-disabled-mutations-warning',
    status: 'candidate',
  })

  const {body, response} = await withServerMutationsDisabled(() => {
    return postWarningsRequest(projectId)
  })

  expect(response.status).toBe(200)
  expect(body.data.indexing.activeWorkCount).toBe(0)
  expect(body.data.indexing.blockedReason).toBe('waiting_for_maintenance_worker')
  expect(body.data.indexing.eligibleConsumerPresent).toBe(false)
  expect(body.data.indexing.pendingRefreshCount).toBe(1)
  expect(body.data.indexing.progressState).toBe('blocked')
  expect(body.data.indexing.queuedRefreshCount).toBe(0)
  expect(body.data.indexing.serving).toMatchObject({readable: false, usable: false})
  expect(body.data.indexing.status).toBe('blocked')
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
    leaseExpiresAt: '2099-04-02T12:05:00.000Z',
    leaseOwner: 'active-maintenance-worker',
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

test('reviews warnings keep fresh serving ready when only obsolete V4 chunks are blocked', async () => {
  const projectId = 'project-v4-fresh-obsolete-blocked-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {dirtyToken: 1, lastCompletedDirtyToken: 1, refreshStatus: 'idle'})
  await insertReviewServingRow(projectId, `article-${projectId}`)
  await insertActiveReviewServingManifest({
    includeSearchState: false,
    optionalComponents: [],
    projectId,
    snapshotId: 'snapshot-v4-fresh-obsolete-blocked-warning',
  })
  await insertReviewRebuildChunk({
    chunkId: 'rebuild-chunk-obsolete-blocked-warning',
    createdAt: '2026-04-02T11:59:00.000Z',
    projectId,
    status: 'blocked_over_budget',
    updatedAt: '2026-04-02T12:02:00.000Z',
  })

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.pendingRefreshCount).toBe(0)
  expect(body.data.indexing.progressState).toBe('completed')
  expect(body.data.indexing.status).toBe('ready')
})

test('reviews warnings report processing for recently progressed queued V4 rebuild chunks', async () => {
  const projectId = 'project-v4-recent-progress-warning'
  const recentProgressAt = new Date().toISOString()

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {dirtyToken: 1, lastCompletedDirtyToken: 1, refreshStatus: 'idle'})
  await insertReviewServingRow(projectId, `article-${projectId}`)
  await insertActiveReviewServingManifest({
    includeSearchState: false,
    optionalComponents: [],
    projectId,
    snapshotId: 'snapshot-v4-recent-progress-warning',
  })
  await insertReviewRebuildChunk({
    chunkId: 'rebuild-chunk-recent-progress-completed-warning',
    createdAt: '2026-04-02T12:00:00.000Z',
    projectId,
    status: 'completed',
    updatedAt: recentProgressAt,
  })
  await insertReviewRebuildChunk({
    chunkId: 'rebuild-chunk-recent-progress-pending-warning',
    createdAt: '2026-04-02T12:01:00.000Z',
    projectId,
    status: 'pending',
    updatedAt: '2026-04-02T12:01:00.000Z',
  })

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.activeConsumerCount).toBe(1)
  expect(body.data.indexing.activeWorkCount).toBe(0)
  expect(body.data.indexing.inFlightRefreshCount).toBe(0)
  expect(body.data.indexing.pendingRefreshCount).toBe(1)
  expect(body.data.indexing.progressState).toBe('processing')
  expect(body.data.indexing.queuedRefreshCount).toBe(1)
  expect(body.data.indexing.status).toBe('refreshing')
})

test('reviews warnings do not report processing for only recently enqueued V4 rebuild chunks', async () => {
  const projectId = 'project-v4-recent-enqueue-warning'
  const recentEnqueuedAt = new Date().toISOString()

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {dirtyToken: 1, lastCompletedDirtyToken: 1, refreshStatus: 'idle'})
  await insertReviewServingRow(projectId, `article-${projectId}`)
  await insertActiveReviewServingManifest({
    includeSearchState: false,
    optionalComponents: [],
    projectId,
    snapshotId: 'snapshot-v4-recent-enqueue-warning',
  })
  await insertReviewRebuildChunk({
    chunkId: 'rebuild-chunk-recent-enqueue-warning',
    createdAt: recentEnqueuedAt,
    projectId,
    status: 'pending',
    updatedAt: recentEnqueuedAt,
  })

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.activeConsumerCount).toBe(0)
  expect(body.data.indexing.activeWorkCount).toBe(0)
  expect(body.data.indexing.inFlightRefreshCount).toBe(0)
  expect(body.data.indexing.pendingRefreshCount).toBe(1)
  expect(body.data.indexing.progressState).toBe('queued')
  expect(body.data.indexing.queuedRefreshCount).toBe(1)
  expect(body.data.indexing.status).toBe('refreshing')
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

test('reviews warnings keep retry-backed V4 rebuild chunk failures out of claimable queued work', async () => {
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
  expect(body.data.indexing.eligibleConsumerCount).toBe(0)
  expect(body.data.indexing.eligibleConsumerPresent).toBe(false)
  expect(body.data.indexing.pendingRefreshCount).toBe(1)
  expect(body.data.indexing.progressState).toBe('stalled')
  expect(body.data.indexing.queuedRefreshCount).toBe(0)
  expect(body.data.indexing.serving.diagnostics.rebuildChunks).toMatchObject({
    blockedQueuedCount: 1,
    claimableCount: 0,
    pendingCount: 1,
  })
  expect(body.data.indexing.status).toBe('refreshing')
})

test('V4 chunk claim path reclaims an expired projectScope prerequisite before downstream chunks', async () => {
  const projectId = 'project-v4-expired-project-scope-claim'
  const requestId = 'rebuild:expired-project-scope-claim'
  const [
    {getAppDatabaseService},
    {claimReviewServingRebuildChunk, getNextClaimableReviewServingRebuildChunk, getReviewServingRebuildChunkId},
  ] = await Promise.all([
    import('../../services/appDatabaseService.ts'),
    import('../../reviewServing/reviewServingChunkManifestRepository.ts'),
  ])
  const database = getAppDatabaseService()
  const getIdentity = (component: ReviewServingProjectionComponent) => {
    return {
      chunkEndKey: 'article-z',
      chunkStartKey: 'article-a',
      inputDigest: `${component}-digest-v1`,
      inputWatermark: 1,
      outputBaseGeneration: 1,
      projectId,
      projectionComponent: component,
      projectionIdentity: `${component}:identity-1`,
      requestId,
    }
  }
  const projectScopeIdentity = getIdentity('projectScope')
  const summaryIdentity = getIdentity('summary')

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {dirtyToken: 1, lastCompletedDirtyToken: 1, refreshStatus: 'idle'})
  await insertReviewServingRow(projectId, `article-${projectId}`)
  await insertActiveReviewServingManifest({
    includeSearchState: false,
    optionalComponents: [],
    projectId,
    snapshotId: 'snapshot-v4-expired-project-scope-claim',
  })
  await insertReviewRebuildRequest({
    createdAt: '2026-04-02T12:00:00.000Z',
    projectId,
    requestId,
    status: 'admitted',
    updatedAt: '2026-04-02T12:05:00.000Z',
  })
  await insertReviewRebuildChunk({
    chunkId: getReviewServingRebuildChunkId(projectScopeIdentity),
    component: 'projectScope',
    createdAt: '2026-04-02T12:01:00.000Z',
    leaseExpiresAt: '2026-04-02T12:02:00.000Z',
    leaseOwner: 'stale-maintenance-worker',
    projectId,
    requestId,
    status: 'running',
    updatedAt: '2026-04-02T12:01:30.000Z',
  })
  await insertReviewRebuildChunk({
    chunkId: getReviewServingRebuildChunkId(summaryIdentity),
    component: 'summary',
    createdAt: '2026-04-02T12:03:00.000Z',
    projectId,
    requestId,
    status: 'pending',
    updatedAt: '2026-04-02T12:03:00.000Z',
  })

  const next = await getNextClaimableReviewServingRebuildChunk({now: '2026-04-02T12:10:00.000Z', projectId}, database)
  const claimed =
    next === null
      ? null
      : await claimReviewServingRebuildChunk(
          {
            ...next,
            leaseExpiresAt: '2026-04-02T12:15:00.000Z',
            leaseOwner: 'fresh-maintenance-worker',
            now: '2026-04-02T12:10:00.000Z',
          },
          database,
        )

  expect(next).toMatchObject({projectionComponent: 'projectScope', requestId})
  expect(claimed).toMatchObject({
    leaseOwner: 'fresh-maintenance-worker',
    projectionComponent: 'projectScope',
    requestId,
    status: 'running',
  })
})

test('reviews warnings fail terminal V4 rebuild requests instead of reporting healthy queued chunks', async () => {
  const projectId = 'project-v4-terminal-request-queued-warning'
  const requestId = 'rebuild:terminal-request-queued-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {dirtyToken: 1, lastCompletedDirtyToken: 1, refreshStatus: 'idle'})
  await insertReviewRebuildRequest({
    createdAt: '2026-04-02T11:50:00.000Z',
    failedAt: '2026-04-02T11:55:52.494Z',
    lastError: 'DuckDB OOM failed to pin block of size 256.0 KiB (6.2 GiB/6.2 GiB used)',
    projectId,
    requestId,
    status: 'failed',
    updatedAt: '2026-04-02T11:55:52.494Z',
  })
  await insertReviewRebuildChunk({
    chunkId: 'rebuild-chunk-terminal-request-project-scope-completed-warning',
    component: 'projectScope',
    createdAt: '2026-04-02T11:50:00.000Z',
    projectId,
    requestId,
    status: 'completed',
    updatedAt: '2026-04-02T11:51:00.000Z',
  })
  await insertReviewRebuildChunk({
    chunkId: 'rebuild-chunk-terminal-request-selected-import-failed-warning',
    component: 'selectedImport',
    createdAt: '2026-04-02T11:51:00.000Z',
    lastError: 'DuckDB OOM failed to pin block of size 256.0 KiB (6.2 GiB/6.2 GiB used)',
    projectId,
    requestId,
    retryAfter: '2026-04-02T11:56:52.494Z',
    status: 'failed',
    updatedAt: '2026-04-02T11:55:52.494Z',
  })
  await insertReviewRebuildChunk({
    chunkId: 'rebuild-chunk-terminal-request-selected-import-blocked-warning',
    component: 'selectedImport',
    createdAt: '2026-04-02T11:52:00.000Z',
    lastError: 'blocked_over_budget',
    projectId,
    requestId,
    status: 'blocked_over_budget',
    updatedAt: '2026-04-02T11:55:52.494Z',
  })
  await insertReviewRebuildChunk({
    chunkId: 'rebuild-chunk-terminal-request-judgment-input-pending-warning',
    component: 'judgmentInputContent',
    createdAt: '2026-04-02T11:53:00.000Z',
    projectId,
    requestId,
    status: 'pending',
    updatedAt: '2026-04-02T11:53:00.000Z',
  })
  await insertReviewRebuildChunk({
    chunkId: 'rebuild-chunk-terminal-request-summary-pending-warning',
    component: 'summary',
    createdAt: '2026-04-02T11:54:00.000Z',
    projectId,
    requestId,
    status: 'pending',
    updatedAt: '2026-04-02T11:54:00.000Z',
  })

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.activeConsumerCount).toBe(0)
  expect(body.data.indexing.activeWorkCount).toBe(0)
  expect(body.data.indexing.eligibleConsumerCount).toBe(0)
  expect(body.data.indexing.pendingRefreshCount).toBe(3)
  expect(body.data.indexing.progressState).toBe('failed')
  expect(body.data.indexing.queuedRefreshCount).toBe(0)
  expect(body.data.indexing.serving.diagnostics.rebuildChunks).toMatchObject({
    blockedQueuedCount: 3,
    claimableCount: 0,
    failedCount: 1,
    pendingCount: 3,
  })
  expect(body.data.indexing.status).toBe('failed')
})

test('reviews warnings fail completed V4 chunks when request finalization is terminal', async () => {
  const projectId = 'project-v4-terminal-request-completed-chunks-warning'
  const requestId = 'rebuild:terminal-request-completed-chunks-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {dirtyToken: 1, lastCompletedDirtyToken: 1, refreshStatus: 'idle'})
  await insertActiveReviewServingManifest({
    includeSearchState: false,
    optionalComponents: [],
    projectId,
    snapshotId: 'snapshot-terminal-request-completed-chunks-warning',
    status: 'candidate',
  })
  await insertReviewRebuildRequest({
    completedAt: '2026-04-02T12:10:00.000Z',
    createdAt: '2026-04-02T12:00:00.000Z',
    failedAt: '2026-04-02T12:10:01.000Z',
    lastError: 'component humanStatus input watermark 0 for source reviewChange is behind source 1',
    projectId,
    requestId,
    status: 'failed',
    updatedAt: '2026-04-02T12:10:01.000Z',
  })
  await insertReviewRebuildChunk({
    chunkId: 'rebuild-chunk-terminal-request-completed-project-scope-warning',
    component: 'projectScope',
    createdAt: '2026-04-02T12:00:00.000Z',
    projectId,
    requestId,
    status: 'completed',
    updatedAt: '2026-04-02T12:05:00.000Z',
  })
  await insertReviewRebuildChunk({
    chunkId: 'rebuild-chunk-terminal-request-completed-human-status-warning',
    component: 'humanStatus',
    createdAt: '2026-04-02T12:00:00.000Z',
    projectId,
    requestId,
    status: 'completed',
    updatedAt: '2026-04-02T12:10:00.000Z',
  })

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.pendingRefreshCount).toBe(1)
  expect(body.data.indexing.progressState).toBe('failed')
  expect(body.data.indexing.serving.diagnostics.rebuildChunks).toMatchObject({
    completedCount: 2,
    failedCount: 1,
    pendingCount: 0,
  })
  expect(body.data.indexing.serving.diagnostics.snapshot).toMatchObject({candidateCount: 1})
  expect(body.data.indexing.status).toBe('failed')
})

test('reviews warnings fail terminal V4 rebuild backlog when server mutation work is disabled', async () => {
  const projectId = 'project-v4-terminal-request-disabled-mutations-warning'
  const requestId = 'rebuild:terminal-request-disabled-mutations-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {dirtyToken: 1, lastCompletedDirtyToken: 1, refreshStatus: 'idle'})
  await insertReviewServingRow(projectId, `article-${projectId}`)
  await insertActiveReviewServingManifest({
    includeSearchState: false,
    optionalComponents: [],
    projectId,
    snapshotId: 'snapshot-v4-terminal-request-disabled-mutations-warning',
  })
  await insertReviewRebuildRequest({
    createdAt: '2026-04-02T11:50:00.000Z',
    failedAt: '2026-04-02T11:55:52.494Z',
    lastError: 'DuckDB OOM failed to pin block of size 256.0 KiB (6.2 GiB/6.2 GiB used)',
    projectId,
    requestId,
    status: 'failed',
    updatedAt: '2026-04-02T11:55:52.494Z',
  })
  await insertReviewRebuildChunk({
    chunkId: 'rebuild-chunk-terminal-request-disabled-mutations-failed-warning',
    component: 'selectedImport',
    createdAt: '2026-04-02T11:51:00.000Z',
    lastError: 'DuckDB OOM failed to pin block of size 256.0 KiB (6.2 GiB/6.2 GiB used)',
    projectId,
    requestId,
    retryAfter: '2026-04-02T11:56:52.494Z',
    status: 'failed',
    updatedAt: '2026-04-02T11:55:52.494Z',
  })
  await insertReviewRebuildChunk({
    chunkId: 'rebuild-chunk-terminal-request-disabled-mutations-pending-warning',
    component: 'summary',
    createdAt: '2026-04-02T11:54:00.000Z',
    projectId,
    requestId,
    status: 'pending',
    updatedAt: '2026-04-02T11:54:00.000Z',
  })

  const {body, response} = await withServerMutationsDisabled(() => {
    return postWarningsRequest(projectId)
  })

  expect(response.status).toBe(200)
  expect(body.data.indexing.blockedReason).toBe(null)
  expect(body.data.indexing.eligibleConsumerCount).toBe(0)
  expect(body.data.indexing.pendingRefreshCount).toBe(2)
  expect(body.data.indexing.progressState).toBe('failed')
  expect(body.data.indexing.serving.diagnostics.rebuildChunks).toMatchObject({failedCount: 1, pendingCount: 2})
  expect(body.data.indexing.status).toBe('failed')
})

test('reviews warnings ignore chunks from superseded V4 rebuild requests', async () => {
  const projectId = 'project-v4-superseded-request-warning'
  const oldRequestId = 'rebuild:superseded-request-warning-old'
  const activeRequestId = 'rebuild:superseded-request-warning-active'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {dirtyToken: 1, lastCompletedDirtyToken: 1, refreshStatus: 'idle'})
  await insertReviewServingRow(projectId, `article-${projectId}`)
  await insertActiveReviewServingManifest({
    includeSearchState: false,
    optionalComponents: [],
    projectId,
    snapshotId: 'snapshot-v4-superseded-request-warning',
  })
  await insertReviewRebuildRequest({
    createdAt: '2026-04-02T11:50:00.000Z',
    failedAt: '2026-04-02T11:55:52.494Z',
    lastError: 'superseded request failed before the current rebuild was admitted',
    projectId,
    requestId: oldRequestId,
    status: 'failed',
    updatedAt: '2026-04-02T11:55:52.494Z',
  })
  await insertReviewRebuildChunk({
    chunkId: 'rebuild-chunk-superseded-request-failed-warning',
    component: 'projectScope',
    createdAt: '2026-04-02T11:51:00.000Z',
    lastError: 'old failed chunk',
    projectId,
    requestId: oldRequestId,
    status: 'failed',
    updatedAt: '2026-04-02T11:55:52.494Z',
  })
  await insertReviewRebuildChunk({
    chunkId: 'rebuild-chunk-superseded-request-pending-warning',
    component: 'summary',
    createdAt: '2026-04-02T11:52:00.000Z',
    projectId,
    requestId: oldRequestId,
    status: 'pending',
    updatedAt: '2026-04-02T11:52:00.000Z',
  })
  await insertReviewRebuildRequest({
    createdAt: '2026-04-02T12:00:00.000Z',
    projectId,
    requestId: activeRequestId,
    status: 'admitted',
    updatedAt: '2026-04-02T12:05:00.000Z',
  })
  await insertReviewRebuildChunk({
    chunkId: 'rebuild-chunk-superseded-request-active-expired-warning',
    component: 'projectScope',
    createdAt: '2026-04-02T12:01:00.000Z',
    leaseExpiresAt: '2026-04-02T12:02:00.000Z',
    leaseOwner: 'stale-maintenance-worker',
    projectId,
    requestId: activeRequestId,
    status: 'running',
    updatedAt: '2026-04-02T12:01:30.000Z',
  })
  await insertReviewRebuildChunk({
    chunkId: 'rebuild-chunk-superseded-request-active-pending-warning',
    component: 'summary',
    createdAt: '2026-04-02T12:03:00.000Z',
    projectId,
    requestId: activeRequestId,
    status: 'pending',
    updatedAt: '2026-04-02T12:03:00.000Z',
  })

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.pendingRefreshCount).toBe(2)
  expect(body.data.indexing.progressState).toBe('queued')
  expect(body.data.indexing.queuedRefreshCount).toBe(1)
  expect(body.data.indexing.serving.diagnostics.rebuildChunks).toMatchObject({
    blockedQueuedCount: 1,
    claimableCount: 1,
    expiredLeaseCount: 1,
    failedCount: 0,
    pendingCount: 1,
  })
  expect(body.data.indexing.status).toBe('refreshing')
})

test('reviews warnings mark quarantined V4 outbox barriers as blocked', async () => {
  const projectId = 'project-v4-outbox-barrier-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {dirtyToken: 1, lastCompletedDirtyToken: 1, refreshStatus: 'idle'})
  await insertReviewSourceChangeOutbox(projectId, 'quarantined')

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.blockedReason).toBe('quarantine_barrier')
  expect(body.data.indexing.pendingRefreshCount).toBe(0)
  expect(body.data.indexing.progressState).toBe('failed')
  expect(body.data.indexing.serving.diagnostics.quarantine).toMatchObject({
    quarantinedOutboxCount: 1,
    retryableOutboxCount: 0,
    unresolvedOutboxCount: 1,
  })
  expect(body.data.indexing.serving).toMatchObject({readable: false, usable: false})
  expect(body.data.indexing.status).toBe('failed')
})

test('reviews warnings preserve quarantined V4 barriers when server mutation work is disabled', async () => {
  const projectId = 'project-v4-outbox-barrier-mutations-disabled-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {dirtyToken: 1, lastCompletedDirtyToken: 1, refreshStatus: 'idle'})
  await insertReviewServingRow(projectId, `article-${projectId}`)
  await insertReviewSourceChangeOutbox(projectId, 'quarantined')

  const {body, response} = await withServerMutationsDisabled(() => {
    return postWarningsRequest(projectId)
  })

  expect(response.status).toBe(200)
  expect(body.data.indexing.blockedReason).toBe('quarantine_barrier')
  expect(body.data.indexing.pendingRefreshCount).toBe(0)
  expect(body.data.indexing.progressState).toBe('failed')
  expect(body.data.indexing.status).toBe('failed')
})

test('reviews warnings report quarantine barriers before mutation-disabled dirty backlog', async () => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  const projectId = 'project-v4-outbox-barrier-with-dirty-backlog-mutations-disabled-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {dirtyToken: 1, lastCompletedDirtyToken: 1, refreshStatus: 'idle'})
  await insertReviewServingRow(projectId, `article-${projectId}`)
  await insertReviewSourceChangeOutbox(projectId, 'quarantined')
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
      'pending'
    )
  `)

  const {body, response} = await withServerMutationsDisabled(() => {
    return postWarningsRequest(projectId)
  })

  expect(response.status).toBe(200)
  expect(body.data.indexing.blockedReason).toBe('quarantine_barrier')
  expect(body.data.indexing.pendingRefreshCount).toBe(1)
  expect(body.data.indexing.progressState).toBe('failed')
  expect(body.data.indexing.status).toBe('failed')
})

test('reviews warnings prefer claimable orphan recovery chunks over older terminal rebuild requests', async () => {
  const projectId = 'project-v4-terminal-request-orphan-chunk-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {dirtyToken: 1, lastCompletedDirtyToken: 1, refreshStatus: 'idle'})
  await insertReviewServingRow(projectId, `article-${projectId}`)
  await insertReviewRebuildRequest({
    createdAt: '2026-04-02T12:00:00.000Z',
    failedAt: '2026-04-02T12:01:00.000Z',
    projectId,
    requestId: 'request-terminal-with-orphan-chunk-warning',
    status: 'failed',
    updatedAt: '2026-04-02T12:01:00.000Z',
  })
  await insertReviewRebuildChunk({
    chunkId: 'orphan-rebuild-chunk-terminal-request-warning',
    createdAt: '2026-04-02T12:02:00.000Z',
    projectId,
    requestId: null,
    status: 'pending',
    updatedAt: '2026-04-02T12:02:00.000Z',
  })

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.serving.diagnostics.rebuildChunks).toMatchObject({claimableCount: 1, failedCount: 0})
  expect(body.data.indexing.progressState).toBe('queued')
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

test('reviews warnings exposes article coverage for review page details and search readiness', async () => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  const projectId = 'project-article-coverage-warning'
  const articleId = `article-${projectId}`
  const reviewConfigHash = getFixtureReviewConfigHash(projectId)
  const snapshotId = 'snapshot-article-coverage-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {dirtyToken: 1, lastCompletedDirtyToken: 1, refreshStatus: 'idle'})
  await insertReviewServingRow(projectId, articleId)
  await insertActiveReviewServingManifest({
    includeSearchState: false,
    optionalComponents: ['payload', 'search'],
    projectId,
    snapshotId,
  })
  await runDatabase(`
    INSERT INTO mart.review_article_serving_base_v4 (
      project_id,
      review_config_hash,
      snapshot_id,
      base_generation,
      patch_watermark,
      article_id,
      article_created_at,
      sort_key,
      activity_sort_at
    ) VALUES (
      '${projectId}',
      '${reviewConfigHash}',
      '${snapshotId}',
      1,
      0,
      '${articleId}',
      TIMESTAMPTZ '2026-04-02T12:00:00.000Z',
      TIMESTAMPTZ '2026-04-02T12:00:00.000Z',
      TIMESTAMPTZ '2026-04-02T12:00:00.000Z'
    )
  `)
  await runDatabase(`
    INSERT INTO mart.review_article_judgment_detail_serving_v4 (
      project_id,
      review_config_hash,
      snapshot_id,
      payload_kind,
      article_id,
      prompt_id,
      prompt_order,
      is_answered
    ) VALUES (
      '${projectId}',
      '${reviewConfigHash}',
      '${snapshotId}',
      'llm',
      '${articleId}',
      'prompt-${projectId}',
      1,
      TRUE
    )
  `)
  await runDatabase(`
    INSERT INTO mart.review_title_search_serving_v4 (
      project_id,
      search_identity,
      project_scope_identity,
      snapshot_id,
      token,
      article_ids
    ) VALUES (
      '${projectId}',
      'search:identity-1',
      'projectScope:identity-1',
      '${snapshotId}',
      'indexed',
      ['${articleId}']
    )
  `)

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.coverage).toEqual({
    detailReadyArticleCount: 1,
    reviewPageReadyArticleCount: 1,
    searchReadyArticleCount: 1,
    totalArticleCount: 1,
  })
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

test('reviews warnings request bounded V4 repair when fresh idle serving is missing outside the foreground response', async () => {
  const projectId = 'project-missing-serving-bootstrap-warning'

  await insertProjectFixture(projectId)

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.scope.hasAnyArticlesInScope).toBe(true)
  expect(body.data.indexing.pendingRefreshCount).toBe(0)
  expect(body.data.indexing.progressState).toBe('stalled')
  expect(body.data.indexing.queuedProjectRefreshCount).toBe(0)
  expect(body.data.indexing.serving).toMatchObject({readable: false, usable: false})
  expect(body.data.indexing.status).toBe('stale')
})

test('reviews warnings do not enqueue foreground V4 repair when server mutation work is disabled', async () => {
  const projectId = 'project-missing-serving-disabled-mutation-bootstrap-warning'

  await insertProjectFixture(projectId)

  const {body, response} = await withServerMutationsDisabled(() => {
    return postWarningsRequest(projectId)
  })
  await new Promise((resolve) => {
    return setTimeout(resolve, 50)
  })

  expect(response.status).toBe(200)
  expect(body.data.scope.hasAnyArticlesInScope).toBe(true)
  expect(body.data.indexing.pendingRefreshCount).toBe(0)
  expect(body.data.indexing.progressState).toBe('stalled')
  expect(body.data.indexing.serving).toMatchObject({readable: false, usable: false})
  expect(body.data.indexing.status).toBe('stale')
  expect(await getReviewRebuildRequestCount(projectId)).toBe(0)
})

test('reviews warnings do not enqueue foreground V4 repair while the projector is paused by policy', async () => {
  const projectId = 'project-missing-serving-paused-projector-warning'

  await insertProjectFixture(projectId)

  const {body, response} = await withReviewServingProjectorPaused(() => {
    return postWarningsRequest(projectId)
  })

  expect(response.status).toBe(200)
  expect(body.data.indexing.blockedReason).toBe('paused_by_policy')
  expect(body.data.indexing.eligibleConsumerCount).toBe(0)
  expect(body.data.indexing.eligibleConsumerPresent).toBe(false)
  expect(body.data.indexing.progressState).toBe('blocked')
  expect(body.data.indexing.status).toBe('blocked')
  expect(await getReviewRebuildRequestCount(projectId)).toBe(0)
})

test('reviews warnings leave recently progressing foreground V4 repair priority untouched', async () => {
  const projectId = 'project-missing-serving-recent-v4-progress-warning'
  const requestId = 'request-missing-serving-recent-v4-progress-warning'
  const oldTimestamp = '2026-04-02T12:00:00.000Z'
  const recentTimestamp = new Date().toISOString()

  await insertProjectFixture(projectId)
  await insertReviewRebuildRequest({
    createdAt: oldTimestamp,
    priority: 1_000,
    projectId,
    reason: 'missingReviewServingSnapshot',
    requestId,
    requestedComponents: ['projectScope', 'selectedImport', 'display', 'summary'],
    status: 'admitted',
    updatedAt: oldTimestamp,
  })
  await insertReviewRebuildChunk({
    chunkId: 'chunk-missing-serving-recent-v4-progress-completed-warning',
    component: 'projectScope',
    createdAt: oldTimestamp,
    projectId,
    requestId,
    status: 'completed',
    updatedAt: recentTimestamp,
  })
  await insertReviewRebuildChunk({
    chunkId: 'chunk-missing-serving-recent-v4-progress-pending-warning',
    component: 'summary',
    createdAt: oldTimestamp,
    projectId,
    requestId,
    status: 'pending',
    updatedAt: oldTimestamp,
  })

  const before = await getReviewRebuildRequestMetadata(requestId)
  const {body, response} = await postWarningsRequest(projectId)
  await new Promise((resolve) => {
    return setTimeout(resolve, 50)
  })
  const after = await getReviewRebuildRequestMetadata(requestId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.pendingRefreshCount).toBe(1)
  expect(body.data.indexing.progressState).toBe('processing')
  expect(body.data.indexing.lastProgressedAt).not.toBeNull()
  expect(after.priority).toBe(before.priority)
  expect(after.updatedAt).toBe(before.updatedAt)
})

test('reviews warnings boost stale foreground V4 repairs that already have progressable chunks', async () => {
  const projectId = 'project-missing-serving-stale-foreground-warning'
  const requestId = 'request-missing-serving-stale-foreground-warning'
  const oldTimestamp = '2026-04-02T12:00:00.000Z'

  await insertProjectFixture(projectId)
  await insertReviewRebuildRequest({
    createdAt: oldTimestamp,
    priority: 1_000,
    projectId,
    reason: 'missingReviewServingSnapshot',
    requestId,
    requestedComponents: ['projectScope', 'selectedImport', 'display', 'summary'],
    status: 'admitted',
    updatedAt: oldTimestamp,
  })
  await insertReviewRebuildChunk({
    chunkId: 'chunk-missing-serving-stale-foreground-pending-warning',
    component: 'summary',
    createdAt: oldTimestamp,
    projectId,
    requestId,
    status: 'pending',
    updatedAt: oldTimestamp,
  })

  const before = await getReviewRebuildRequestMetadata(requestId)
  const {body, response} = await postWarningsRequest(projectId)
  await new Promise((resolve) => {
    return setTimeout(resolve, 50)
  })
  const after = await getReviewRebuildRequestMetadata(requestId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.pendingRefreshCount).toBe(1)
  expect(body.data.indexing.progressState).toBe('queued')
  expect(body.data.indexing.serving).toMatchObject({readable: false, usable: false})
  expect(body.data.indexing.status).toBe('refreshing')
  expect(await getReviewRebuildRequestCount(projectId)).toBe(1)
  expect(before.priority).toBe(1_000)
  expect(after.priority).toBe(10_000)
  expect(after.updatedAt).not.toBe(before.updatedAt)
})

test('reviews warnings boost stale foreground V4 repairs when a candidate is waiting for activation', async () => {
  const projectId = 'project-missing-serving-stale-candidate-foreground-warning'
  const requestId = 'request-missing-serving-stale-candidate-foreground-warning'
  const selectedImportSnapshotId = 'selected-import-stale-candidate-foreground-warning'
  const oldTimestamp = '2026-04-02T12:00:00.000Z'
  const requiredComponents = ['projectScope', 'posting', 'queue', 'summary'] as const
  const requiredState = requiredComponents.map((component) => {
    return {baseGeneration: '1', component, patchWatermark: '0', projectionIdentity: `${component}:identity-1`}
  })

  await insertProjectFixture(projectId)
  await insertReviewRebuildRequest({
    createdAt: oldTimestamp,
    priority: 100,
    projectId,
    reason: 'missingReviewServingSnapshot',
    requestId,
    requestedComponents: requiredComponents,
    status: 'admitted',
    updatedAt: oldTimestamp,
  })
  await runDatabase?.(`
    INSERT INTO app.review_selected_import_snapshot (
      selected_import_snapshot_id,
      project_id,
      project_scope_identity,
      source_delta_high_water,
      status,
      updated_at
    ) VALUES (
      '${selectedImportSnapshotId}',
      '${projectId}',
      'projectScope:identity-1',
      1,
      'completed',
      TIMESTAMPTZ '${oldTimestamp}'
    )
  `)
  for (const component of requiredComponents) {
    await runDatabase?.(`
      INSERT INTO app.review_projection_identity_manifest (
        manifest_id,
        project_id,
        projection_component,
        projection_identity,
        base_generation,
        patch_watermark,
        input_watermark,
        input_watermarks_json,
        definition_version,
        review_config_hash,
        status,
        updated_at
      ) VALUES (
        'manifest-${projectId}-${component}',
        '${projectId}',
        '${component}',
        '${component}:identity-1',
        1,
        0,
        1,
        '{}'::JSON,
        '${component}:test-v1',
        '${getFixtureReviewConfigHash(projectId)}',
        'candidate',
        TIMESTAMPTZ '${oldTimestamp}'
      )
    `)
  }
  await runDatabase?.(`
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
      selected_import_snapshot_id,
      updated_at
    ) VALUES (
      '${projectId}',
      'snapshot-stale-candidate-foreground-warning',
      'candidate',
      '${getFixtureReviewConfigHash(projectId)}',
      '{}'::JSON,
      '${JSON.stringify({optional: [], required: requiredState}).replaceAll("'", "''")}'::JSON,
      '${JSON.stringify(requiredComponents).replaceAll("'", "''")}'::JSON,
      '[]'::JSON,
      '{}'::JSON,
      '${selectedImportSnapshotId}',
      TIMESTAMPTZ '${oldTimestamp}'
    )
  `)
  await insertReviewRebuildChunk({
    chunkId: 'chunk-missing-serving-stale-candidate-foreground-warning',
    component: 'summary',
    createdAt: oldTimestamp,
    projectId,
    requestId,
    status: 'pending',
    updatedAt: oldTimestamp,
  })

  const before = await getReviewRebuildRequestMetadata(requestId)
  const {body, response} = await postWarningsRequest(projectId)
  await new Promise((resolve) => {
    return setTimeout(resolve, 50)
  })
  const after = await getReviewRebuildRequestMetadata(requestId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.pendingRefreshCount).toBeGreaterThan(0)
  expect(body.data.indexing.progressState).toBe('queued')
  expect(body.data.indexing.serving).toMatchObject({readable: false, usable: false})
  expect(body.data.indexing.status).toBe('refreshing')
  expect(before.priority).toBe(100)
  expect(after.priority).toBe(10_000)
  expect(after.updatedAt).not.toBe(before.updatedAt)
})

test('reviews warnings do not mutate stale queued V4 repairs even when serving rows are readable', async () => {
  const projectId = 'project-readable-serving-stale-queued-foreground-warning'
  const requestId = 'request-readable-serving-stale-queued-foreground-warning'
  const articleId = `article-${projectId}`
  const oldTimestamp = '2026-04-02T12:00:00.000Z'

  await insertProjectFixture(projectId)
  await insertReviewServingRow(projectId, articleId)
  await insertActiveReviewServingManifest({
    includeSearchState: false,
    optionalComponents: [],
    projectId,
    snapshotId: 'snapshot-readable-serving-stale-queued-foreground-warning',
  })
  await insertReviewRebuildRequest({
    createdAt: oldTimestamp,
    priority: 1_000,
    projectId,
    reason: 'missingReviewServingSnapshot',
    requestId,
    requestedComponents: ['llmStatus'],
    status: 'admitted',
    updatedAt: oldTimestamp,
  })
  await insertReviewRebuildChunk({
    chunkId: 'chunk-readable-serving-stale-queued-foreground-warning',
    component: 'llmStatus',
    createdAt: oldTimestamp,
    projectId,
    requestId,
    status: 'pending',
    updatedAt: oldTimestamp,
  })

  const before = await getReviewRebuildRequestMetadata(requestId)
  const {body, response} = await postWarningsRequest(projectId)
  await new Promise((resolve) => {
    return setTimeout(resolve, 50)
  })
  const after = await getReviewRebuildRequestMetadata(requestId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.pendingRefreshCount).toBe(1)
  expect(body.data.indexing.progressState).toBe('queued')
  expect(body.data.indexing.serving).toMatchObject({readable: true, usable: true})
  expect(before.priority).toBe(1_000)
  expect(after.priority).toBe(before.priority)
  expect(after.updatedAt).toBe(before.updatedAt)
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

test('reviews warnings fail readable serving when the latest active V4 rebuild has a quarantined chunk', async () => {
  const projectId = 'project-readable-serving-active-quarantined-v4-warning'
  const requestId = 'request-readable-serving-active-quarantined-v4-warning'

  await insertProjectFixture(projectId)
  await insertReviewServingRow(projectId, `article-${projectId}`)
  await insertActiveReviewServingManifest({
    includeSearchState: false,
    optionalComponents: [],
    projectId,
    snapshotId: 'snapshot-readable-serving-active-quarantined-v4-warning',
  })
  await insertReviewRebuildRequest({
    createdAt: '2026-04-02T12:00:00.000Z',
    projectId,
    requestId,
    status: 'admitted',
    updatedAt: '2026-04-02T12:05:00.000Z',
  })
  await insertReviewRebuildChunk({
    chunkId: 'chunk-readable-serving-active-quarantined-v4-warning',
    createdAt: '2026-04-02T12:01:00.000Z',
    lastError: 'DuckDB fatal index delete failed after WAL replay',
    projectId,
    requestId,
    status: 'quarantined',
    updatedAt: '2026-04-02T12:05:00.000Z',
  })

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.indexing.progressState).toBe('failed')
  expect(body.data.indexing.serving.readable).toBe(true)
  expect(body.data.indexing.serving.diagnostics.rebuildChunks).toMatchObject({
    failedCount: 0,
    pendingCount: 0,
    quarantinedCount: 1,
    terminalQuarantinedCount: 1,
  })
  expect(body.data.indexing.status).toBe('failed')
})

test('reviews warnings prioritize terminal V4 request over disabled mutation backlog', async () => {
  const projectId = 'project-terminal-v4-disabled-mutations-warning'
  const requestId = 'request-terminal-v4-disabled-mutations-warning'

  await insertProjectFixture(projectId)
  await insertReviewRebuildRequest({
    createdAt: '2026-04-02T12:00:00.000Z',
    failedAt: '2026-04-02T12:05:00.000Z',
    lastError: 'request failed after admission',
    projectId,
    requestId,
    status: 'failed',
    updatedAt: '2026-04-02T12:05:00.000Z',
  })
  await insertReviewRebuildChunk({
    chunkId: 'chunk-terminal-v4-disabled-mutations-warning',
    createdAt: '2026-04-02T12:00:00.000Z',
    projectId,
    requestId,
    status: 'pending',
    updatedAt: '2026-04-02T12:00:00.000Z',
  })

  await withServerMutationsDisabled(async () => {
    const {body, response} = await postWarningsRequest(projectId)

    expect(response.status).toBe(200)
    expect(body.data.indexing.pendingRefreshCount).toBe(1)
    expect(body.data.indexing.progressState).toBe('failed')
    expect(body.data.indexing.status).toBe('failed')
  })
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
  expect(body.data.indexing.pendingRefreshCount).toBe(0)
  expect(body.data.indexing.progressState).toBe('completed')
  expect(body.data.indexing.status).toBe('not-needed')
})

test('reviews warnings report candidate serving generation as pending activation work', async () => {
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
  expect(body.data.indexing.pendingRefreshCount).toBe(1)
  expect(body.data.indexing.progressState).toBe('stalled')
  expect(body.data.indexing.status).toBe('refreshing')
})

test('reviews warnings wait for retryable failed serving generation before queueing bootstrap rebuild', async () => {
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
  expect(body.data.indexing.pendingRefreshCount).toBe(1)
  expect(body.data.indexing.queuedProjectRefreshCount).toBe(0)
  expect(body.data.indexing.progressState).toBe('processing')
  expect(body.data.indexing.status).toBe('refreshing')
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
  expect(body.data.indexing.pendingRefreshCount).toBe(0)
  expect(body.data.indexing.progressState).toBe('completed')
  expect(body.data.indexing.status).toBe('not-needed')
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

test('reviews warnings report queued V4 work as policy-blocked while the projector is paused', async () => {
  const projectId = 'project-v4-rebuild-paused-projector-warning'

  await insertProjectFixture(projectId)
  await insertProjectRefreshState(projectId, {dirtyToken: 1, lastCompletedDirtyToken: 1, refreshStatus: 'idle'})
  await insertReviewServingRow(projectId, `article-${projectId}`)
  await insertActiveReviewServingManifest({
    includeSearchState: false,
    optionalComponents: [],
    projectId,
    snapshotId: 'snapshot-v4-paused-projector-warning',
  })
  await insertReviewRebuildChunk({
    chunkId: 'rebuild-chunk-v4-paused-projector-warning',
    createdAt: '2026-04-02T12:00:00.000Z',
    projectId,
    status: 'pending',
    updatedAt: '2026-04-02T12:00:00.000Z',
  })

  const {body, response} = await withReviewServingProjectorPaused(() => {
    return postWarningsRequest(projectId)
  })

  expect(response.status).toBe(200)
  expect(body.data.indexing.blockedReason).toBe('paused_by_policy')
  expect(body.data.indexing.eligibleConsumerCount).toBe(0)
  expect(body.data.indexing.eligibleConsumerPresent).toBe(false)
  expect(body.data.indexing.pendingRefreshCount).toBe(1)
  expect(body.data.indexing.progressState).toBe('blocked')
  expect(body.data.indexing.queuedRefreshCount).toBe(1)
  expect(body.data.indexing.status).toBe('blocked')
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

test('reviews warnings route classifies foreground DuckDB read workload context', async () => {
  const projectId = 'project-warning-workload-context'
  const {getDuckdbWorkloadRuntimeMetricsSnapshot} = await import('../../utils/duckdbService.ts')

  await insertProjectFixture(projectId)

  await withReviewServingProjectorPaused(async () => {
    const {response} = await postWarningsRequest(projectId)

    expect(response.status).toBe(200)
  })

  const projectMetrics = getDuckdbWorkloadRuntimeMetricsSnapshot().filter((metric) => {
    return metric.projectId === projectId
  })
  const routeKeys = new Set(
    projectMetrics.map((metric) => {
      return metric.routeOrJobKey
    }),
  )

  expect(routeKeys).toContain('review.warnings.reviewConfigHash')
  expect(routeKeys).toContain('review.warnings.servingDiagnostics')
  expect(routeKeys).toContain('review.warnings.scopeState')
  expect(
    projectMetrics.filter((metric) => {
      return metric.routeOrJobKey === 'review.warnings.scopeState'
    }),
  ).toHaveLength(1)
  expect(routeKeys).not.toContain('review.warnings.enabledPromptCount')
  expect(routeKeys).not.toContain('review.warnings.articleScopeProbe')
  expect(
    projectMetrics.some((metric) => {
      return metric.routeOrJobKey === 'duckdb.mainQuery'
    }),
  ).toBe(false)
  expect(
    projectMetrics.some((metric) => {
      return metric.workloadClass === 'unclassified'
    }),
  ).toBe(false)
})

test('reviews warnings route reuses reader diagnostics instead of duplicate current-db fanout', async () => {
  const source = await globalThis.Bun.file(new URL('./projectsRoutesGetReviewsWarnings.ts', import.meta.url)).text()

  expect(source).toContain('warningSnapshot.diagnostics.diagnostics')
  expect(source).toContain('metadataOnly: true')
  expect(source).not.toContain('const [servingDiagnostics, warningSnapshot')
  expect(source).not.toContain('Promise.all([\n      readReviewServingRows')
})

afterAll(async () => {
  await closeDatabase?.()
  tempRuntimeRoot.cleanup()
})
