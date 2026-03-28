import {rmSync} from 'node:fs'

import {afterAll, beforeAll, expect, test} from 'bun:test'
import {Elysia} from 'elysia'

const tempDbPath = `/tmp/f1-subprojects-routes-${process.pid}-${Date.now()}.duckdb`

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempDbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

let app: {handle: (request: Request) => Promise<Response>} | null = null
let closeDatabase: (() => Promise<void>) | null = null
let flushMartRefreshes: (() => Promise<void>) | null = null
let queryDatabase: (<T>(statement: string) => Promise<T[]>) | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null

const getSqlLiteral = (value: string | null) => {
  return value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`
}

const insertProjectFixture = async ({
  connectionId,
  modelId,
  projectId,
}: {
  connectionId: string
  modelId: string
  projectId: string
}) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none')
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'Qwen/Qwen3.5-122B-A10B', 'Qwen/Qwen3.5-122B-A10B', 'Qwen 122B', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', 'Subproject Source', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
}

const insertProjectPromptFixture = async ({
  originalText,
  projectId,
  projectPromptId,
  promptId,
}: {
  originalText: string
  projectId: string
  projectPromptId: string
  promptId: string
}) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, transformed_text, prompt_heading, type, content_hash, archived)
    VALUES (
      '${promptId}',
      ${getSqlLiteral(originalText)},
      NULL,
      'ai',
      'string',
      'subproject-source-prompt-hash',
      FALSE
    )
  `)
  await runDatabase(`
    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, archived, enabled, origin_project_id)
    VALUES ('${projectPromptId}', '${projectId}', '${promptId}', 0, FALSE, TRUE, '${projectId}')
  `)
}

beforeAll(async () => {
  const [
    {migrateDuckdb},
    {getAppDatabaseService},
    {resetDuckdbServiceForTests},
    {resetServerRuntimeRoleForTests},
    {getDuckdbMartRefreshService},
    {subprojectsRoutes},
  ] = await Promise.all([
    import('../../db/migrateDuckdb.ts'),
    import('../services/appDatabaseService.ts'),
    import('../utils/duckdbService.ts'),
    import('../utils/serverRuntimeRole.ts'),
    import('../services/getDuckdbMartRefreshService.ts'),
    import('./SubprojectsRoutes.ts'),
  ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()

  await migrateDuckdb()

  const database = getAppDatabaseService()

  closeDatabase = () => {
    return database.close()
  }
  flushMartRefreshes = () => {
    return getDuckdbMartRefreshService().flush()
  }
  queryDatabase = (statement: string) => {
    return database.queryJson(statement)
  }
  runDatabase = (statement: string) => {
    return database.run(statement)
  }
  app = new Elysia().use(subprojectsRoutes)
})

afterAll(async () => {
  await flushMartRefreshes?.()
  await closeDatabase?.()
  rmSync(tempDbPath, {force: true})
})

test('subproject route detaches selected prompt ids from source projects', async () => {
  if (!app || !queryDatabase || !flushMartRefreshes) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'subproject-detach-connection'
  const modelId = 'subproject-detach-model'
  const sourceProjectId = 'subproject-detach-source-project'
  const sourcePromptId = 'subproject-detach-source-prompt'

  await insertProjectFixture({connectionId, modelId, projectId: sourceProjectId})
  await insertProjectPromptFixture({
    originalText: 'Is this about AI?',
    projectId: sourceProjectId,
    projectPromptId: 'subproject-detach-project-prompt',
    promptId: sourcePromptId,
  })

  const response = await app.handle(
    new Request('http://localhost/api/subprojects', {
      body: JSON.stringify({
        name: 'Detached subproject',
        description: 'subproject description',
        modelId,
        promptSelections: [{promptId: sourcePromptId, types: []}],
        sourceProjectIds: [],
      }),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const body = (await response.json()) as {data: {project: {id: string}}}
  const subprojectId = body.data.project.id

  expect(response.status).toBe(200)

  const rows = await queryDatabase<{
    contentHash: string | null
    originalText: string
    originProjectId: string | null
    projectId: string
    promptId: string
  }>(`
    SELECT
      pp.project_id AS projectId,
      pp.origin_project_id AS originProjectId,
      p.id AS promptId,
      p.original_text AS originalText,
      p.content_hash AS contentHash
    FROM app.project_prompt pp
    INNER JOIN app.prompt p ON p.id = pp.prompt_id
    WHERE pp.project_id IN ('${sourceProjectId}', '${subprojectId}')
    ORDER BY pp.project_id ASC
  `)
  const sourcePrompt = rows.find((row) => {
    return row.projectId === sourceProjectId
  })
  const subprojectPrompt = rows.find((row) => {
    return row.projectId === subprojectId
  })

  expect(sourcePrompt?.promptId).toBe(sourcePromptId)
  expect(subprojectPrompt?.promptId).not.toBe(sourcePromptId)
  expect(subprojectPrompt?.originalText).toBe(sourcePrompt?.originalText)
  expect(subprojectPrompt?.contentHash).toBe(null)
  expect(subprojectPrompt?.originProjectId).toBe(subprojectId)

  await flushMartRefreshes()
})
