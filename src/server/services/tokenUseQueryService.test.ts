import {afterAll, beforeAll, expect, test} from 'bun:test'
import {rmSync} from 'fs'

const tempDbPath = `/tmp/f1-token-use-query-service-${process.pid}-${Date.now()}.duckdb`

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempDbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.RUN_SERVER_JUDGING = 'false'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

let closeDatabase: (() => Promise<void>) | null = null
let tokenUseQueryService: Awaited<typeof import('./tokenUseQueryService.ts')>['tokenUseQueryService'] | null = null

beforeAll(async () => {
  const [
    {migrateDuckdb},
    {getAppDatabaseService},
    {resetDuckdbServiceForTests},
    {resetServerRuntimeRoleForTests},
    tokenUseQueryServiceModule,
  ] = await Promise.all([
    import('../../db/migrateDuckdb.ts'),
    import('./appDatabaseService.ts'),
    import('../utils/duckdbService.ts'),
    import('../utils/serverRuntimeRole.ts'),
    import('./tokenUseQueryService.ts'),
  ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()

  await migrateDuckdb()

  const database = getAppDatabaseService()

  closeDatabase = () => {
    return database.close()
  }
  tokenUseQueryService = tokenUseQueryServiceModule.tokenUseQueryService
})

afterAll(async () => {
  await closeDatabase?.()
  rmSync(tempDbPath, {force: true})
  rmSync(`${tempDbPath}.writer.history.json`, {force: true})
  rmSync(`${tempDbPath}.writer.lock`, {force: true})
})

test('insertTokenUse generates an id when one is not provided', async () => {
  if (!tokenUseQueryService) {
    throw new Error('Token use query service not initialized')
  }

  const row = await tokenUseQueryService.insertTokenUse({
    judgment_job_id: null,
    requests: 1,
    total_prompt_tokens: 10,
    total_completion_tokens: 5,
    total_tokens: 15,
  })

  expect(row).not.toBeNull()
  expect(row?.id.length ?? 0).toBeGreaterThan(0)
  expect(row?.requests).toBe(1)
  expect(Number(row?.totalTokens ?? 0)).toBe(15)
})
