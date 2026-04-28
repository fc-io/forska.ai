import {expect, test} from 'bun:test'

const getLastJsonLine = (value: string) => {
  const lines = value
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      return line.startsWith('{') && line.endsWith('}')
    })

  const [lastLine = ''] = lines.slice(-1)

  if (lastLine === '') {
    throw new Error(`Expected JSON output but received: ${value}`)
  }

  return lastLine
}

test('judgment import cron stays enabled at the low-memory cap', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').pathname
        }

        const judgmentsJobsModulePath = getModulePath('./src/server/cron/judgmentsJobs.ts')
        const serverIdentityModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobServerIdentity.ts')
        const backgroundImportModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteBackgroundImport.ts')
        const sqliteServiceModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts')
        const addToQueueModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.ts')
        const checkStatusModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsCheckLLMStatus.ts')
        const cleanupModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsCleanupStale.ts')
        const getRunningJobsModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsGetRunningJobs.ts')
        const sendToLlmModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.ts')
        const runtimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
        const runtimeLoggerModulePath = getModulePath('./src/server/utils/runtimeLogger.ts')
        const cronConfigs = []
        const importCalls = []

        process.env.DUCKDB_MEMORY_LIMIT = '6400MiB'

        void mock.module('elysia', () => {
          return {
            Elysia: class {
              use() {
                return this
              }
            },
          }
        })
        void mock.module('@elysiajs/cron', () => {
          return {
            cron: (config) => {
              cronConfigs.push(config)
              return () => {}
            },
          }
        })
        void mock.module(serverIdentityModulePath, () => {
          return {getDefaultJudgmentServerJobId: () => 'server-low-memory'}
        })
        void mock.module(backgroundImportModulePath, () => {
          return {
            runJudgmentJobSqliteBackgroundImport: async ({claimedBy}) => {
              importCalls.push(claimedBy)
              return {attemptedCount: 1, failedCount: 0, skippedCount: 0, succeededCount: 1}
            },
          }
        })
        void mock.module(sqliteServiceModulePath, () => {
          return {
            getJudgmentJobSqliteService: () => {
              return {syncOwnedLeases: async () => {}}
            },
          }
        })
        void mock.module(addToQueueModulePath, () => {
          return {judgmentsJobsAddToQueue: async () => {}}
        })
        void mock.module(checkStatusModulePath, () => {
          return {judgmentsJobsCheckLLMStatus: async () => {}}
        })
        void mock.module(cleanupModulePath, () => {
          return {judgmentsJobsCleanupStale: async () => {}}
        })
        void mock.module(getRunningJobsModulePath, () => {
          return {judgmentsJobsGetRunningJobs: async () => []}
        })
        void mock.module(sendToLlmModulePath, () => {
          return {judgmentsJobsSendToLLM: async () => {}}
        })
        void mock.module(runtimeRoleModulePath, () => {
          return {
            isExpectedDuckdbOwnerRoleLossError: () => false,
            shouldCurrentServerRunJudgingLoops: () => true,
            shouldCurrentServerRunMaintenanceLoops: () => true,
          }
        })
        void mock.module(runtimeLoggerModulePath, () => {
          return {
            getRuntimeLogProfile: () => 'local',
            isRuntimeJsonlSinkInstalled: () => false,
            writeRuntimeFailureLogEvent: () => {},
            writeRuntimeLogEvent: () => false,
          }
        })

        await import(judgmentsJobsModulePath + '?low-memory-import=' + Date.now())
        const importCron = cronConfigs.find((config) => {
          return config.name === 'judgments-jobs-import-judgments'
        })
        await importCron.run()

        console.log(JSON.stringify({importCalls}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString() || runScript.stdout.toString() || 'Judgment import cron low-memory test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {importCalls: string[]}

  expect(result.importCalls).toEqual(['server-low-memory'])
})
