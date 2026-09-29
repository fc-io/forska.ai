import {afterAll, beforeAll, beforeEach, expect, setDefaultTimeout, test} from 'bun:test'

import type {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'
import type {ReviewServingProjectionComponent} from './reviewServingContracts.ts'
import type {CloseStaleReviewServingRebuildRequestsInput} from './reviewServingStaleRebuildRequestCleanup.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('review-serving-stale-rebuild-request-cleanup')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const archivedLastError = 'superseded: project archived'
const oldReviewConfigHash = 'review-config-old'
const visibilityComponents = [
  'projectScope',
  'selectedImport',
  'display',
  'llmStatus',
  'humanStatus',
  'queue',
] as const satisfies readonly ReviewServingProjectionComponent[]

let database: ReturnType<typeof getAppDatabaseService> | null = null

const getDatabase = () => {
  if (database === null) {
    throw new Error('Database not initialized')
  }

  return database
}

const loadCleanup = () => {
  return import('./reviewServingStaleRebuildRequestCleanup.ts')
}

const getHoursAgoSql = (hours: number) => {
  return `current_timestamp - to_seconds(${Math.round(hours * 3_600)})`
}

// Projects were last changed (archived, for archived ones) two hours ago unless a test says otherwise.
const insertProject = async (input: {
  archived?: boolean
  deletePending?: boolean
  projectId: string
  updatedHoursAgo?: number
}) => {
  await getDatabase().run(`
    INSERT INTO app.project (
      id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images, archived, delete_pending_at,
      created_at, updated_at
    ) VALUES (
      '${input.projectId}', '${input.projectId}', 'model-stale', TRUE, TRUE, FALSE, FALSE,
      ${input.archived === true ? 'TRUE' : 'FALSE'}, ${input.deletePending === true ? 'current_timestamp' : 'NULL'},
      ${getHoursAgoSql(48)}, ${getHoursAgoSql(input.updatedHoursAgo ?? 2)}
    )
  `)
}

const archiveProject = async (projectId: string, archived: boolean) => {
  await getDatabase().run(`
    UPDATE app.project SET archived = ${archived ? 'TRUE' : 'FALSE'}, updated_at = ${getHoursAgoSql(2)}
    WHERE id = '${projectId}'
  `)
}

const getCurrentReviewConfigHash = async (projectId: string) => {
  const {getCurrentReviewServingReviewConfigHash} = await import('./reviewServingReviewConfig.ts')
  const hash = await getCurrentReviewServingReviewConfigHash(projectId, getDatabase())

  if (hash === null) {
    throw new Error(`expected a review config hash for ${projectId}`)
  }

  return hash
}

const upsertProjectionManifests = async (
  projectId: string,
  reviewConfigHash: string,
  components: readonly ReviewServingProjectionComponent[],
) => {
  const {upsertReviewServingProjectionIdentityManifest} = await import('./reviewServingManifestRepository.ts')

  await components.reduce<Promise<void>>(async (previous, component) => {
    await previous
    await upsertReviewServingProjectionIdentityManifest(
      {
        baseGeneration: 0,
        definitionVersion: `${component}:test`,
        inputWatermark: 0,
        patchWatermark: 0,
        projectId,
        projectionComponent: component,
        projectionIdentity: `${component}:${projectId}`,
        reviewConfigHash,
        status: 'active',
      },
      getDatabase(),
    )
  }, Promise.resolve())
}

const insertSnapshot = async (input: {
  components?: readonly ReviewServingProjectionComponent[]
  failedHoursAgo?: number
  projectId: string
  reviewConfigHash: string
  snapshotId: string
  status: 'active' | 'candidate' | 'failed' | 'retired'
}) => {
  const components = input.components ?? []
  const componentState = {
    optional: [],
    required: components.map((component) => {
      return {
        baseGeneration: '0',
        component,
        patchWatermark: '0',
        projectionIdentity: `${component}:${input.projectId}`,
        requirement: 'required',
      }
    }),
  }
  const updatedHoursAgo = input.failedHoursAgo ?? 0

  await getDatabase().run(`
    INSERT INTO app.review_serving_snapshot_manifest (
      project_id, snapshot_id, snapshot_status, review_config_hash, composed_identity_json, component_state_json,
      required_components_json, optional_components_json, source_watermarks_json, selected_import_snapshot_id,
      activated_at, created_at, updated_at, failed_at
    ) VALUES (
      '${input.projectId}', '${input.snapshotId}', '${input.status}', '${input.reviewConfigHash}', '{}'::JSON,
      '${JSON.stringify(componentState)}'::JSON, '${JSON.stringify(components)}'::JSON, '[]'::JSON, '{}'::JSON,
      'selected-import-${input.projectId}', ${input.status === 'active' ? 'current_timestamp' : 'NULL'},
      ${getHoursAgoSql(updatedHoursAgo + 1)}, ${getHoursAgoSql(updatedHoursAgo)},
      ${input.failedHoursAgo === undefined ? 'NULL' : getHoursAgoSql(input.failedHoursAgo)}
    )
  `)
}

const insertRequest = async (input: {
  admissionState?: string
  lastError?: string
  projectId: string
  reason?: string
  requestedComponents: readonly ReviewServingProjectionComponent[]
  requestId: string
  reviewConfigHash?: string | null
  status: string
  updatedHoursAgo?: number
}) => {
  const admissionState =
    input.admissionState
    ?? (input.status === 'blocked_over_budget'
      ? 'blocked_over_budget'
      : input.status === 'pending_admission'
        ? 'pending'
        : 'admitted')
  const identity = input.reviewConfigHash === null ? {} : {reviewConfigHash: input.reviewConfigHash ?? null}

  await getDatabase().run(`
    INSERT INTO app.review_rebuild_request (
      request_id, project_id, reason, requested_components_json, identity_json, priority, status, admission_state,
      retry_policy_json, last_error, created_at, updated_at
    ) VALUES (
      '${input.requestId}', '${input.projectId}', '${input.reason ?? 'llmStatusDirtyWork'}',
      '${JSON.stringify(input.requestedComponents)}'::JSON, '${JSON.stringify(identity)}'::JSON, 100,
      '${input.status}', '${admissionState}', '{"maxAttempts":3}'::JSON,
      ${input.lastError === undefined ? 'NULL' : `'${input.lastError}'`},
      ${getHoursAgoSql((input.updatedHoursAgo ?? 2) + 1)}, ${getHoursAgoSql(input.updatedHoursAgo ?? 2)}
    )
  `)
}

const insertChunk = async (input: {
  chunkId: string
  component?: ReviewServingProjectionComponent
  projectId: string
  requestId: string
  retryCount?: number
  snapshotId: string | null
  status: string
}) => {
  const component = input.component ?? 'llmStatus'

  await getDatabase().run(`
    INSERT INTO app.review_rebuild_chunk_manifest (
      chunk_id, request_id, project_id, snapshot_id, projection_component, projection_identity, chunk_start_key,
      chunk_end_key, output_base_generation, status, admission_state, retry_count, lease_owner, lease_expires_at,
      started_at, completed_at
    ) VALUES (
      '${input.chunkId}', '${input.requestId}', '${input.projectId}',
      ${input.snapshotId === null ? 'NULL' : `'${input.snapshotId}'`}, '${component}',
      '${component}:${input.projectId}', 'article-00', 'article-99', 0, '${input.status}',
      '${input.status === 'blocked_over_budget' ? 'blocked_over_budget' : 'admitted'}', ${input.retryCount ?? 0},
      ${input.status === 'running' ? `'worker-busy'` : 'NULL'},
      ${input.status === 'running' ? 'current_timestamp + INTERVAL 10 MINUTE' : 'NULL'},
      ${input.status === 'completed' || input.status === 'running' ? 'current_timestamp' : 'NULL'},
      ${input.status === 'completed' ? 'current_timestamp' : 'NULL'}
    )
  `)
}

const getRequests = (projectId: string) => {
  return getDatabase().queryJson<{lastError: string | null; requestId: string; status: string}>(`
    SELECT request_id AS requestId, status, last_error AS lastError
    FROM app.review_rebuild_request
    WHERE project_id = '${projectId}'
    ORDER BY request_id
  `)
}

const getChunks = (projectId: string) => {
  return getDatabase().queryJson<{chunkId: string; status: string}>(`
    SELECT chunk_id AS chunkId, status
    FROM app.review_rebuild_chunk_manifest
    WHERE project_id = '${projectId}'
    ORDER BY chunk_id
  `)
}

const getSnapshotStatuses = (projectId: string) => {
  return getDatabase().queryJson<{snapshotId: string; status: string}>(`
    SELECT snapshot_id AS snapshotId, snapshot_status AS status
    FROM app.review_serving_snapshot_manifest
    WHERE project_id = '${projectId}'
    ORDER BY snapshot_id
  `)
}

const getAvailableComponents = async (projectId: string, snapshotId: string) => {
  const {getReviewServingSnapshotManifest} = await import('./reviewServingManifestRepository.ts')
  const manifest = await getReviewServingSnapshotManifest(
    {componentStateMode: 'available', projectId, snapshotId},
    getDatabase(),
  )

  return [...(manifest?.componentState.required ?? []), ...(manifest?.componentState.optional ?? [])]
    .map((state) => {
      return state.component
    })
    .sort()
}

const runCleanup = async (input: CloseStaleReviewServingRebuildRequestsInput) => {
  const {closeStaleReviewServingRebuildRequests} = await loadCleanup()

  return closeStaleReviewServingRebuildRequests(input, getDatabase())
}

const getClosedRequestSummary = (result: Awaited<ReturnType<typeof runCleanup>>) => {
  return result.closedRequests
    .map((request) => {
      return [request.requestId, request.reason, request.previousStatus]
    })
    .sort((left, right) => {
      return String(left[0]).localeCompare(String(right[0]))
    })
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
})

beforeEach(async () => {
  const {resetStaleReviewServingRebuildRequestCleanupForTests} = await loadCleanup()

  resetStaleReviewServingRebuildRequestCleanupForTests()
})

afterAll(async () => {
  await database?.close()
  tempRuntimeRoot.cleanup()
})

test('an archived project closes every request that could still run and fails the candidates nobody builds', async () => {
  const projectId = 'project-archived'
  const reviewConfigHash = 'review-config-archived'
  const snapshots = {
    active: 'snapshot-archived-active',
    candidate: 'snapshot-archived-candidate',
    finished: 'snapshot-archived-finished',
    orphan: 'snapshot-archived-orphan',
    running: 'snapshot-archived-running',
    terminal: 'snapshot-archived-terminal',
  }

  await insertProject({archived: true, projectId})
  await upsertProjectionManifests(projectId, reviewConfigHash, ['display', 'search'])
  await insertSnapshot({
    components: ['display', 'search'],
    projectId,
    reviewConfigHash,
    snapshotId: snapshots.active,
    status: 'active',
  })
  await [snapshots.candidate, snapshots.finished, snapshots.orphan, snapshots.running, snapshots.terminal].reduce<
    Promise<void>
  >(async (previous, snapshotId) => {
    await previous
    await insertSnapshot({components: ['display'], projectId, reviewConfigHash, snapshotId, status: 'candidate'})
  }, Promise.resolve())
  // A train whose snapshot was promoted while its search chunks still waited: display is built, search is not.
  await insertRequest({
    projectId,
    requestedComponents: ['display', 'search'],
    requestId: 'rebuild:a-train',
    status: 'admitted',
  })
  await insertChunk({
    chunkId: 'chunk:a-train-display',
    component: 'display',
    projectId,
    requestId: 'rebuild:a-train',
    snapshotId: snapshots.active,
    status: 'completed',
  })
  await insertChunk({
    chunkId: 'chunk:a-train-search',
    component: 'search',
    projectId,
    requestId: 'rebuild:a-train',
    snapshotId: snapshots.active,
    status: 'pending',
  })
  await insertRequest({
    projectId,
    requestedComponents: ['display'],
    requestId: 'rebuild:b-candidate',
    status: 'admitted',
  })
  await insertChunk({
    chunkId: 'chunk:b-candidate',
    component: 'display',
    projectId,
    requestId: 'rebuild:b-candidate',
    snapshotId: snapshots.candidate,
    status: 'pending',
  })
  await insertRequest({
    projectId,
    requestedComponents: ['llmStatus'],
    requestId: 'rebuild:c-blocked',
    status: 'blocked_over_budget',
  })
  await insertChunk({
    chunkId: 'chunk:c-blocked',
    projectId,
    requestId: 'rebuild:c-blocked',
    snapshotId: null,
    status: 'blocked_over_budget',
  })
  await insertRequest({
    projectId,
    requestedComponents: ['llmStatus'],
    requestId: 'rebuild:d-pending-admission',
    status: 'pending_admission',
  })
  await insertRequest({
    lastError: 'Out of Memory',
    projectId,
    requestedComponents: ['llmStatus'],
    requestId: 'rebuild:e-retryable',
    status: 'failed',
  })
  await insertChunk({
    chunkId: 'chunk:e-retryable',
    projectId,
    requestId: 'rebuild:e-retryable',
    retryCount: 1,
    snapshotId: null,
    status: 'failed',
  })
  await insertRequest({
    projectId,
    requestedComponents: ['display'],
    requestId: 'rebuild:f-finished',
    status: 'admitted',
  })
  await insertChunk({
    chunkId: 'chunk:f-finished',
    component: 'display',
    projectId,
    requestId: 'rebuild:f-finished',
    snapshotId: snapshots.finished,
    status: 'completed',
  })
  await insertRequest({projectId, requestedComponents: ['display'], requestId: 'rebuild:g-running', status: 'admitted'})
  await insertChunk({
    chunkId: 'chunk:g-running',
    component: 'display',
    projectId,
    requestId: 'rebuild:g-running',
    snapshotId: snapshots.running,
    status: 'running',
  })
  await insertRequest({
    lastError: 'superseded by newer foreground rebuild request',
    projectId,
    requestedComponents: ['llmStatus'],
    requestId: 'rebuild:h-superseded',
    status: 'failed',
  })
  await insertChunk({
    chunkId: 'chunk:h-superseded',
    projectId,
    requestId: 'rebuild:h-superseded',
    snapshotId: null,
    status: 'failed',
  })
  // Failed for good by a quarantined chunk, but its other chunk still waits as pending on a candidate.
  await insertRequest({
    lastError: 'Binder Error',
    projectId,
    requestedComponents: ['display'],
    requestId: 'rebuild:i-terminal',
    status: 'failed',
  })
  await insertChunk({
    chunkId: 'chunk:i-terminal-pending',
    component: 'display',
    projectId,
    requestId: 'rebuild:i-terminal',
    snapshotId: snapshots.terminal,
    status: 'pending',
  })
  await insertChunk({
    chunkId: 'chunk:i-terminal-quarantined',
    component: 'display',
    projectId,
    requestId: 'rebuild:i-terminal',
    snapshotId: snapshots.terminal,
    status: 'quarantined',
  })

  expect(await getAvailableComponents(projectId, snapshots.active)).toEqual(['display'])

  const result = await runCleanup({projectId})

  expect(getClosedRequestSummary(result)).toEqual([
    ['rebuild:a-train', 'projectArchived', 'admitted'],
    ['rebuild:b-candidate', 'projectArchived', 'admitted'],
    ['rebuild:c-blocked', 'projectArchived', 'blocked_over_budget'],
    ['rebuild:d-pending-admission', 'projectArchived', 'pending_admission'],
    ['rebuild:e-retryable', 'projectArchived', 'failed'],
  ])
  expect(await getRequests(projectId)).toEqual([
    {lastError: archivedLastError, requestId: 'rebuild:a-train', status: 'failed'},
    {lastError: archivedLastError, requestId: 'rebuild:b-candidate', status: 'failed'},
    {lastError: archivedLastError, requestId: 'rebuild:c-blocked', status: 'failed'},
    {lastError: archivedLastError, requestId: 'rebuild:d-pending-admission', status: 'failed'},
    {lastError: `${archivedLastError} (was: Out of Memory)`, requestId: 'rebuild:e-retryable', status: 'failed'},
    {lastError: null, requestId: 'rebuild:f-finished', status: 'admitted'},
    {lastError: null, requestId: 'rebuild:g-running', status: 'admitted'},
    {lastError: 'superseded by newer foreground rebuild request', requestId: 'rebuild:h-superseded', status: 'failed'},
    {lastError: 'Binder Error', requestId: 'rebuild:i-terminal', status: 'failed'},
  ])
  // Unstarted chunks fail; never-built chunks without a snapshot are deleted; the rest stays for availability.
  expect(await getChunks(projectId)).toEqual([
    {chunkId: 'chunk:a-train-display', status: 'completed'},
    {chunkId: 'chunk:a-train-search', status: 'failed'},
    {chunkId: 'chunk:b-candidate', status: 'failed'},
    {chunkId: 'chunk:f-finished', status: 'completed'},
    {chunkId: 'chunk:g-running', status: 'running'},
    {chunkId: 'chunk:i-terminal-pending', status: 'failed'},
    {chunkId: 'chunk:i-terminal-quarantined', status: 'quarantined'},
  ])
  expect(result.deletedChunkRows).toBe(3)
  expect(result.failedChunkRows).toBe(1)
  expect(await getSnapshotStatuses(projectId)).toEqual([
    {snapshotId: snapshots.active, status: 'active'},
    {snapshotId: snapshots.candidate, status: 'failed'},
    {snapshotId: snapshots.finished, status: 'candidate'},
    {snapshotId: snapshots.orphan, status: 'failed'},
    {snapshotId: snapshots.running, status: 'candidate'},
    {snapshotId: snapshots.terminal, status: 'failed'},
  ])
  expect(
    result.failedSnapshots
      .map((snapshot) => {
        return snapshot.snapshotId
      })
      .sort(),
  ).toEqual([snapshots.candidate, snapshots.orphan, snapshots.terminal])
  // The closed train fails rather than being cancelled, so the display it built stays readable.
  expect(await getAvailableComponents(projectId, snapshots.active)).toEqual(['display'])

  const again = await runCleanup({projectId})

  expect(again.closedRequests).toEqual([])
  expect(again.failedSnapshots).toEqual([])
  expect(again.deletedChunkRows).toBe(0)
  expect(again.failedChunkRows).toBe(0)
})

test('requests of delete-pending and deleted projects close with their own reason', async () => {
  const deletePendingProjectId = 'project-delete-pending'
  const deletedProjectId = 'project-deleted'

  await insertProject({archived: true, deletePending: true, projectId: deletePendingProjectId})
  await insertRequest({
    projectId: deletePendingProjectId,
    requestedComponents: ['llmStatus'],
    requestId: 'rebuild:delete-pending',
    status: 'blocked_over_budget',
  })
  await insertRequest({
    projectId: deletedProjectId,
    requestedComponents: ['llmStatus'],
    requestId: 'rebuild:deleted',
    status: 'admitted',
  })
  await insertChunk({
    chunkId: 'chunk:deleted',
    projectId: deletedProjectId,
    requestId: 'rebuild:deleted',
    snapshotId: 'snapshot-gone',
    status: 'pending',
  })

  await runCleanup({projectId: deletePendingProjectId})
  await runCleanup({projectId: deletedProjectId})

  expect(await getRequests(deletePendingProjectId)).toEqual([
    {lastError: 'superseded: project delete pending', requestId: 'rebuild:delete-pending', status: 'failed'},
  ])
  expect(await getRequests(deletedProjectId)).toEqual([
    {lastError: 'superseded: project deleted', requestId: 'rebuild:deleted', status: 'failed'},
  ])
  expect(await getChunks(deletedProjectId)).toEqual([])
})

test('a project archived moments ago keeps its rebuilds and candidates until the settle window passed', async () => {
  const projectId = 'project-just-archived'
  const candidateSnapshotId = 'snapshot-just-archived'

  await insertProject({archived: true, projectId, updatedHoursAgo: 0.1})
  await insertSnapshot({
    components: ['display'],
    projectId,
    reviewConfigHash: 'review-config-just-archived',
    snapshotId: candidateSnapshotId,
    status: 'candidate',
  })
  await insertRequest({
    projectId,
    requestedComponents: ['display'],
    requestId: 'rebuild:just-archived',
    status: 'admitted',
  })
  await insertChunk({
    chunkId: 'chunk:just-archived',
    component: 'display',
    projectId,
    requestId: 'rebuild:just-archived',
    snapshotId: candidateSnapshotId,
    status: 'pending',
  })

  const early = await runCleanup({projectId})

  expect(early.closedRequests).toEqual([])
  expect(early.failedSnapshots).toEqual([])
  expect(await getSnapshotStatuses(projectId)).toEqual([{snapshotId: candidateSnapshotId, status: 'candidate'}])

  await archiveProject(projectId, true)

  const settled = await runCleanup({projectId})

  expect(getClosedRequestSummary(settled)).toEqual([['rebuild:just-archived', 'projectArchived', 'admitted']])
  expect(await getSnapshotStatuses(projectId)).toEqual([{snapshotId: candidateSnapshotId, status: 'failed'}])
})

test('a live project only loses never-admitted requests that are settled and provably superseded', async () => {
  const projectId = 'project-live'
  const activeSnapshotId = 'snapshot-live-active'
  const retiredSnapshotId = 'snapshot-live-retired'

  await insertProject({projectId})

  const reviewConfigHash = await getCurrentReviewConfigHash(projectId)

  await insertSnapshot({
    components: visibilityComponents,
    projectId,
    reviewConfigHash,
    snapshotId: activeSnapshotId,
    status: 'active',
  })
  await insertSnapshot({
    components: visibilityComponents,
    projectId,
    reviewConfigHash,
    snapshotId: retiredSnapshotId,
    status: 'retired',
  })
  await insertRequest({
    projectId,
    requestedComponents: ['llmStatus'],
    requestId: 'rebuild:served',
    reviewConfigHash,
    status: 'blocked_over_budget',
  })
  await insertRequest({
    projectId,
    requestedComponents: ['llmStatus'],
    requestId: 'rebuild:old-config',
    reviewConfigHash: oldReviewConfigHash,
    status: 'blocked_over_budget',
  })
  await insertRequest({
    projectId,
    reason: 'searchDirtyWork',
    requestedComponents: ['search'],
    requestId: 'rebuild:unserved',
    reviewConfigHash,
    status: 'blocked_over_budget',
  })
  await insertRequest({
    projectId,
    reason: 'humanStatusDirtyWork',
    requestedComponents: ['humanStatus'],
    requestId: 'rebuild:dirty',
    reviewConfigHash,
    status: 'blocked_over_budget',
  })
  await insertRequest({
    projectId,
    requestedComponents: ['queue'],
    requestId: 'rebuild:recent',
    reviewConfigHash,
    status: 'blocked_over_budget',
    updatedHoursAgo: 0.1,
  })
  // Requests planned before review configs were recorded: current only through a chunk of a current-config snapshot.
  await insertRequest({
    projectId,
    requestedComponents: ['display'],
    requestId: 'rebuild:legacy-unknown',
    reviewConfigHash: null,
    status: 'blocked_over_budget',
  })
  await insertChunk({
    chunkId: 'chunk:legacy-unknown',
    component: 'display',
    projectId,
    requestId: 'rebuild:legacy-unknown',
    snapshotId: null,
    status: 'blocked_over_budget',
  })
  await insertRequest({
    projectId,
    requestedComponents: ['display'],
    requestId: 'rebuild:legacy-current',
    reviewConfigHash: null,
    status: 'blocked_over_budget',
  })
  await insertChunk({
    chunkId: 'chunk:legacy-current',
    component: 'display',
    projectId,
    requestId: 'rebuild:legacy-current',
    snapshotId: retiredSnapshotId,
    status: 'blocked_over_budget',
  })
  // Nothing admits a request pending admission, so it goes once settled even though its component has open work.
  await insertRequest({
    projectId,
    reason: 'humanStatusDirtyWork',
    requestedComponents: ['humanStatus'],
    requestId: 'rebuild:pending-admission',
    reviewConfigHash,
    status: 'pending_admission',
  })
  await insertRequest({
    projectId,
    reason: 'searchDirtyWork',
    requestedComponents: ['search'],
    requestId: 'rebuild:open',
    reviewConfigHash,
    status: 'admitted',
  })
  await insertChunk({
    chunkId: 'chunk:open',
    component: 'search',
    projectId,
    requestId: 'rebuild:open',
    snapshotId: activeSnapshotId,
    status: 'pending',
  })
  await insertRequest({
    lastError: 'Out of Memory',
    projectId,
    requestedComponents: ['llmStatus'],
    requestId: 'rebuild:retryable',
    reviewConfigHash: oldReviewConfigHash,
    status: 'failed',
  })
  await insertChunk({
    chunkId: 'chunk:retryable',
    projectId,
    requestId: 'rebuild:retryable',
    retryCount: 1,
    snapshotId: null,
    status: 'failed',
  })
  await getDatabase().run(`
    INSERT INTO app.review_serving_dirty_work (
      dirty_work_id, project_id, scope_kind, scope_id, article_id, projection_key, dirty_kind, source_partition,
      first_source_high_water_mark, latest_source_high_water_mark, projection_component, projection_identity, status
    ) VALUES (
      'dirty-work-live-human', '${projectId}', 'article', 'article:article-10', 'article-10', 'humanStatus-key',
      'humanJudgment', 'reviewChange:live', 1, 1, 'humanStatus', 'humanStatus:${projectId}', 'pending'
    )
  `)

  const result = await runCleanup({projectId})

  expect(getClosedRequestSummary(result)).toEqual([
    ['rebuild:legacy-current', 'componentsServed', 'blocked_over_budget'],
    ['rebuild:legacy-unknown', 'reviewConfigChanged', 'blocked_over_budget'],
    ['rebuild:old-config', 'reviewConfigChanged', 'blocked_over_budget'],
    ['rebuild:pending-admission', 'neverAdmittable', 'pending_admission'],
    ['rebuild:served', 'componentsServed', 'blocked_over_budget'],
  ])
  expect([...result.keptRequestIds].sort()).toEqual(['rebuild:dirty', 'rebuild:unserved'])
  expect(await getRequests(projectId)).toEqual([
    {lastError: null, requestId: 'rebuild:dirty', status: 'blocked_over_budget'},
    {
      lastError: 'superseded: the active snapshot serves every component it asked for',
      requestId: 'rebuild:legacy-current',
      status: 'failed',
    },
    {lastError: 'superseded: review config changed', requestId: 'rebuild:legacy-unknown', status: 'failed'},
    {lastError: 'superseded: review config changed', requestId: 'rebuild:old-config', status: 'failed'},
    {lastError: null, requestId: 'rebuild:open', status: 'admitted'},
    {
      lastError: 'superseded: nothing admits a request pending admission',
      requestId: 'rebuild:pending-admission',
      status: 'failed',
    },
    {lastError: null, requestId: 'rebuild:recent', status: 'blocked_over_budget'},
    {lastError: 'Out of Memory', requestId: 'rebuild:retryable', status: 'failed'},
    {
      lastError: 'superseded: the active snapshot serves every component it asked for',
      requestId: 'rebuild:served',
      status: 'failed',
    },
    {lastError: null, requestId: 'rebuild:unserved', status: 'blocked_over_budget'},
  ])
  expect(await getChunks(projectId)).toEqual([
    {chunkId: 'chunk:legacy-current', status: 'blocked_over_budget'},
    {chunkId: 'chunk:open', status: 'pending'},
    {chunkId: 'chunk:retryable', status: 'failed'},
  ])
  expect(await getSnapshotStatuses(projectId)).toEqual([
    {snapshotId: activeSnapshotId, status: 'active'},
    {snapshotId: retiredSnapshotId, status: 'retired'},
  ])

  // Kept requests are not looked at again on every cycle.
  expect((await runCleanup({projectId})).keptRequestIds).toEqual([])
})

test('chunk rows of closed requests go once nothing can read them, a bounded batch at a time', async () => {
  const projectId = 'project-chunk-rows'
  const retiredSnapshotId = 'snapshot-chunk-rows-retired'

  await insertProject({projectId})
  await insertSnapshot({
    components: ['llmStatus'],
    projectId,
    reviewConfigHash: 'review-config-chunk-rows',
    snapshotId: retiredSnapshotId,
    status: 'retired',
  })
  await insertRequest({
    lastError: 'superseded by newer foreground rebuild request',
    projectId,
    requestedComponents: ['llmStatus'],
    requestId: 'rebuild:superseded',
    status: 'failed',
    updatedHoursAgo: 0,
  })
  await insertChunk({
    chunkId: 'chunk:superseded-unbuilt',
    projectId,
    requestId: 'rebuild:superseded',
    snapshotId: null,
    status: 'failed',
  })
  await insertChunk({
    chunkId: 'chunk:superseded-built',
    projectId,
    requestId: 'rebuild:superseded',
    snapshotId: null,
    status: 'completed',
  })
  await insertChunk({
    chunkId: 'chunk:superseded-gone-built',
    projectId,
    requestId: 'rebuild:superseded',
    snapshotId: 'snapshot-gone',
    status: 'completed',
  })
  await insertChunk({
    chunkId: 'chunk:superseded-gone-blocked',
    projectId,
    requestId: 'rebuild:superseded',
    snapshotId: 'snapshot-gone',
    status: 'blocked_over_budget',
  })
  await insertChunk({
    chunkId: 'chunk:superseded-retired',
    projectId,
    requestId: 'rebuild:superseded',
    snapshotId: retiredSnapshotId,
    status: 'failed',
  })
  await insertRequest({
    lastError: 'coalesced into rebuild train rebuild:train',
    projectId,
    requestedComponents: ['llmStatus'],
    requestId: 'rebuild:coalesced',
    status: 'cancelled',
    updatedHoursAgo: 0,
  })
  await insertChunk({
    chunkId: 'chunk:coalesced',
    projectId,
    requestId: 'rebuild:coalesced',
    snapshotId: null,
    status: 'failed',
  })
  await insertRequest({
    projectId,
    requestedComponents: ['llmStatus'],
    requestId: 'rebuild:completed',
    status: 'completed',
    updatedHoursAgo: 0,
  })
  await insertChunk({
    chunkId: 'chunk:completed-gone',
    projectId,
    requestId: 'rebuild:completed',
    snapshotId: 'snapshot-gone',
    status: 'completed',
  })
  await insertRequest({
    lastError: 'Out of Memory',
    projectId,
    requestedComponents: ['llmStatus'],
    requestId: 'rebuild:retryable',
    status: 'failed',
    updatedHoursAgo: 0,
  })
  await insertChunk({
    chunkId: 'chunk:retryable',
    projectId,
    requestId: 'rebuild:retryable',
    retryCount: 1,
    snapshotId: null,
    status: 'failed',
  })
  await insertRequest({
    projectId,
    requestedComponents: ['llmStatus'],
    requestId: 'rebuild:admitted',
    status: 'admitted',
    updatedHoursAgo: 0,
  })
  await insertChunk({
    chunkId: 'chunk:admitted',
    projectId,
    requestId: 'rebuild:admitted',
    snapshotId: null,
    status: 'pending',
  })

  const first = await runCleanup({maxChunkRows: 2, projectId})
  const second = await runCleanup({maxChunkRows: 10, projectId})

  expect([first.deletedChunkRows, second.deletedChunkRows]).toEqual([2, 3])
  expect(await getChunks(projectId)).toEqual([
    {chunkId: 'chunk:admitted', status: 'pending'},
    {chunkId: 'chunk:retryable', status: 'failed'},
    {chunkId: 'chunk:superseded-built', status: 'completed'},
    {chunkId: 'chunk:superseded-retired', status: 'failed'},
  ])
})

// Queues article dirty work of one component, claims it and parks the claim behind a rebuild request, the way the
// projector does when the request it asked for is not admitted.
const parkDirtyWorkClaim = async (projectId: string, component: ReviewServingProjectionComponent) => {
  const [{getReviewServingDirtyWorkScopeForChange}, dirtyWorkService, {buildReviewDirtyProjectionIdentity}] =
    await Promise.all([
      import('./reviewServingProjectorDomain.ts'),
      import('./reviewServingDirtyWorkService.ts'),
      import('./reviewProjectionIdentity.ts'),
    ])
  const scope = getReviewServingDirtyWorkScopeForChange({
    changeKind: 'judgment.llm.created',
    sourceHighWaterMark: 3,
    sourcePartition: `judgmentSqliteOutboxImport:job-${projectId}`,
    values: {
      articleId: `${projectId}-article-a`,
      contentFlags: {useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true},
      judgmentId: `judgment-${projectId}`,
      modelId: 'model-stale',
      projectId,
      promptId: `prompt-${projectId}`,
      sourceHighWaterMark: 3,
    },
  })

  if (scope === null) {
    throw new Error('expected an article dirty work scope')
  }

  await dirtyWorkService.upsertReviewServingDirtyWork(
    {
      projectionComponent: component,
      projectionIdentity: buildReviewDirtyProjectionIdentity({projectId, projectionComponent: component}),
      scope,
    },
    getDatabase(),
  )

  const claims = await dirtyWorkService.claimReviewServingDirtyWork(
    {limit: 10, projectionComponent: component},
    getDatabase(),
  )
  const claimIds = claims.map((claim) => {
    return claim.dirtyWorkId
  })

  await dirtyWorkService.blockReviewServingDirtyWorkClaimsForRebuild(claimIds, getDatabase())

  return claimIds
}

const requeueParkedClaims = async () => {
  const {requeueReviewServingDirtyWorkBlockedByRebuild} = await import('./reviewServingDirtyWorkService.ts')

  return requeueReviewServingDirtyWorkBlockedByRebuild({limit: 10, minBlockedSeconds: 0}, getDatabase())
}

// A project with a prompt and two articles in scope, enough for the planner to bootstrap and extend its snapshots.
const insertProjectWithArticles = async (projectId: string) => {
  const articleValues = ['article-a', 'article-b']
    .map((articleId) => {
      return `('${projectId}-${articleId}')`
    })
    .join(', ')

  await insertProject({projectId})
  await getDatabase().run(`INSERT INTO app.prompt (id, original_text) VALUES ('prompt-${projectId}', 'Relevant?')`)
  await getDatabase().run(`
    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled, archived)
    VALUES ('project-prompt-${projectId}', '${projectId}', 'prompt-${projectId}', 0, TRUE, FALSE)
  `)
  await getDatabase().run(`
    INSERT INTO app.article (id, article_id, article_title, article_summary, article_created_at, article_updated_at)
    SELECT id, 'external-' || id, 'Title ' || id, 'Abstract ' || id, TIMESTAMPTZ '2026-09-20T10:00:00Z',
      TIMESTAMPTZ '2026-09-20T10:00:00Z'
    FROM (VALUES ${articleValues}) article(id)
  `)
  await getDatabase().run(`
    INSERT INTO app.project_article (id, project_id, article_id)
    SELECT '${projectId}:' || id, '${projectId}', id
    FROM (VALUES ${articleValues}) article(id)
  `)
  await getDatabase().run(`
    INSERT INTO mart.project_scope_article (
      project_id, article_id, in_curated_scope, in_route_scope, article_title, article_created_at
    )
    SELECT '${projectId}', id, TRUE, FALSE, 'Title ' || id, TIMESTAMPTZ '2026-09-20T10:00:00Z'
    FROM (VALUES ${articleValues}) article(id)
  `)
}

// An archived project keeps its active snapshot and its dirty work; once unarchived, the claims a dead request held
// come back and the planner builds what the closed requests would have built.
test('unarchiving a project after its requests were closed requests again what it needs', async () => {
  const [{requestReviewServingV4Rebuild}, {claimReviewServingDirtyWork}, {countReadyReviewServingComponents}] =
    await Promise.all([
      import('./reviewServingV4RebuildRequestService.ts'),
      import('./reviewServingDirtyWorkService.ts'),
      import('./reviewServingContracts.ts'),
    ])
  const projectId = 'project-unarchive'

  await insertProjectWithArticles(projectId)

  const bootstrap = await requestReviewServingV4Rebuild({
    components: [...countReadyReviewServingComponents],
    pageFirstOnly: true,
    projectId,
    reason: 'missingReviewServingSnapshot',
  })
  const [activeSnapshot] = await getSnapshotStatuses(projectId)

  await getDatabase().run(`
    UPDATE app.review_rebuild_chunk_manifest
    SET status = 'completed', started_at = current_timestamp, completed_at = current_timestamp
    WHERE request_id = '${bootstrap.requestId}'
  `)
  await getDatabase().run(`
    UPDATE app.review_rebuild_request SET status = 'completed' WHERE request_id = '${bootstrap.requestId}'
  `)
  await getDatabase().run(`
    UPDATE app.review_serving_snapshot_manifest SET snapshot_status = 'active', activated_at = current_timestamp
    WHERE snapshot_id = '${activeSnapshot?.snapshotId}'
  `)

  const searchBuild = await requestReviewServingV4Rebuild({
    components: ['search'],
    priority: 75,
    projectId,
    reason: 'searchDirtyWork',
  })
  if (activeSnapshot === undefined) {
    throw new Error('expected an active snapshot')
  }

  const claimIds = await parkDirtyWorkClaim(projectId, 'llmStatus')

  // A request left from before admission existed: nothing admits it, and it holds the parked claim forever.
  await insertRequest({
    projectId,
    requestedComponents: ['llmStatus'],
    requestId: 'rebuild:unarchive-legacy',
    status: 'pending_admission',
  })
  await archiveProject(projectId, true)

  expect(claimIds).toHaveLength(1)
  expect(await requeueParkedClaims()).toEqual({requeuedCount: 0})

  const closed = await runCleanup({projectId})

  expect(getClosedRequestSummary(closed)).toEqual([
    [searchBuild.requestId, 'projectArchived', 'admitted'],
    ['rebuild:unarchive-legacy', 'projectArchived', 'pending_admission'],
  ])
  expect(await requeueParkedClaims()).toEqual({requeuedCount: 1})
  expect(await getSnapshotStatuses(projectId)).toEqual([{snapshotId: activeSnapshot.snapshotId, status: 'active'}])

  await archiveProject(projectId, false)

  const reclaimed = await claimReviewServingDirtyWork({limit: 10, projectionComponent: 'llmStatus'}, getDatabase())
  const replanned = await requestReviewServingV4Rebuild({
    components: ['search'],
    priority: 75,
    projectId,
    reason: 'searchDirtyWork',
  })
  const replannedChunks = await getDatabase().queryJson<{component: string; snapshotId: string; status: string}>(`
    SELECT DISTINCT projection_component AS component, snapshot_id AS snapshotId, status
    FROM app.review_rebuild_chunk_manifest
    WHERE request_id = '${replanned.requestId}'
  `)

  expect(
    reclaimed.map((claim) => {
      return claim.dirtyWorkId
    }),
  ).toEqual(claimIds)
  expect(replanned.status).toBe('admitted')
  expect(replannedChunks).toEqual([{component: 'search', snapshotId: activeSnapshot.snapshotId, status: 'pending'}])
})

// Snapshot ids are deterministic, so the bootstrap an unarchived project plans again can land on the candidate the
// cleanup failed: it takes that id over and builds it again.
test('a project unarchived before its first snapshot was built bootstraps again', async () => {
  const [{requestReviewServingV4Rebuild}, {countReadyReviewServingComponents}] = await Promise.all([
    import('./reviewServingV4RebuildRequestService.ts'),
    import('./reviewServingContracts.ts'),
  ])
  const projectId = 'project-unarchive-bootstrap'
  const requestBootstrap = () => {
    return requestReviewServingV4Rebuild({
      components: [...countReadyReviewServingComponents],
      pageFirstOnly: true,
      projectId,
      reason: 'missingReviewServingSnapshot',
    })
  }
  const getBootstrapChunkStatuses = async (requestId: string) => {
    return getDatabase().queryJson<{snapshotId: string; status: string}>(`
      SELECT DISTINCT snapshot_id AS snapshotId, status
      FROM app.review_rebuild_chunk_manifest
      WHERE request_id = '${requestId}'
    `)
  }

  await insertProjectWithArticles(projectId)

  const bootstrap = await requestBootstrap()
  const [candidate] = await getSnapshotStatuses(projectId)

  if (candidate === undefined) {
    throw new Error('expected a bootstrap candidate')
  }

  await archiveProject(projectId, true)

  const closed = await runCleanup({projectId})

  expect(getClosedRequestSummary(closed)).toEqual([[bootstrap.requestId, 'projectArchived', 'admitted']])
  expect(await getSnapshotStatuses(projectId)).toEqual([{snapshotId: candidate.snapshotId, status: 'failed'}])

  await archiveProject(projectId, false)

  const rebootstrap = await requestBootstrap()
  const snapshots = await getSnapshotStatuses(projectId)
  const liveCandidates = snapshots.filter((snapshot) => {
    return snapshot.status === 'candidate'
  })

  expect(rebootstrap.status).toBe('admitted')
  expect(liveCandidates).toHaveLength(1)
  expect(await getBootstrapChunkStatuses(rebootstrap.requestId)).toEqual([
    {snapshotId: liveCandidates[0]?.snapshotId ?? '', status: 'pending'},
  ])
})

// A request pending admission covers its components in the parked-claim requeue at any age, and a parked claim is open
// dirty work of that component, so the served test alone would never let either go.
test('a settled request pending admission on a live project stops holding the claims parked behind it', async () => {
  const projectId = 'project-live-pending-admission'

  await insertProject({projectId})

  const claimIds = await parkDirtyWorkClaim(projectId, 'humanStatus')

  await insertRequest({
    projectId,
    reason: 'humanStatusDirtyWork',
    requestedComponents: ['humanStatus'],
    requestId: 'rebuild:live-pending-admission',
    reviewConfigHash: await getCurrentReviewConfigHash(projectId),
    status: 'pending_admission',
  })

  expect(claimIds).toHaveLength(1)
  expect(await requeueParkedClaims()).toEqual({requeuedCount: 0})

  const result = await runCleanup({projectId})

  expect(getClosedRequestSummary(result)).toEqual([
    ['rebuild:live-pending-admission', 'neverAdmittable', 'pending_admission'],
  ])
  expect(await requeueParkedClaims()).toEqual({requeuedCount: 1})

  await getDatabase().run(`
    UPDATE app.review_serving_dirty_work SET status = 'completed' WHERE project_id = '${projectId}'
  `)
  await getDatabase().run(`
    UPDATE app.review_serving_dirty_work_claim_state SET status = 'completed' WHERE project_id = '${projectId}'
  `)
})

test('diagnostics report the rebuild state of a project whose stale requests were closed as healthy', async () => {
  const {getReviewServingDiagnostics} = await import('./reviewServingDiagnosticsRepository.ts')
  const projectId = 'project-diagnostics'
  const activeSnapshotId = 'snapshot-diagnostics-active'

  await insertProject({projectId})

  const reviewConfigHash = await getCurrentReviewConfigHash(projectId)

  await insertSnapshot({
    components: visibilityComponents,
    projectId,
    reviewConfigHash,
    snapshotId: activeSnapshotId,
    status: 'active',
  })
  // The rebuild that built the active snapshot, finished before the blocked request was planned.
  await insertRequest({
    projectId,
    reason: 'missingReviewServingSnapshot',
    requestedComponents: visibilityComponents,
    requestId: 'rebuild:diagnostics-built',
    reviewConfigHash,
    status: 'completed',
    updatedHoursAgo: 3,
  })
  await insertChunk({
    chunkId: 'chunk:diagnostics-built',
    component: 'display',
    projectId,
    requestId: 'rebuild:diagnostics-built',
    snapshotId: activeSnapshotId,
    status: 'completed',
  })
  await insertRequest({
    projectId,
    reason: 'selectedImportDirtyWork',
    requestedComponents: ['selectedImport'],
    requestId: 'rebuild:diagnostics-blocked',
    reviewConfigHash: oldReviewConfigHash,
    status: 'blocked_over_budget',
  })
  await insertChunk({
    chunkId: 'chunk:diagnostics-blocked',
    component: 'selectedImport',
    projectId,
    requestId: 'rebuild:diagnostics-blocked',
    snapshotId: activeSnapshotId,
    status: 'blocked_over_budget',
  })

  const getRebuildChunkState = async () => {
    const {rebuildChunks} = await getReviewServingDiagnostics({projectId, reviewConfigHash}, getDatabase())

    return {
      blockedOverBudgetCount: rebuildChunks.blockedOverBudgetCount,
      failedCount: rebuildChunks.failedCount,
      pendingCount: rebuildChunks.pendingCount,
    }
  }

  expect(await getRebuildChunkState()).toEqual({blockedOverBudgetCount: 1, failedCount: 0, pendingCount: 0})
  expect(getClosedRequestSummary(await runCleanup({projectId}))).toEqual([
    ['rebuild:diagnostics-blocked', 'reviewConfigChanged', 'blocked_over_budget'],
  ])
  expect(await getRebuildChunkState()).toEqual({blockedOverBudgetCount: 0, failedCount: 0, pendingCount: 0})
})

test('each pass is bounded and stops before touching anything once foreground work is waiting', async () => {
  const projectId = 'project-bounded'
  const candidateSnapshotId = 'snapshot-bounded'

  await insertProject({archived: true, projectId})
  await insertSnapshot({
    components: ['display'],
    projectId,
    reviewConfigHash: 'review-config-bounded',
    snapshotId: candidateSnapshotId,
    status: 'candidate',
  })
  await insertRequest({projectId, requestedComponents: ['display'], requestId: 'rebuild:bounded', status: 'admitted'})
  await ['a', 'b', 'c'].reduce<Promise<void>>(async (previous, suffix) => {
    await previous
    await insertChunk({
      chunkId: `chunk:bounded-${suffix}`,
      component: 'display',
      projectId,
      requestId: 'rebuild:bounded',
      snapshotId: candidateSnapshotId,
      status: 'pending',
    })
  }, Promise.resolve())

  const getChunkStatuses = async () => {
    return (await getChunks(projectId)).map((chunk) => {
      return chunk.status
    })
  }
  const yielded = await runCleanup({
    projectId,
    shouldYield: () => {
      return true
    },
  })

  expect(yielded).toMatchObject({closedRequests: [], deletedChunkRows: 0, failedChunkRows: 0, stopReason: 'yield'})
  expect(await getRequests(projectId)).toEqual([{lastError: null, requestId: 'rebuild:bounded', status: 'admitted'}])

  const first = await runCleanup({maxChunkRows: 1, projectId})

  expect(getClosedRequestSummary(first)).toEqual([['rebuild:bounded', 'projectArchived', 'admitted']])
  expect((await getChunkStatuses()).sort()).toEqual(['failed', 'pending', 'pending'])
  expect(await getSnapshotStatuses(projectId)).toEqual([{snapshotId: candidateSnapshotId, status: 'candidate'}])

  await runCleanup({maxChunkRows: 1, projectId})

  const last = await runCleanup({maxChunkRows: 1, projectId})

  expect(await getChunkStatuses()).toEqual(['failed', 'failed', 'failed'])
  expect(last.failedSnapshots).toEqual([{projectId, snapshotId: candidateSnapshotId}])
})

test('a live project evaluates a bounded batch of its never-admitted requests per pass', async () => {
  const projectId = 'project-live-bounded'

  await insertProject({projectId})

  const reviewConfigHash = await getCurrentReviewConfigHash(projectId)

  await ['a', 'b'].reduce<Promise<void>>(async (previous, suffix) => {
    await previous
    await insertRequest({
      projectId,
      requestedComponents: ['llmStatus'],
      requestId: `rebuild:live-bounded-${suffix}`,
      reviewConfigHash: oldReviewConfigHash,
      status: 'blocked_over_budget',
      updatedHoursAgo: suffix === 'a' ? 3 : 2,
    })
  }, Promise.resolve())

  expect(reviewConfigHash).not.toBe(oldReviewConfigHash)
  expect(getClosedRequestSummary(await runCleanup({maxRequests: 1, projectId}))).toEqual([
    ['rebuild:live-bounded-a', 'reviewConfigChanged', 'blocked_over_budget'],
  ])
  expect(getClosedRequestSummary(await runCleanup({maxRequests: 1, projectId}))).toEqual([
    ['rebuild:live-bounded-b', 'reviewConfigChanged', 'blocked_over_budget'],
  ])
})
