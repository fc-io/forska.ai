import {rmSync} from 'node:fs'

import {afterAll, beforeAll, expect, test} from 'bun:test'
import {Elysia} from 'elysia'

const tempDbPath = `/tmp/f1-prompts-routes-${process.pid}-${Date.now()}.duckdb`

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempDbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

let app: {handle: (request: Request) => Promise<Response>} | null = null
let closeDatabase: (() => Promise<void>) | null = null
let queryDatabase: (<T>(statement: string) => Promise<T[]>) | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null

beforeAll(async () => {
  const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {promptsRoutes}] = await Promise.all([
    import('../../db/migrateDuckdb.ts'),
    import('../services/appDatabaseService.ts'),
    import('../utils/duckdbService.ts'),
    import('./PromptsRoutes.ts'),
  ])

  resetDuckdbServiceForTests()
  await migrateDuckdb()

  const database = getAppDatabaseService()

  closeDatabase = () => {
    return database.close()
  }
  queryDatabase = <T>(statement: string) => {
    return database.queryJson<T>(statement)
  }
  runDatabase = (statement: string) => {
    return database.run(statement)
  }
  app = new Elysia().use(promptsRoutes)
})

afterAll(async () => {
  await closeDatabase?.()
  rmSync(tempDbPath, {force: true})
  rmSync(`${tempDbPath}.writer.history.json`, {force: true})
  rmSync(`${tempDbPath}.writer.lock`, {force: true})
})

const insertPromptFixture = async ({promptId}: {promptId: string}) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('${promptId}', 'Comparison delete regression prompt', '${promptId}-hash')
  `)
}

const insertComparisonProjectPromptFixture = async ({
  comparisonProjectId,
  promptId,
}: {
  comparisonProjectId: string
  promptId: string
}) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  await runDatabase(`
    INSERT INTO app.comparison_project (id, name)
    VALUES ('${comparisonProjectId}', 'Prompt dependency comparison project')
  `)
  await runDatabase(`
    INSERT INTO app.comparison_project_prompt (id, comparison_project_id, prompt_id, prompt_order)
    VALUES ('${comparisonProjectId}-prompt-link', '${comparisonProjectId}', '${promptId}', 0)
  `)
}

test('deleting a prompt is blocked when a comparison project still references it', async () => {
  if (!app || !queryDatabase) {
    throw new Error('Test app not initialized')
  }

  const promptId = `comparison-project-prompt-${Date.now()}`
  const comparisonProjectId = `comparison-project-${Date.now()}`

  await insertPromptFixture({promptId})
  await insertComparisonProjectPromptFixture({comparisonProjectId, promptId})

  const response = await app.handle(new Request(`http://localhost/api/prompts/${promptId}`, {method: 'DELETE'}))
  const body = (await response.json()) as {data: null; error: string}
  const [remainingPrompt] = await queryDatabase<{id: string}>(`
    SELECT id
    FROM app.prompt
    WHERE id = '${promptId}'
  `)

  expect(response.status).toBe(409)
  expect(body.error).toBe('Prompt delete blocked. Remove project, comparison project, and judgment references first.')
  expect(remainingPrompt?.id).toBe(promptId)
})
