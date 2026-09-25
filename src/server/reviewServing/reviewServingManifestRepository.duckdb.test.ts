import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'
import type {ReviewServingProjectionComponent} from './reviewServingContracts.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('review-serving-snapshot-independent-availability')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const reviewConfigHash = 'review-config-availability'

let database: ReturnType<typeof getAppDatabaseService> | null = null

const getDatabase = () => {
  if (database === null) {
    throw new Error('Database not initialized')
  }

  return database
}

const getIdentity = (component: ReviewServingProjectionComponent, projectId: string) => {
  return `${component}:${projectId}`
}

const getSelectedImportSnapshotId = (projectId: string) => {
  return `selected-import-${projectId}`
}

const getComponentStateJson = (projectId: string, components: readonly ReviewServingProjectionComponent[]) => {
  return JSON.stringify({
    optional: [],
    required: components.map((component) => {
      return {
        baseGeneration: '0',
        component,
        patchWatermark: '0',
        projectionIdentity: getIdentity(component, projectId),
        requirement: 'required',
      }
    }),
  })
}

const insertProject = async (projectId: string) => {
  await getDatabase().run(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', '${projectId}', 'model-availability', TRUE, TRUE, FALSE, FALSE)
  `)
  await getDatabase().run(`
    INSERT INTO app.review_selected_import_snapshot (selected_import_snapshot_id, project_id, project_scope_identity, status)
    VALUES (
      '${getSelectedImportSnapshotId(projectId)}',
      '${projectId}',
      '${getIdentity('projectScope', projectId)}',
      'completed'
    )
  `)
}

const upsertProjectionManifest = async (input: {
  component: ReviewServingProjectionComponent
  invalidationReason?: string
  patchWatermark?: number
  projectId: string
  status: 'active' | 'candidate'
}) => {
  const {upsertReviewServingProjectionIdentityManifest} = await import('./reviewServingManifestRepository.ts')

  await upsertReviewServingProjectionIdentityManifest(
    {
      baseGeneration: 0,
      definitionVersion: `${input.component}:test`,
      inputWatermark: input.patchWatermark ?? 0,
      invalidationReason: input.invalidationReason ?? null,
      patchWatermark: input.patchWatermark ?? 0,
      projectId: input.projectId,
      projectionComponent: input.component,
      projectionIdentity: getIdentity(input.component, input.projectId),
      reviewConfigHash,
      status: input.status,
    },
    getDatabase(),
  )
}

const insertSnapshot = async (input: {
  components: readonly ReviewServingProjectionComponent[]
  projectId: string
  snapshotId: string
  status: 'active' | 'candidate'
}) => {
  await getDatabase().run(`
    INSERT INTO app.review_serving_snapshot_manifest (
      project_id, snapshot_id, snapshot_status, review_config_hash, composed_identity_json, component_state_json,
      required_components_json, optional_components_json, source_watermarks_json, selected_import_snapshot_id
    ) VALUES (
      '${input.projectId}',
      '${input.snapshotId}',
      '${input.status}',
      '${reviewConfigHash}',
      '{}'::JSON,
      '${getComponentStateJson(input.projectId, input.components)}'::JSON,
      '${JSON.stringify(input.components)}'::JSON,
      '[]'::JSON,
      '{}'::JSON,
      '${getSelectedImportSnapshotId(input.projectId)}'
    )
  `)
}

const insertRequest = async (input: {projectId: string; requestId: string; status: string}) => {
  await getDatabase().run(`
    INSERT INTO app.review_rebuild_request (
      request_id, project_id, reason, requested_components_json, priority, status, admission_state
    ) VALUES (
      '${input.requestId}', '${input.projectId}', 'availabilityTest', '["display"]'::JSON, 100, '${input.status}', 'admitted'
    )
  `)
}

const insertChunk = async (input: {
  chunkId: string
  component: ReviewServingProjectionComponent
  projectId: string
  requestId: string
  snapshotId: string
  status: string
}) => {
  await getDatabase().run(`
    INSERT INTO app.review_rebuild_chunk_manifest (
      chunk_id, request_id, project_id, snapshot_id, projection_component, projection_identity, chunk_start_key,
      chunk_end_key, output_base_generation, status, admission_state
    ) VALUES (
      '${input.chunkId}',
      '${input.requestId}',
      '${input.projectId}',
      '${input.snapshotId}',
      '${input.component}',
      '${getIdentity(input.component, input.projectId)}',
      'article-a',
      'article-z',
      0,
      '${input.status}',
      'admitted'
    )
  `)
}

const getAvailableRequiredComponents = async (projectId: string, snapshotId: string) => {
  const {getReviewServingSnapshotManifest} = await import('./reviewServingManifestRepository.ts')
  const manifest = await getReviewServingSnapshotManifest(
    {componentStateMode: 'available', projectId, snapshotId},
    getDatabase(),
  )

  return (manifest?.componentState.required ?? [])
    .map((state) => {
      return state.component
    })
    .sort()
}

const getSnapshotStatuses = async (projectId: string) => {
  return getDatabase().queryJson<{snapshotId: string; status: string}>(`
    SELECT snapshot_id AS snapshotId, snapshot_status AS status
    FROM app.review_serving_snapshot_manifest
    WHERE project_id = '${projectId}'
    ORDER BY snapshot_id
  `)
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

  await getDatabase().run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('connection-availability', 'sglang', 'SGLang', TRUE, 'none', 'https://worker.example.test')
  `)
  await getDatabase().run(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled, variant, metadata_json)
    VALUES ('model-availability', 'connection-availability', 'Qwen/Qwen3.5-122B-A10B', 'Qwen/Qwen3.5-122B-A10B', 'Qwen 122B', 'manual', TRUE, 'thinking', '{}'::JSON)
  `)
})

afterAll(async () => {
  await database?.close()
  tempRuntimeRoot.cleanup()
})

test('a candidate that reused projectScope and selectedImport stays promotable after their shared manifests move back to candidate', async () => {
  const {promoteReviewServingProjectorSnapshot} = await import('./reviewServingProjectorWriter.ts')
  const projectId = 'project-reused-scope'
  const components = ['projectScope', 'selectedImport', 'display'] as const

  await insertProject(projectId)
  await upsertProjectionManifest({component: 'projectScope', projectId, status: 'active'})
  await upsertProjectionManifest({component: 'selectedImport', projectId, status: 'active'})
  await upsertProjectionManifest({component: 'display', projectId, status: 'candidate'})
  await insertSnapshot({components, projectId, snapshotId: 'snapshot-active', status: 'active'})
  await insertSnapshot({components, projectId, snapshotId: 'snapshot-reused-scope', status: 'candidate'})
  await insertRequest({projectId, requestId: 'rebuild:reused-scope', status: 'admitted'})
  await insertChunk({
    chunkId: 'chunk:reused-scope-display',
    component: 'display',
    projectId,
    requestId: 'rebuild:reused-scope',
    snapshotId: 'snapshot-reused-scope',
    status: 'completed',
  })
  await upsertProjectionManifest({
    component: 'projectScope',
    invalidationReason: 'project.reviewConfig.updated',
    patchWatermark: 13,
    projectId,
    status: 'candidate',
  })
  await upsertProjectionManifest({component: 'selectedImport', projectId, status: 'candidate'})

  const promotion = await promoteReviewServingProjectorSnapshot(
    {projectId, reviewConfigHash, snapshotId: 'snapshot-reused-scope'},
    getDatabase(),
  )

  expect(promotion).toEqual({promoted: true, snapshotId: 'snapshot-reused-scope'})
  expect(await getSnapshotStatuses(projectId)).toEqual([
    {snapshotId: 'snapshot-active', status: 'retired'},
    {snapshotId: 'snapshot-reused-scope', status: 'active'},
  ])
})

test('snapshot-independent components still follow their own chunks and snapshot components still need chunks or an active manifest', async () => {
  const {promoteReviewServingProjectorSnapshot} = await import('./reviewServingProjectorWriter.ts')
  const projectId = 'project-unbuilt-components'

  await insertProject(projectId)
  await upsertProjectionManifest({component: 'projectScope', projectId, status: 'candidate'})
  await upsertProjectionManifest({component: 'display', projectId, status: 'candidate'})
  await insertSnapshot({
    components: ['projectScope', 'display'],
    projectId,
    snapshotId: 'snapshot-unbuilt-display',
    status: 'candidate',
  })
  await insertSnapshot({
    components: ['projectScope', 'display'],
    projectId,
    snapshotId: 'snapshot-rebuilding-scope',
    status: 'candidate',
  })
  await insertRequest({projectId, requestId: 'rebuild:rebuilding-scope', status: 'admitted'})
  await insertChunk({
    chunkId: 'chunk:rebuilding-scope-project-scope',
    component: 'projectScope',
    projectId,
    requestId: 'rebuild:rebuilding-scope',
    snapshotId: 'snapshot-rebuilding-scope',
    status: 'pending',
  })
  await insertChunk({
    chunkId: 'chunk:rebuilding-scope-display',
    component: 'display',
    projectId,
    requestId: 'rebuild:rebuilding-scope',
    snapshotId: 'snapshot-rebuilding-scope',
    status: 'completed',
  })

  expect(await getAvailableRequiredComponents(projectId, 'snapshot-unbuilt-display')).toEqual(['projectScope'])
  expect(await getAvailableRequiredComponents(projectId, 'snapshot-rebuilding-scope')).toEqual(['display'])

  const promotion = await promoteReviewServingProjectorSnapshot(
    {projectId, reviewConfigHash, snapshotId: 'snapshot-unbuilt-display'},
    getDatabase(),
  )

  expect(promotion).toEqual({
    error: 'required component display is missing from snapshot state',
    promoted: false,
    snapshotId: 'snapshot-unbuilt-display',
  })
})

test('other in-flight rebuild detection ignores the excluded request and completed requests', async () => {
  const {hasOtherInFlightRebuildForCandidateSnapshot} = await import('./reviewServingManifestRepository.ts')
  const projectId = 'project-in-flight'
  const snapshotId = 'snapshot-in-flight'
  const getHasOtherInFlightRebuild = (excludedRequestId: string) => {
    return hasOtherInFlightRebuildForCandidateSnapshot({excludedRequestId, projectId, snapshotId}, getDatabase())
  }

  await insertProject(projectId)
  await insertSnapshot({components: ['display'], projectId, snapshotId, status: 'candidate'})
  await insertRequest({projectId, requestId: 'rebuild:finalizing', status: 'running'})
  await insertChunk({
    chunkId: 'chunk:finalizing',
    component: 'display',
    projectId,
    requestId: 'rebuild:finalizing',
    snapshotId,
    status: 'completed',
  })
  await insertRequest({projectId, requestId: 'rebuild:completed-owner', status: 'completed'})
  await insertChunk({
    chunkId: 'chunk:completed-owner',
    component: 'display',
    projectId,
    requestId: 'rebuild:completed-owner',
    snapshotId,
    status: 'completed',
  })

  expect(await getHasOtherInFlightRebuild('rebuild:finalizing')).toBe(false)
  expect(await getHasOtherInFlightRebuild('rebuild:completed-owner')).toBe(true)

  await insertRequest({projectId, requestId: 'rebuild:building-owner', status: 'admitted'})
  await insertChunk({
    chunkId: 'chunk:building-owner',
    component: 'display',
    projectId,
    requestId: 'rebuild:building-owner',
    snapshotId,
    status: 'completed',
  })

  expect(await getHasOtherInFlightRebuild('rebuild:finalizing')).toBe(true)
})
