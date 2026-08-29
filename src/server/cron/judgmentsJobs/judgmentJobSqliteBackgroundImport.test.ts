import {expect, test} from 'bun:test'

const getLastJsonLine = (output: string) => {
  return output
    .trim()
    .split('\n')
    .reverse()
    .find((line) => {
      try {
        JSON.parse(line)
        return true
      } catch {
        return false
      }
    })
}

test('background import continues past an idle job to the next job with outbox work', () => {
  const run = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')
        const moduleUrl = (path) => new URL(path, 'file://' + process.cwd() + '/').href
        const appDatabaseServicePath = moduleUrl('./src/server/services/appDatabaseService.ts')
        const jobPathsPath = moduleUrl('./src/server/cron/judgmentsJobs/judgmentJobPaths.ts')
        const outboxImportPath = moduleUrl('./src/server/cron/judgmentsJobs/judgmentJobSqliteOutboxImport.ts')
        const sqliteServicePath = moduleUrl('./src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts')
        const cycles = []

        void mock.module(appDatabaseServicePath, () => ({
          getAppDatabaseService: () => ({
            queryJson: async (statement) => {
              if (statement.includes('FROM app.judgment_job')) {
                return [
                  {id: 'job-a-idle', storageState: 'active'},
                  {id: 'job-b-ready', storageState: 'active'},
                ]
              }
              return []
            },
            queryJsonBackground: async (statement) => {
              if (statement.includes('FROM app.judgment_job')) {
                return [
                  {id: 'job-a-idle', storageState: 'active'},
                  {id: 'job-b-ready', storageState: 'active'},
                ]
              }
              return []
            },
            run: async () => {},
            runBackground: async () => {},
          }),
        }))
        void mock.module(jobPathsPath, () => ({
          getJudgmentJobSqliteJobIds: () => ['job-a-idle', 'job-b-ready'],
        }))
        void mock.module(outboxImportPath, () => ({
          runJudgmentJobSqliteOutboxImportCycle: async ({jobId}) => {
            cycles.push(jobId)
            return {status: 'imported'}
          },
        }))
        void mock.module(sqliteServicePath, () => ({
          getJudgmentJobSqliteService: () => ({
            getHealthSnapshot: async (jobId) => ({
              claimedOutboxCount: 0,
              hasOutboxRows: jobId === 'job-b-ready',
            }),
            hasOwnedLease: () => false,
            releaseOwnedLease: async () => {},
            syncOwnedLeases: async () => {},
          }),
        }))

        const {runJudgmentJobSqliteBackgroundImport} = await import(
          moduleUrl('./src/server/cron/judgmentsJobs/judgmentJobSqliteBackgroundImport.ts') + '?fairness=' + Date.now()
        )
        const summary = await runJudgmentJobSqliteBackgroundImport({claimedBy: 'maintenance-owner'})
        console.log(JSON.stringify({cycles, summary}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (run.exitCode !== 0) {
    throw new Error(run.stderr.toString() || run.stdout.toString())
  }

  const result = JSON.parse(getLastJsonLine(run.stdout.toString()) ?? '{}') as {
    cycles: string[]
    summary: {attemptedCount: number; skippedCount: number; succeededCount: number}
  }

  expect(result.cycles).toEqual(['job-b-ready'])
  expect(result.summary).toMatchObject({attemptedCount: 2, skippedCount: 1, succeededCount: 1})
})
