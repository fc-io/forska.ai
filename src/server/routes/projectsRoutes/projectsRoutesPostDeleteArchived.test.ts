import {afterAll, beforeAll, expect, test} from 'bun:test'
import {Elysia} from 'elysia'

import {createTempRuntimeRoot} from '../../test/createTempRuntimeRoot.ts'

const tempRuntimeRoot = createTempRuntimeRoot('f2-delete-archived-route')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

let app: {handle: (request: Request) => Promise<Response>} | null = null
let database: {
  close: () => Promise<void>
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
} | null = null

beforeAll(async () => {
  const [{migrateDuckdb}, {getAppDatabaseService}, {projectsRoutesPostDeleteArchived}] = await Promise.all([
    import('../../../db/migrateDuckdb.ts'),
    import('../../services/appDatabaseService.ts'),
    import('./projectsRoutesPostDeleteArchived.ts'),
  ])

  await migrateDuckdb()
  database = getAppDatabaseService()
  app = new Elysia().use(projectsRoutesPostDeleteArchived)
})

afterAll(async () => {
  await database?.close()
  tempRuntimeRoot.cleanup()
})

const seedProject = async (params: {archived: boolean; projectId: string}) => {
  if (!database) {
    throw new Error('Database not initialized')
  }

  await database.run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('connection-${params.projectId}', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1');

    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES (
      'model-${params.projectId}',
      'connection-${params.projectId}',
      'Qwen/Qwen3.5-35B-A3B',
      'Qwen/Qwen3.5-35B-A3B',
      'Qwen 35B',
      'manual',
      TRUE
    );

    INSERT INTO app.project (
      id,
      name,
      model_id,
      archived,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images
    )
    VALUES (
      '${params.projectId}',
      'Delete Archived ${params.projectId}',
      'model-${params.projectId}',
      ${params.archived ? 'TRUE' : 'FALSE'},
      TRUE,
      TRUE,
      FALSE,
      FALSE
    );
  `)
}

test('delete archived route tombstones archived projects without deleting project identity rows', async () => {
  if (!app || !database) {
    throw new Error('Test app not initialized')
  }

  await seedProject({archived: true, projectId: 'delete-archived-tombstone-project'})
  await database.run(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('delete-archived-tombstone-job', 'delete-archived-tombstone-project', 'running')
  `)

  const response = await app.handle(
    new Request('http://localhost/api/projects/delete-archived', {
      body: JSON.stringify({projectIds: ['delete-archived-tombstone-project']}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const [project] = await database.queryJson<{deletePendingAt: unknown; projectRows: number}>(`
    SELECT
      COUNT(*)::INTEGER AS projectRows,
      (
        SELECT requested_at
        FROM app.archived_project_delete_tombstone
        WHERE project_id = 'delete-archived-tombstone-project'
      ) AS deletePendingAt
    FROM app.project
    WHERE id = 'delete-archived-tombstone-project'
  `)
  const [job] = await database.queryJson<{status: string; storageState: string}>(`
    SELECT status, storage_state AS storageState
    FROM app.judgment_job
    WHERE id = 'delete-archived-tombstone-job'
  `)

  expect(response.status).toBe(200)
  expect(project?.projectRows).toBe(1)
  expect(project?.deletePendingAt).toBeTruthy()
  expect(job).toEqual({status: 'project_removed', storageState: 'draining'})
})

test('delete archived route rejects active projects', async () => {
  if (!app) {
    throw new Error('Test app not initialized')
  }

  await seedProject({archived: false, projectId: 'delete-archived-active-project'})

  const response = await app.handle(
    new Request('http://localhost/api/projects/delete-archived', {
      body: JSON.stringify({projectIds: ['delete-archived-active-project']}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )

  expect(response.status).toBe(500)
  expect(await response.text()).toContain('Only archived projects can be deleted')
})
