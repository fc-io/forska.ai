import {expect, test} from 'bun:test'

test('judge worker preflight quarantine writes through the DuckDB owner', async () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')
        const originalLog = console.log
        console.warn = () => undefined
        console.error = () => undefined

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').pathname
        }

        const preflightModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqlitePreflight.ts')
        const appDatabaseServiceModulePath = getModulePath('./src/server/services/appDatabaseService.ts')
        const sqliteServiceModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts')
        const serverRuntimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
        let directDuckdbWrites = 0
        let ownerRequest = null

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            getAppDatabaseService: () => {
              return {
                run: async () => {
                  directDuckdbWrites += 1
                },
              }
            },
          }
        })
        void mock.module(sqliteServiceModulePath, () => {
          return {
            getJudgmentJobSqliteService: () => {
              return {
                hasJob: () => true,
                runIsolatedPreflight: async () => {
                  throw new Error('disk I/O error')
                },
              }
            },
          }
        })
        void mock.module(serverRuntimeRoleModulePath, () => {
          return {
            canCurrentServerOwnDuckdb: () => false,
            getCurrentServerDuckdbOwnerUrl: async () => 'http://owner.test',
          }
        })

        globalThis.fetch = async (url, init) => {
          ownerRequest = {body: init?.body, method: init?.method, url: String(url)}
          return new Response(JSON.stringify({data: {ok: true}, error: null}), {status: 200})
        }

        const {filterRunningJobsBySqlitePreflight} = await import(preflightModulePath + '?owner-quarantine=' + Date.now())
        const jobs = await filterRunningJobsBySqlitePreflight([{id: 'job-1', storageState: 'active'}])

        originalLog(JSON.stringify({directDuckdbWrites, jobs, ownerRequest}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env, SERVER_DUCKDB_OWNER_URL: 'http://owner.test'}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString() || runScript.stdout.toString() || 'preflight owner quarantine test failed',
    )
  }

  const result = JSON.parse(runScript.stdout.toString()) as {
    directDuckdbWrites: number
    jobs: unknown[]
    ownerRequest: {body: string; method: string; url: string}
  }

  expect(result.jobs).toEqual([])
  expect(result.directDuckdbWrites).toBe(0)
  expect(result.ownerRequest.method).toBe('POST')
  expect(result.ownerRequest.url).toBe('http://owner.test/__duckdb-owner-rpc/api/judgmentsjobs/job-1/quarantine')
  expect(JSON.parse(result.ownerRequest.body)).toEqual({reason: 'disk I/O error'})
})
