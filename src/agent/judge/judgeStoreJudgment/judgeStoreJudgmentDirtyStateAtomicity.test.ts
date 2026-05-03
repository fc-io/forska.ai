import {afterAll, beforeAll, expect, test} from 'bun:test'

import {createTempRuntimeRoot} from '../../../server/test/createTempRuntimeRoot.ts'
import type {ShortIdMapping} from '../judgeGetPrompt.ts'

const tempRuntimeRoot = createTempRuntimeRoot('f1-judge-store-judgment-dirty-atomicity')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.RUN_SERVER_JUDGING = 'false'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

let closeDatabase: (() => Promise<void>) | null = null
let queryDatabase: (<T>(statement: string) => Promise<T[]>) | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null

beforeAll(async () => {
  const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] =
    await Promise.all([
      import('../../../db/migrateDuckdb.ts'),
      import('../../../server/services/appDatabaseService.ts'),
      import('../../../server/utils/duckdbService.ts'),
      import('../../../server/utils/serverRuntimeRole.ts'),
    ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()

  await migrateDuckdb()

  const database = getAppDatabaseService()

  closeDatabase = () => {
    return database.close()
  }
  queryDatabase = (statement: string) => {
    return database.queryJson(statement)
  }
  runDatabase = (statement: string) => {
    return database.run(statement)
  }
})

afterAll(async () => {
  await closeDatabase?.()
  tempRuntimeRoot.cleanup()
})

test('judgeStoreJudgment rolls back the judgment when dirty-state marking fails', async () => {
  if (!queryDatabase || !runDatabase) {
    throw new Error('Test database not initialized')
  }

  const {judgeStoreJudgment} = await import('../judgeStoreJudgment.ts')
  const {getProjectMartDirtyRefreshStateService} =
    await import('../../../server/services/projectMartDirtyRefreshStateService.ts')
  const refreshStateService = getProjectMartDirtyRefreshStateService()
  const originalMarkArticleProjectsDirtyAtomically = refreshStateService.markArticleProjectsDirtyAtomically
  const originalConsoleError = console.error
  const now = Date.now()
  const connectionId = `connection-judge-store-atomic-${now}`
  const modelId = `model-judge-store-atomic-${now}`
  const projectId = `project-judge-store-atomic-${now}`
  const promptId = `prompt-judge-store-atomic-${now}`
  const articleId = `article-judge-store-atomic-${now}`
  const shortIdMapping: ShortIdMapping = new Map([['p001', promptId]])
  let receivedRunner = false

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', 'Judge Store Atomic Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('${articleId}', 'Article')
  `)
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('${promptId}', 'Prompt', '${promptId}-hash')
  `)

  refreshStateService.markArticleProjectsDirtyAtomically = async (params) => {
    receivedRunner = params.runner != null
    throw new Error('dirty mark failed inside transaction')
  }
  console.error = () => {}

  try {
    await judgeStoreJudgment(
      articleId,
      'Article',
      {'p001---explanation': 'because', 'p001---question': ['include'], 'p001---quotes': ['quote']},
      modelId,
      [promptId],
      projectId,
      shortIdMapping,
    )
  } finally {
    refreshStateService.markArticleProjectsDirtyAtomically = originalMarkArticleProjectsDirtyAtomically
    console.error = originalConsoleError
  }

  const [row] = await queryDatabase<{judgmentRows: number; refreshRows: number}>(`
    SELECT
      (SELECT COUNT(*) FROM app.judgment WHERE article_id = '${articleId}') AS judgmentRows,
      (SELECT COUNT(*) FROM app.project_mart_refresh_state WHERE project_id = '${projectId}') AS refreshRows
  `)

  expect(receivedRunner).toBe(true)
  expect(Number(row?.judgmentRows ?? 0)).toBe(0)
  expect(Number(row?.refreshRows ?? 0)).toBe(0)
})
