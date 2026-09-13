import {readFileSync} from 'node:fs'

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

test('maintenance judgment cron module does not import judging cron module', () => {
  const source = readFileSync('src/server/cron/judgmentsJobs.ts', 'utf8')
  const operationalSource = readFileSync('src/server/cron/judgmentsJobsOperationalCron.ts', 'utf8')

  expect(source).not.toContain('judgmentsJobsJudgingCron')
  expect(operationalSource).not.toContain('judgmentsJobsJudgingCron')
})

test('operational judgment cron module mounts the import-only cron source without heavy maintenance dependencies', () => {
  const source = readFileSync('src/server/cron/judgmentsJobsOperationalCron.ts', 'utf8')

  expect(source).toContain("import {judgmentsJobsImportCron} from './judgmentsJobsImportCron.ts'")
  expect(source).toContain('.use(judgmentsJobsImportCron)')
  expect(source).not.toContain('fullTextJobsCron')
  expect(source).not.toContain('fullTextConversionJobsCron')
  expect(source).not.toContain('nvidiaSmiCron')
})

test('import-only judgment cron module does not import maintenance cron dependencies', () => {
  const source = readFileSync('src/server/cron/judgmentsJobsImportCron.ts', 'utf8')

  expect(source).not.toContain('judgmentsJobsAddToQueue')
  expect(source).not.toContain('judgmentsJobsCheckLLMStatus')
  expect(source).not.toContain('judgmentsJobsCleanupStale')
  expect(source).not.toContain('judgmentsJobsSampleProviderTelemetry')
  expect(source).toContain('hasActiveDuckdbExclusiveWork() || hasActiveProjectTransferBackgroundActivity()')
})

test('judgment maintenance crons pause while DuckDB exclusive work is active', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')
        const {resolve} = await import('node:path')
        const {pathToFileURL} = await import('node:url')

        const getModulePath = (relativePath) => {
          return pathToFileURL(resolve(relativePath)).href
        }

        const judgmentsJobsModulePath = getModulePath('./src/server/cron/judgmentsJobs.ts')
        const serverIdentityModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobServerIdentity.ts')
        const addToQueueModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.ts')
        const checkStatusModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsCheckLLMStatus.ts')
        const cleanupModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsCleanupStale.ts')
        const sampleTelemetryModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsSampleProviderTelemetry.ts')
        const importCronModulePath = getModulePath('./src/server/cron/judgmentsJobsImportCron.ts')
        const exclusiveWorkModulePath = getModulePath('./src/server/utils/duckdbExclusiveWork.ts')
        const runtimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
        const runtimeLoggerModulePath = getModulePath('./src/server/utils/runtimeLogger.ts')
        const cronConfigs = []
        const calls = []

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
          return {getDefaultJudgmentServerJobId: () => 'server-exclusive-work'}
        })
        void mock.module(addToQueueModulePath, () => {
          return {judgmentsJobsAddToQueue: async () => calls.push('add-to-queue')}
        })
        void mock.module(checkStatusModulePath, () => {
          return {judgmentsJobsCheckLLMStatus: async () => calls.push('check-status')}
        })
        void mock.module(cleanupModulePath, () => {
          return {judgmentsJobsCleanupStale: async () => calls.push('cleanup-stale')}
        })
        void mock.module(sampleTelemetryModulePath, () => {
          return {judgmentsJobsSampleProviderTelemetry: async () => calls.push('sample-telemetry')}
        })
        void mock.module(importCronModulePath, () => {
          return {
            importJudgmentsCron: async () => calls.push('import'),
            judgmentsJobsImportCron: {},
          }
        })
        void mock.module(exclusiveWorkModulePath, () => {
          return {
            hasActiveDuckdbExclusiveWork: () => true,
            isDuckdbExclusiveWorkAdmissionError: () => false,
          }
        })
        void mock.module(runtimeRoleModulePath, () => {
          return {
            getCurrentServerRole: () => 'maintenance-worker',
            isExpectedDuckdbOwnerRoleLossError: () => false,
            shouldCurrentServerRunMaintenanceLoops: () => true,
          }
        })
        void mock.module(runtimeLoggerModulePath, () => {
          return {
            getRuntimeLogConfig: () => ({
              logDir: '/tmp/forska-test-logs',
              logLevel: 'INFO',
              logStderrLevel: 'ERROR',
              runtimeProfile: 'local',
            }),
            getRuntimeLogProfile: () => 'local',
            isRuntimeJsonlSinkInstalled: () => false,
            writeRuntimeFailureLogEvent: () => calls.push('failure-log'),
            writeRuntimeLogEvent: () => false,
          }
        })

        await import(judgmentsJobsModulePath)

        for (const name of [
          'judgments-jobs-add-to-queue',
          'judgments-jobs-cleanup-stale',
          'judgments-jobs-sample-provider-telemetry',
          'judgments-jobs-check-llm-status',
        ]) {
          const cronConfig = cronConfigs.find((config) => {
            return config.name === name
          })
          await cronConfig.run()
        }

        console.log(JSON.stringify({calls}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString() || runScript.stdout.toString() || 'Judgment maintenance exclusive-work test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {calls: string[]}

  expect(result.calls).toEqual([])
})

test('judgment import cron stays enabled at the low-memory cap', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').href
        }

        const judgmentsJobsModulePath = getModulePath('./src/server/cron/judgmentsJobsImportCron.ts')
        const serverIdentityModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobServerIdentity.ts')
        const backgroundImportModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteBackgroundImport.ts')
        const sqliteServiceModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts')
        const addToQueueModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.ts')
        const checkStatusModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsCheckLLMStatus.ts')
        const cleanupModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsCleanupStale.ts')
        const getRunningJobsModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsGetRunningJobs.ts')
        const sampleTelemetryModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsSampleProviderTelemetry.ts')
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
        void mock.module(sampleTelemetryModulePath, () => {
          return {judgmentsJobsSampleProviderTelemetry: async () => ({})}
        })
        void mock.module(sendToLlmModulePath, () => {
          return {judgmentsJobsSendToLLM: async () => {}}
        })
        void mock.module(runtimeRoleModulePath, () => {
          return {
            getCurrentServerRole: () => 'maintenance-worker',
            isExpectedDuckdbOwnerRoleLossError: () => false,
            shouldCurrentServerRunJudgingLoops: () => true,
            shouldCurrentServerRunMaintenanceLoops: () => true,
          }
        })
        void mock.module(runtimeLoggerModulePath, () => {
          return {
            getRuntimeLogConfig: () => ({
              logDir: '/tmp/forska-test-logs',
              logLevel: 'INFO',
              logStderrLevel: 'ERROR',
              runtimeProfile: 'local',
            }),
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

test('cleanup-stale partial budget result records cron success', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').href
        }

        const operationalModulePath = getModulePath('./src/server/cron/judgmentsJobsOperationalCron.ts')
        const runtimeStateModulePath = getModulePath('./src/server/cron/cronRuntimeState.ts')
        const serverIdentityModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobServerIdentity.ts')
        const addToQueueModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.ts')
        const checkStatusModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsCheckLLMStatus.ts')
        const cleanupModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsCleanupStale.ts')
        const importCronModulePath = getModulePath('./src/server/cron/judgmentsJobsImportCron.ts')
        const sampleTelemetryModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsSampleProviderTelemetry.ts')
        const exclusiveWorkModulePath = getModulePath('./src/server/utils/duckdbExclusiveWork.ts')
        const runtimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
        const runtimeLoggerModulePath = getModulePath('./src/server/utils/runtimeLogger.ts')
        const cronConfigs = []

        console.warn = () => {}

        void mock.module('elysia', () => {
          return {
            Elysia: class {
              constructor() {
                this.uses = []
              }

              use(plugin) {
                this.uses.push(plugin)
                return this
              }
            },
          }
        })
        void mock.module('@elysiajs/cron', () => {
          return {
            cron: (config) => {
              cronConfigs.push(config)
              return {config, name: config.name}
            },
          }
        })
        void mock.module(serverIdentityModulePath, () => {
          return {getDefaultJudgmentServerJobId: () => 'server-partial-cleanup'}
        })
        void mock.module(addToQueueModulePath, () => {
          return {judgmentsJobsAddToQueue: async () => {}}
        })
        void mock.module(checkStatusModulePath, () => {
          return {judgmentsJobsCheckLLMStatus: async () => {}}
        })
        void mock.module(cleanupModulePath, () => {
          return {
            judgmentsJobsCleanupStale: async () => ({
              completed: false,
              exhaustedBudget: true,
              partialReason: 'sqlite-retention-row-budget-exhausted',
              runId: 'cleanup-partial',
              steps: [],
              totals: {duckdbStepsUsed: 1, repairActionsUsed: 0, sqliteJobActionsUsed: 1, sqliteRetentionBatchesUsed: 1, sqliteRetentionRowsDeleted: 10},
            }),
          }
        })
        void mock.module(importCronModulePath, () => {
          return {judgmentsJobsImportCron: {}}
        })
        void mock.module(sampleTelemetryModulePath, () => {
          return {judgmentsJobsSampleProviderTelemetry: async () => ({})}
        })
        void mock.module(exclusiveWorkModulePath, () => {
          return {
            hasActiveDuckdbExclusiveWork: () => false,
            isDuckdbExclusiveWorkAdmissionError: () => false,
          }
        })
        void mock.module(runtimeRoleModulePath, () => {
          return {
            getCurrentServerRole: () => 'maintenance-worker',
            isExpectedDuckdbOwnerRoleLossError: () => false,
            shouldCurrentServerRunMaintenanceLoops: () => true,
          }
        })
        void mock.module(runtimeLoggerModulePath, () => {
          return {
            getRuntimeLogConfig: () => ({
              logDir: '/tmp/forska-test-logs',
              logLevel: 'INFO',
              logStderrLevel: 'ERROR',
              runtimeProfile: 'local',
            }),
            getRuntimeLogProfile: () => 'local',
            isRuntimeJsonlSinkInstalled: () => false,
            writeRuntimeFailureLogEvent: () => {},
            writeRuntimeLogEvent: () => false,
          }
        })

        const runtimeState = await import(runtimeStateModulePath)
        runtimeState.resetCronRuntimeStateForTests()
        await import(operationalModulePath)

        const cleanupCron = cronConfigs.find((config) => {
          return config.name === 'judgments-jobs-cleanup-stale'
        })

        if (!cleanupCron) {
          throw new Error('Expected cleanup cron')
        }

        await cleanupCron.run()

        const diagnostics = runtimeState.buildCronRuntimeDiagnostics({serverRole: 'maintenance-worker'})
        process.stdout.write(JSON.stringify({cleanup: diagnostics.crons['judgments-jobs-cleanup-stale']}) + '\\n')
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(runScript.stderr.toString() || runScript.stdout.toString() || 'Cleanup partial cron test failed')
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    cleanup: {lastFailureAt: string | null; lastSuccessAt: string | null; running: boolean}
  }

  expect(result.cleanup.lastSuccessAt).toBeTruthy()
  expect(result.cleanup.lastFailureAt).toBe(null)
  expect(result.cleanup.running).toBe(false)
})

test('stale cleanup-stale activity skips duplicate cleanup but does not block add-to-queue', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').href
        }

        const judgmentsJobsModulePath = getModulePath('./src/server/cron/judgmentsJobs.ts')
        const stateModulePath = getModulePath('./src/server/cron/judgmentsJobsCronState.ts')
        const serverIdentityModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobServerIdentity.ts')
        const backgroundImportModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteBackgroundImport.ts')
        const sqliteServiceModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts')
        const addToQueueModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.ts')
        const checkStatusModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsCheckLLMStatus.ts')
        const cleanupModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsCleanupStale.ts')
        const getRunningJobsModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsGetRunningJobs.ts')
        const sampleTelemetryModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsSampleProviderTelemetry.ts')
        const sendToLlmModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.ts')
        const exclusiveWorkModulePath = getModulePath('./src/server/utils/duckdbExclusiveWork.ts')
        const runtimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
        const runtimeLoggerModulePath = getModulePath('./src/server/utils/runtimeLogger.ts')
        const addCalls = []
        let cleanupCalls = 0
        let now = 1_000

        Date.now = () => now
        console.warn = () => {}

        void mock.module('elysia', () => {
          return {
            Elysia: class {
              constructor() {
                this.uses = []
              }

              use(plugin) {
                this.uses.push(plugin)
                return this
              }
            },
          }
        })
        void mock.module('@elysiajs/cron', () => {
          return {
            cron: (config) => {
              return {config, name: config.name}
            },
          }
        })
        void mock.module(serverIdentityModulePath, () => {
          return {getDefaultJudgmentServerJobId: () => 'server-stale-cleanup'}
        })
        void mock.module(backgroundImportModulePath, () => {
          return {runJudgmentJobSqliteBackgroundImport: async () => ({})}
        })
        void mock.module(sqliteServiceModulePath, () => {
          return {
            getJudgmentJobSqliteService: () => {
              return {publishHealthProjections: async () => {}, syncOwnedLeases: async () => {}}
            },
          }
        })
        void mock.module(addToQueueModulePath, () => {
          return {
            judgmentsJobsAddToQueue: async (serverJobId) => {
              addCalls.push(serverJobId)
            },
          }
        })
        void mock.module(checkStatusModulePath, () => {
          return {judgmentsJobsCheckLLMStatus: async () => {}}
        })
        void mock.module(cleanupModulePath, () => {
          return {
            judgmentsJobsCleanupStale: async () => {
              cleanupCalls += 1
              return {completed: true, exhaustedBudget: false, partialReason: null, steps: [], totals: {}}
            },
          }
        })
        void mock.module(getRunningJobsModulePath, () => {
          return {judgmentsJobsGetRunningJobs: async () => []}
        })
        void mock.module(sampleTelemetryModulePath, () => {
          return {judgmentsJobsSampleProviderTelemetry: async () => ({})}
        })
        void mock.module(sendToLlmModulePath, () => {
          return {judgmentsJobsSendToLLM: async () => {}}
        })
        void mock.module(exclusiveWorkModulePath, () => {
          return {
            hasActiveDuckdbExclusiveWork: () => false,
            isDuckdbExclusiveWorkAdmissionError: () => false,
          }
        })
        void mock.module(runtimeRoleModulePath, () => {
          return {
            getCurrentServerRole: () => 'maintenance-worker',
            isExpectedDuckdbOwnerRoleLossError: () => false,
            shouldCurrentServerRunJudgingLoops: () => false,
            shouldCurrentServerRunMaintenanceLoops: () => true,
          }
        })
        void mock.module(runtimeLoggerModulePath, () => {
          return {
            getRuntimeLogConfig: () => ({
              logDir: '/tmp/forska-test-logs',
              logLevel: 'INFO',
              logStderrLevel: 'ERROR',
              runtimeProfile: 'local',
            }),
            getRuntimeLogProfile: () => 'local',
            isRuntimeJsonlSinkInstalled: () => false,
            writeRuntimeFailureLogEvent: () => {},
            writeRuntimeLogEvent: () => false,
          }
        })

        const state = await import(stateModulePath)
        const cleanupRunId = state.beginJudgmentsCleanupStaleCronRun({budgetMs: 100, nowMs: 1_000})
        state.updateJudgmentsCleanupStaleCronStep({nowMs: 1_010, runId: cleanupRunId, step: 'prune-retention'})
        now = 1_200

        const cronModule = await import(judgmentsJobsModulePath + '?stale-cleanup=' + Math.random())
        const cleanupCron = cronModule.judgmentsJobsMaintenanceCron.uses.find((plugin) => {
          return plugin.name === 'judgments-jobs-cleanup-stale'
        })
        const addCron = cronModule.judgmentsJobsMaintenanceCron.uses.find((plugin) => {
          return plugin.name === 'judgments-jobs-add-to-queue'
        })

        if (!cleanupCron || !addCron) {
          throw new Error('Expected cleanup and add-to-queue crons')
        }

        await cleanupCron.config.run()
        await addCron.config.run()

        process.stdout.write(
          JSON.stringify({addCalls, cleanupCalls, cleanupActivity: state.getJudgmentsCleanupStaleCronActivity(now)}) + '\\n',
        )
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(runScript.stderr.toString() || runScript.stdout.toString() || 'Stale cleanup cron test failed')
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    addCalls: string[]
    cleanupActivity: {overBudget: boolean; shouldStartAnotherCleanupRun: boolean}
    cleanupCalls: number
  }

  expect(result.cleanupCalls).toBe(0)
  expect(result.addCalls).toEqual(['server-stale-cleanup'])
  expect(result.cleanupActivity).toMatchObject({overBudget: true, shouldStartAnotherCleanupRun: false})
})

test('judgment import cron skips while project transfer background work is active', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').href
        }

        const judgmentsJobsModulePath = getModulePath('./src/server/cron/judgmentsJobsImportCron.ts')
        const serverIdentityModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobServerIdentity.ts')
        const backgroundImportModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteBackgroundImport.ts')
        const runtimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
        const runtimeLoggerModulePath = getModulePath('./src/server/utils/runtimeLogger.ts')
        const projectTransferActivityModulePath = getModulePath('./src/server/services/projectTransfer/projectTransferBackgroundActivity.ts')
        const cronConfigs = []
        let importCallCount = 0

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
          return {getDefaultJudgmentServerJobId: () => 'server-transfer-active'}
        })
        void mock.module(backgroundImportModulePath, () => {
          return {
            runJudgmentJobSqliteBackgroundImport: async () => {
              importCallCount += 1
            },
          }
        })
        void mock.module(projectTransferActivityModulePath, () => {
          return {hasActiveProjectTransferBackgroundActivity: () => true}
        })
        void mock.module(runtimeRoleModulePath, () => {
          return {
            getCurrentServerRole: () => 'maintenance-worker',
            isExpectedDuckdbOwnerRoleLossError: () => false,
            shouldCurrentServerRunMaintenanceLoops: () => true,
          }
        })
        void mock.module(runtimeLoggerModulePath, () => {
          return {
            getRuntimeLogConfig: () => ({
              logDir: '/tmp/forska-test-logs',
              logLevel: 'INFO',
              logStderrLevel: 'ERROR',
              runtimeProfile: 'local',
            }),
            getRuntimeLogProfile: () => 'local',
            isRuntimeJsonlSinkInstalled: () => false,
            writeRuntimeFailureLogEvent: () => {},
            writeRuntimeLogEvent: () => false,
          }
        })

        await import(judgmentsJobsModulePath + '?transfer-active=' + Date.now())
        const importCron = cronConfigs.find((config) => {
          return config.name === 'judgments-jobs-import-judgments'
        })
        await importCron.run()

        console.log(JSON.stringify({importCallCount}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString() || runScript.stdout.toString() || 'Judgment import cron transfer guard test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {importCallCount: number}

  expect(result.importCallCount).toBe(0)
})

test('add-to-queue overlap warning waits for sustained running time', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').href
        }

        const judgmentsJobsModulePath = getModulePath('./src/server/cron/judgmentsJobs.ts')
        const serverIdentityModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobServerIdentity.ts')
        const backgroundImportModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteBackgroundImport.ts')
        const sqliteServiceModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts')
        const addToQueueModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.ts')
        const checkStatusModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsCheckLLMStatus.ts')
        const cleanupModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsCleanupStale.ts')
        const getRunningJobsModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsGetRunningJobs.ts')
        const sampleTelemetryModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsSampleProviderTelemetry.ts')
        const sendToLlmModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.ts')
        const runtimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
        const runtimeLoggerModulePath = getModulePath('./src/server/utils/runtimeLogger.ts')
        const warnings = []
        let addCalls = 0
        let now = 1000
        let resolveAdd = () => {}

        Date.now = () => now
        console.warn = (...args) => {
          warnings.push(args.map((arg) => String(arg)))
        }

        void mock.module('elysia', () => {
          return {
            Elysia: class {
              constructor() {
                this.uses = []
              }

              use(plugin) {
                this.uses.push(plugin)
                return this
              }
            },
          }
        })
        void mock.module('@elysiajs/cron', () => {
          return {
            cron: (config) => {
              return {config, name: config.name}
            },
          }
        })
        void mock.module(serverIdentityModulePath, () => {
          return {getDefaultJudgmentServerJobId: () => 'server-add-overlap'}
        })
        void mock.module(backgroundImportModulePath, () => {
          return {runJudgmentJobSqliteBackgroundImport: async () => ({})}
        })
        void mock.module(sqliteServiceModulePath, () => {
          return {
            getJudgmentJobSqliteService: () => {
              return {publishHealthProjections: async () => {}, syncOwnedLeases: async () => {}}
            },
          }
        })
        void mock.module(addToQueueModulePath, () => {
          return {
            judgmentsJobsAddToQueue: async () => {
              addCalls += 1
              await new Promise((resolve) => {
                resolveAdd = resolve
              })
            },
          }
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
        void mock.module(sampleTelemetryModulePath, () => {
          return {judgmentsJobsSampleProviderTelemetry: async () => ({})}
        })
        void mock.module(sendToLlmModulePath, () => {
          return {judgmentsJobsSendToLLM: async () => {}}
        })
        void mock.module(runtimeRoleModulePath, () => {
          return {
            getCurrentServerRole: () => 'maintenance-worker',
            isExpectedDuckdbOwnerRoleLossError: () => false,
            shouldCurrentServerRunJudgingLoops: () => false,
            shouldCurrentServerRunMaintenanceLoops: () => true,
          }
        })
        void mock.module(runtimeLoggerModulePath, () => {
          return {
            getRuntimeLogConfig: () => ({
              logDir: '/tmp/forska-test-logs',
              logLevel: 'INFO',
              logStderrLevel: 'ERROR',
              runtimeProfile: 'local',
            }),
            getRuntimeLogProfile: () => 'local',
            isRuntimeJsonlSinkInstalled: () => false,
            writeRuntimeFailureLogEvent: () => {},
            writeRuntimeLogEvent: () => false,
          }
        })

        const cronModule = await import(judgmentsJobsModulePath + '?add-overlap-warning=' + Date.now())
        const addCron = cronModule.judgmentsJobsMaintenanceCron.uses.find((plugin) => {
          return plugin.name === 'judgments-jobs-add-to-queue'
        })

        if (!addCron) {
          throw new Error('Expected add-to-queue cron on maintenance worker')
        }

        const firstRun = addCron.config.run()
        now = 30999
        await addCron.config.run()
        const beforeThresholdWarnings = warnings.length
        now = 31000
        await addCron.config.run()
        resolveAdd()
        await firstRun

        console.log(JSON.stringify({addCalls, beforeThresholdWarnings, warnings}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString() || runScript.stdout.toString() || 'Add-to-queue overlap warning test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    addCalls: number
    beforeThresholdWarnings: number
    warnings: string[][]
  }

  expect(result.addCalls).toBe(1)
  expect(result.beforeThresholdWarnings).toBe(0)
  expect(result.warnings).toHaveLength(1)
  expect(result.warnings[0]?.[0]).toBe('[cron] add-to-queue still running')
  expect(result.warnings[0]?.[1]).toContain('"runningForMs":30000')
})

test('add-to-queue cron starts a fresh run when a prior run is stale', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').href
        }

        const judgmentsJobsModulePath = getModulePath('./src/server/cron/judgmentsJobs.ts')
        const serverIdentityModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobServerIdentity.ts')
        const backgroundImportModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteBackgroundImport.ts')
        const sqliteServiceModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts')
        const addToQueueModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.ts')
        const checkStatusModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsCheckLLMStatus.ts')
        const cleanupModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsCleanupStale.ts')
        const getRunningJobsModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsGetRunningJobs.ts')
        const sampleTelemetryModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsSampleProviderTelemetry.ts')
        const sendToLlmModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.ts')
        const runtimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
        const runtimeLoggerModulePath = getModulePath('./src/server/utils/runtimeLogger.ts')
        const warnings = []
        const resolvers = []
        let addCalls = 0
        let now = 1000

        Date.now = () => now
        console.warn = (...args) => {
          warnings.push(args.map((arg) => String(arg)))
        }

        void mock.module('elysia', () => {
          return {
            Elysia: class {
              constructor() {
                this.uses = []
              }

              use(plugin) {
                this.uses.push(plugin)
                return this
              }
            },
          }
        })
        void mock.module('@elysiajs/cron', () => {
          return {
            cron: (config) => {
              return {config, name: config.name}
            },
          }
        })
        void mock.module(serverIdentityModulePath, () => {
          return {getDefaultJudgmentServerJobId: () => 'server-add-stale'}
        })
        void mock.module(backgroundImportModulePath, () => {
          return {runJudgmentJobSqliteBackgroundImport: async () => ({})}
        })
        void mock.module(sqliteServiceModulePath, () => {
          return {
            getJudgmentJobSqliteService: () => {
              return {publishHealthProjections: async () => {}, syncOwnedLeases: async () => {}}
            },
          }
        })
        void mock.module(addToQueueModulePath, () => {
          return {
            judgmentsJobsAddToQueue: async () => {
              addCalls += 1
              await new Promise((resolve) => {
                resolvers.push(resolve)
              })
            },
          }
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
        void mock.module(sampleTelemetryModulePath, () => {
          return {judgmentsJobsSampleProviderTelemetry: async () => ({})}
        })
        void mock.module(sendToLlmModulePath, () => {
          return {judgmentsJobsSendToLLM: async () => {}}
        })
        void mock.module(runtimeRoleModulePath, () => {
          return {
            getCurrentServerRole: () => 'maintenance-worker',
            isExpectedDuckdbOwnerRoleLossError: () => false,
            shouldCurrentServerRunJudgingLoops: () => false,
            shouldCurrentServerRunMaintenanceLoops: () => true,
          }
        })
        void mock.module(runtimeLoggerModulePath, () => {
          return {
            getRuntimeLogConfig: () => ({
              logDir: '/tmp/forska-test-logs',
              logLevel: 'INFO',
              logStderrLevel: 'ERROR',
              runtimeProfile: 'local',
            }),
            getRuntimeLogProfile: () => 'local',
            isRuntimeJsonlSinkInstalled: () => false,
            writeRuntimeFailureLogEvent: () => {},
            writeRuntimeLogEvent: () => false,
          }
        })

        const cronModule = await import(judgmentsJobsModulePath + '?add-stale-run=' + Date.now())
        const addCron = cronModule.judgmentsJobsMaintenanceCron.uses.find((plugin) => {
          return plugin.name === 'judgments-jobs-add-to-queue'
        })

        if (!addCron) {
          throw new Error('Expected add-to-queue cron on maintenance worker')
        }

        const firstRun = addCron.config.run()
        now = 31000
        await addCron.config.run()
        now = 121000
        const secondRun = addCron.config.run()
        await Promise.resolve()
        const callsAfterStaleStart = addCalls
        resolvers[0]()
        await firstRun
        now = 122000
        await addCron.config.run()
        const callsAfterStaleFinish = addCalls
        resolvers[1]()
        await secondRun

        console.log(JSON.stringify({callsAfterStaleFinish, callsAfterStaleStart, warnings}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString() || runScript.stdout.toString() || 'Add-to-queue stale latch test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    callsAfterStaleFinish: number
    callsAfterStaleStart: number
    warnings: string[][]
  }

  expect(result.callsAfterStaleStart).toBe(2)
  expect(result.callsAfterStaleFinish).toBe(2)
  expect(
    result.warnings.some((warning) => {
      return warning[0] === '[cron] stale add-to-queue latch ignored'
    }),
  ).toBe(true)
  expect(
    result.warnings.some((warning) => {
      return warning[0] === '[cron] add-to-queue still running'
    }),
  ).toBe(true)
})

test('llm status cron is owned by maintenance worker instead of judge worker', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').href
        }

        const judgmentsJobsModulePath = getModulePath('./src/server/cron/judgmentsJobs.ts')
        const judgmentsJobsJudgingCronModulePath = getModulePath('./src/server/cron/judgmentsJobsJudgingCron.ts')
        const serverIdentityModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobServerIdentity.ts')
        const backgroundImportModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteBackgroundImport.ts')
        const sqliteServiceModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts')
        const addToQueueModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.ts')
        const checkStatusModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsCheckLLMStatus.ts')
        const cleanupModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsCleanupStale.ts')
        const getRunningJobsModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsGetRunningJobs.ts')
        const sampleTelemetryModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsSampleProviderTelemetry.ts')
        const sendToLlmModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.ts')
        const runtimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
        const runtimeLoggerModulePath = getModulePath('./src/server/utils/runtimeLogger.ts')
        const checkCalls = []
        let shouldRunJudging = false
        let shouldRunMaintenance = true

        void mock.module('elysia', () => {
          return {
            Elysia: class {
              constructor() {
                this.uses = []
              }

              use(plugin) {
                this.uses.push(plugin)
                return this
              }
            },
          }
        })
        void mock.module('@elysiajs/cron', () => {
          return {
            cron: (config) => {
              return {config, name: config.name}
            },
          }
        })
        void mock.module(serverIdentityModulePath, () => {
          return {getDefaultJudgmentServerJobId: () => 'server-llm-status'}
        })
        void mock.module(backgroundImportModulePath, () => {
          return {runJudgmentJobSqliteBackgroundImport: async () => ({})}
        })
        void mock.module(sqliteServiceModulePath, () => {
          return {
            getJudgmentJobSqliteService: () => {
              return {publishHealthProjections: async () => {}, syncOwnedLeases: async () => {}}
            },
          }
        })
        void mock.module(addToQueueModulePath, () => {
          return {judgmentsJobsAddToQueue: async () => {}}
        })
        void mock.module(checkStatusModulePath, () => {
          return {
            judgmentsJobsCheckLLMStatus: async () => {
              checkCalls.push('called')
            },
          }
        })
        void mock.module(cleanupModulePath, () => {
          return {judgmentsJobsCleanupStale: async () => {}}
        })
        void mock.module(getRunningJobsModulePath, () => {
          return {judgmentsJobsGetRunningJobs: async () => []}
        })
        void mock.module(sampleTelemetryModulePath, () => {
          return {judgmentsJobsSampleProviderTelemetry: async () => ({})}
        })
        void mock.module(sendToLlmModulePath, () => {
          return {judgmentsJobsSendToLLM: async () => {}}
        })
        void mock.module(runtimeRoleModulePath, () => {
          return {
            getCurrentServerRole: () => 'maintenance-worker',
            isExpectedDuckdbOwnerRoleLossError: () => false,
            shouldCurrentServerRunJudgingLoops: () => shouldRunJudging,
            shouldCurrentServerRunMaintenanceLoops: () => shouldRunMaintenance,
          }
        })
        void mock.module(runtimeLoggerModulePath, () => {
          return {
            getRuntimeLogConfig: () => ({
              logDir: '/tmp/forska-test-logs',
              logLevel: 'INFO',
              logStderrLevel: 'ERROR',
              runtimeProfile: 'local',
            }),
            getRuntimeLogProfile: () => 'local',
            isRuntimeJsonlSinkInstalled: () => false,
            writeRuntimeFailureLogEvent: () => {},
            writeRuntimeLogEvent: () => false,
          }
        })

        const cronModule = await import(judgmentsJobsModulePath + '?llm-status-role=' + Date.now())
        const judgingCronModule = await import(judgmentsJobsJudgingCronModulePath + '?llm-status-role=' + Date.now())
        const maintenanceNames = cronModule.judgmentsJobsMaintenanceCron.uses.map((plugin) => {
          return plugin.name
        })
        const judgingNames = judgingCronModule.judgmentsJobsJudgingCron.uses.map((plugin) => {
          return plugin.name
        })
        const checkCron = cronModule.judgmentsJobsMaintenanceCron.uses.find((plugin) => {
          return plugin.name === 'judgments-jobs-check-llm-status'
        })

        if (!checkCron) {
          throw new Error('Expected llm status cron on maintenance worker')
        }

        await checkCron.config.run()
        shouldRunMaintenance = false
        shouldRunJudging = true
        await checkCron.config.run()

        console.log(JSON.stringify({checkCalls, judgingNames, maintenanceNames}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString() || runScript.stdout.toString() || 'LLM status cron role ownership test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    checkCalls: string[]
    judgingNames: string[]
    maintenanceNames: string[]
  }

  expect(result.maintenanceNames).toContain('judgments-jobs-check-llm-status')
  expect(result.judgingNames).not.toContain('judgments-jobs-check-llm-status')
  expect(result.checkCalls).toEqual(['called'])
})

test('llm status cron prevents overlapping runs and recovers after completion', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').href
        }

        const judgmentsJobsModulePath = getModulePath('./src/server/cron/judgmentsJobs.ts')
        const serverIdentityModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobServerIdentity.ts')
        const backgroundImportModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteBackgroundImport.ts')
        const sqliteServiceModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts')
        const addToQueueModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.ts')
        const checkStatusModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsCheckLLMStatus.ts')
        const cleanupModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsCleanupStale.ts')
        const getRunningJobsModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsGetRunningJobs.ts')
        const sampleTelemetryModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsSampleProviderTelemetry.ts')
        const sendToLlmModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.ts')
        const runtimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
        const runtimeLoggerModulePath = getModulePath('./src/server/utils/runtimeLogger.ts')
        const checkCalls = []
        const checkDone = []
        let resolveCheck = () => {}

        void mock.module('elysia', () => {
          return {
            Elysia: class {
              constructor() {
                this.uses = []
              }

              use(plugin) {
                this.uses.push(plugin)
                return this
              }
            },
          }
        })
        void mock.module('@elysiajs/cron', () => {
          return {
            cron: (config) => {
              return {config, name: config.name}
            },
          }
        })
        void mock.module(serverIdentityModulePath, () => {
          return {getDefaultJudgmentServerJobId: () => 'server-llm-status-overlap'}
        })
        void mock.module(backgroundImportModulePath, () => {
          return {runJudgmentJobSqliteBackgroundImport: async () => ({})}
        })
        void mock.module(sqliteServiceModulePath, () => {
          return {
            getJudgmentJobSqliteService: () => {
              return {publishHealthProjections: async () => {}, syncOwnedLeases: async () => {}}
            },
          }
        })
        void mock.module(addToQueueModulePath, () => {
          return {judgmentsJobsAddToQueue: async () => {}}
        })
        void mock.module(checkStatusModulePath, () => {
          return {
            judgmentsJobsCheckLLMStatus: async () => {
              checkCalls.push('called')
              await new Promise((resolve) => {
                resolveCheck = resolve
              })
              checkDone.push('done')
            },
          }
        })
        void mock.module(cleanupModulePath, () => {
          return {judgmentsJobsCleanupStale: async () => {}}
        })
        void mock.module(getRunningJobsModulePath, () => {
          return {judgmentsJobsGetRunningJobs: async () => []}
        })
        void mock.module(sampleTelemetryModulePath, () => {
          return {judgmentsJobsSampleProviderTelemetry: async () => ({})}
        })
        void mock.module(sendToLlmModulePath, () => {
          return {judgmentsJobsSendToLLM: async () => {}}
        })
        void mock.module(runtimeRoleModulePath, () => {
          return {
            getCurrentServerRole: () => 'maintenance-worker',
            isExpectedDuckdbOwnerRoleLossError: () => false,
            shouldCurrentServerRunJudgingLoops: () => false,
            shouldCurrentServerRunMaintenanceLoops: () => true,
          }
        })
        void mock.module(runtimeLoggerModulePath, () => {
          return {
            getRuntimeLogConfig: () => ({
              logDir: '/tmp/forska-test-logs',
              logLevel: 'INFO',
              logStderrLevel: 'ERROR',
              runtimeProfile: 'local',
            }),
            getRuntimeLogProfile: () => 'local',
            isRuntimeJsonlSinkInstalled: () => false,
            writeRuntimeFailureLogEvent: () => {},
            writeRuntimeLogEvent: () => false,
          }
        })

        const cronModule = await import(judgmentsJobsModulePath + '?llm-status-overlap=' + Date.now())
        const checkCron = cronModule.judgmentsJobsMaintenanceCron.uses.find((plugin) => {
          return plugin.name === 'judgments-jobs-check-llm-status'
        })

        if (!checkCron) {
          throw new Error('Expected llm status cron on maintenance worker')
        }

        const firstRun = checkCron.config.run()
        await Promise.resolve()
        const secondRun = checkCron.config.run()
        await Promise.resolve()
        resolveCheck()
        await Promise.all([firstRun, secondRun])

        const thirdRun = checkCron.config.run()
        await Promise.resolve()
        resolveCheck()
        await thirdRun

        console.log(JSON.stringify({checkCalls, checkDone}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(runScript.stderr.toString() || runScript.stdout.toString() || 'LLM status overlap test failed')
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {checkCalls: string[]; checkDone: string[]}

  expect(result.checkCalls).toEqual(['called', 'called'])
  expect(result.checkDone).toEqual(['done', 'done'])
})

test('provider telemetry sampler cron is owned by maintenance worker and role gated', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').href
        }

        const judgmentsJobsModulePath = getModulePath('./src/server/cron/judgmentsJobs.ts')
        const judgmentsJobsJudgingCronModulePath = getModulePath('./src/server/cron/judgmentsJobsJudgingCron.ts')
        const serverIdentityModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobServerIdentity.ts')
        const backgroundImportModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteBackgroundImport.ts')
        const sqliteServiceModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts')
        const addToQueueModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.ts')
        const checkStatusModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsCheckLLMStatus.ts')
        const cleanupModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsCleanupStale.ts')
        const getRunningJobsModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsGetRunningJobs.ts')
        const sampleTelemetryModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsSampleProviderTelemetry.ts')
        const sendToLlmModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.ts')
        const runtimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
        const runtimeLoggerModulePath = getModulePath('./src/server/utils/runtimeLogger.ts')
        const sampleCalls = []
        let shouldRunMaintenance = true

        void mock.module('elysia', () => {
          return {
            Elysia: class {
              constructor() {
                this.uses = []
              }

              use(plugin) {
                this.uses.push(plugin)
                return this
              }
            },
          }
        })
        void mock.module('@elysiajs/cron', () => {
          return {
            cron: (config) => {
              return {config, name: config.name}
            },
          }
        })
        void mock.module(serverIdentityModulePath, () => {
          return {getDefaultJudgmentServerJobId: () => 'server-provider-telemetry'}
        })
        void mock.module(backgroundImportModulePath, () => {
          return {runJudgmentJobSqliteBackgroundImport: async () => ({})}
        })
        void mock.module(sqliteServiceModulePath, () => {
          return {
            getJudgmentJobSqliteService: () => {
              return {publishHealthProjections: async () => {}, syncOwnedLeases: async () => {}}
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
        void mock.module(sampleTelemetryModulePath, () => {
          return {
            judgmentsJobsSampleProviderTelemetry: async () => {
              sampleCalls.push('called')
            },
          }
        })
        void mock.module(sendToLlmModulePath, () => {
          return {judgmentsJobsSendToLLM: async () => {}}
        })
        void mock.module(runtimeRoleModulePath, () => {
          return {
            getCurrentServerRole: () => 'maintenance-worker',
            isExpectedDuckdbOwnerRoleLossError: () => false,
            shouldCurrentServerRunJudgingLoops: () => false,
            shouldCurrentServerRunMaintenanceLoops: () => shouldRunMaintenance,
          }
        })
        void mock.module(runtimeLoggerModulePath, () => {
          return {
            getRuntimeLogConfig: () => ({
              logDir: '/tmp/forska-test-logs',
              logLevel: 'INFO',
              logStderrLevel: 'ERROR',
              runtimeProfile: 'local',
            }),
            getRuntimeLogProfile: () => 'local',
            isRuntimeJsonlSinkInstalled: () => false,
            writeRuntimeFailureLogEvent: () => {},
            writeRuntimeLogEvent: () => false,
          }
        })

        const cronModule = await import(judgmentsJobsModulePath + '?provider-telemetry-role=' + Date.now())
        const judgingCronModule = await import(judgmentsJobsJudgingCronModulePath + '?provider-telemetry-role=' + Date.now())
        const maintenanceNames = cronModule.judgmentsJobsMaintenanceCron.uses.map((plugin) => {
          return plugin.name
        })
        const judgingNames = judgingCronModule.judgmentsJobsJudgingCron.uses.map((plugin) => {
          return plugin.name
        })
        const sampleCron = cronModule.judgmentsJobsMaintenanceCron.uses.find((plugin) => {
          return plugin.name === 'judgments-jobs-sample-provider-telemetry'
        })

        if (!sampleCron) {
          throw new Error('Expected provider telemetry sampler cron on maintenance worker')
        }

        await sampleCron.config.run()
        shouldRunMaintenance = false
        await sampleCron.config.run()

        console.log(JSON.stringify({
          judgingNames,
          maintenanceNames,
          pattern: sampleCron.config.pattern,
          sampleCalls,
        }))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString() || runScript.stdout.toString() || 'Provider telemetry sampler role test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    judgingNames: string[]
    maintenanceNames: string[]
    pattern: string
    sampleCalls: string[]
  }

  expect(result.maintenanceNames).toContain('judgments-jobs-sample-provider-telemetry')
  expect(result.judgingNames).not.toContain('judgments-jobs-sample-provider-telemetry')
  expect(result.pattern).toBe('*/30 * * * * *')
  expect(result.sampleCalls).toEqual(['called'])
})

test('provider telemetry sampler cron prevents overlapping runs', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').href
        }

        const judgmentsJobsModulePath = getModulePath('./src/server/cron/judgmentsJobs.ts')
        const serverIdentityModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobServerIdentity.ts')
        const backgroundImportModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteBackgroundImport.ts')
        const sqliteServiceModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts')
        const addToQueueModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.ts')
        const checkStatusModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsCheckLLMStatus.ts')
        const cleanupModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsCleanupStale.ts')
        const getRunningJobsModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsGetRunningJobs.ts')
        const sampleTelemetryModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsSampleProviderTelemetry.ts')
        const sendToLlmModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.ts')
        const runtimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
        const runtimeLoggerModulePath = getModulePath('./src/server/utils/runtimeLogger.ts')
        const sampleCalls = []
        const sampleDone = []
        let resolveSample = () => {}

        void mock.module('elysia', () => {
          return {
            Elysia: class {
              constructor() {
                this.uses = []
              }

              use(plugin) {
                this.uses.push(plugin)
                return this
              }
            },
          }
        })
        void mock.module('@elysiajs/cron', () => {
          return {
            cron: (config) => {
              return {config, name: config.name}
            },
          }
        })
        void mock.module(serverIdentityModulePath, () => {
          return {getDefaultJudgmentServerJobId: () => 'server-provider-telemetry-overlap'}
        })
        void mock.module(backgroundImportModulePath, () => {
          return {runJudgmentJobSqliteBackgroundImport: async () => ({})}
        })
        void mock.module(sqliteServiceModulePath, () => {
          return {
            getJudgmentJobSqliteService: () => {
              return {publishHealthProjections: async () => {}, syncOwnedLeases: async () => {}}
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
        void mock.module(sampleTelemetryModulePath, () => {
          return {
            judgmentsJobsSampleProviderTelemetry: async () => {
              sampleCalls.push('called')
              await new Promise((resolve) => {
                resolveSample = resolve
              })
              sampleDone.push('done')
            },
          }
        })
        void mock.module(sendToLlmModulePath, () => {
          return {judgmentsJobsSendToLLM: async () => {}}
        })
        void mock.module(runtimeRoleModulePath, () => {
          return {
            getCurrentServerRole: () => 'maintenance-worker',
            isExpectedDuckdbOwnerRoleLossError: () => false,
            shouldCurrentServerRunJudgingLoops: () => false,
            shouldCurrentServerRunMaintenanceLoops: () => true,
          }
        })
        void mock.module(runtimeLoggerModulePath, () => {
          return {
            getRuntimeLogConfig: () => ({
              logDir: '/tmp/forska-test-logs',
              logLevel: 'INFO',
              logStderrLevel: 'ERROR',
              runtimeProfile: 'local',
            }),
            getRuntimeLogProfile: () => 'local',
            isRuntimeJsonlSinkInstalled: () => false,
            writeRuntimeFailureLogEvent: () => {},
            writeRuntimeLogEvent: () => false,
          }
        })

        const cronModule = await import(judgmentsJobsModulePath + '?provider-telemetry-overlap=' + Date.now())
        const sampleCron = cronModule.judgmentsJobsMaintenanceCron.uses.find((plugin) => {
          return plugin.name === 'judgments-jobs-sample-provider-telemetry'
        })

        if (!sampleCron) {
          throw new Error('Expected provider telemetry sampler cron on maintenance worker')
        }

        const firstRun = sampleCron.config.run()
        await Promise.resolve()
        const secondRun = sampleCron.config.run()
        await Promise.resolve()
        resolveSample()
        await Promise.all([firstRun, secondRun])

        console.log(JSON.stringify({sampleCalls, sampleDone}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString() || runScript.stdout.toString() || 'Provider telemetry sampler overlap test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    sampleCalls: string[]
    sampleDone: string[]
  }

  expect(result.sampleCalls).toEqual(['called'])
  expect(result.sampleDone).toEqual(['done'])
})

test('provider telemetry sampler discovers running jobs without runtime match and stores samples', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').href
        }

        const samplerModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsSampleProviderTelemetry.ts')
        const getRunningJobsModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsGetRunningJobs.ts')
        const providerConnectionModulePath = getModulePath('./src/server/providers/providerConnectionRepository.ts')
        const appDatabaseModulePath = getModulePath('./src/server/services/appDatabaseService.ts')
        const healthProjectionModulePath = getModulePath('./src/server/services/judgmentJobSqliteHealthProjectionService.ts')
        const historyServiceModulePath = getModulePath('./src/server/services/judgmentProviderTelemetryHistoryService.ts')
        const telemetrySnapshotModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentProviderTelemetrySnapshot.ts')
        const runtimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
        const runningJobArgs = []
        const providerConnectionCalls = []
        const projectionCalls = []
        const snapshotInputs = []
        const insertedSamples = []
        const fakeDb = {name: 'fake-db'}

        void mock.module(getRunningJobsModulePath, () => {
          return {
            judgmentsJobsGetRunningJobs: async (args) => {
              runningJobArgs.push(args)
              return [
                {
                  id: 'job-a',
                  maxInflightRequests: 4,
                  modelId: 'model-a',
                  modelName: 'model-a-name',
                  modelProvider: 'openai',
                  providerConnectionId: 'connection-a',
                  projectId: 'project-a',
                  quarantineReason: null,
                  storageState: 'active',
                },
                {
                  id: 'job-b',
                  maxInflightRequests: 8,
                  modelId: 'model-b',
                  modelName: 'model-b-name',
                  modelProvider: 'sglang',
                  providerConnectionId: 'connection-b',
                  projectId: 'project-b',
                  quarantineReason: null,
                  storageState: 'active',
                },
              ]
            },
          }
        })
        void mock.module(providerConnectionModulePath, () => {
          return {
            getProviderConnectionForStoredModel: async (modelId, db) => {
              providerConnectionCalls.push({dbName: db.name, modelId})
              return {id: 'connection-for-' + modelId}
            },
          }
        })
        void mock.module(appDatabaseModulePath, () => {
          return {getAppDatabaseService: () => fakeDb}
        })
        void mock.module(healthProjectionModulePath, () => {
          return {
            getJudgmentJobSqliteHealthProjectionService: () => {
              return {
                getFreshJudgmentJobSqliteHealthProjections: async ({db, jobIds, now}) => {
                  projectionCalls.push({dbName: db.name, jobIds, now: now.toISOString()})
                  return new Map([
                    ['job-a', {promptCounts: {ready: 3}}],
                    ['job-b', {promptCounts: {ready: 7}}],
                  ])
                },
              }
            },
          }
        })
        void mock.module(telemetrySnapshotModulePath, () => {
          return {
            getJudgmentProviderTelemetrySnapshot: async ({job, providerConnection, readyCount}) => {
              snapshotInputs.push({jobId: job.id, providerConnectionId: providerConnection?.id ?? null, readyCount})
              return {dispatchTelemetry: {jobId: job.id, providerKey: 'provider-' + job.id, readyCount}}
            },
          }
        })
        void mock.module(historyServiceModulePath, () => {
          return {
            getJudgmentProviderTelemetryHistorySampleInsertFromSnapshot: ({jobId, projectId, sampledAt, snapshot}) => {
              return {jobId, projectId, providerKey: snapshot.providerKey, readyCount: snapshot.readyCount, sampledAt}
            },
            insertJudgmentProviderTelemetryHistorySamples: async ({samples}) => {
              insertedSamples.push(...samples.map((sample) => {
                return {
                  jobId: sample.jobId,
                  projectId: sample.projectId,
                  providerKey: sample.providerKey,
                  readyCount: sample.readyCount,
                  sampledAt: sample.sampledAt.toISOString(),
                }
              }))
              return {attempted: samples.length, inserted: samples.length, skipped: 0}
            },
          }
        })
        void mock.module(runtimeRoleModulePath, () => {
          return {
            getCurrentServerRole: () => 'maintenance-worker',
            shouldCurrentServerRunMaintenanceLoops: () => true,
          }
        })

        const {judgmentsJobsSampleProviderTelemetry} = await import(
          samplerModulePath + '?provider-telemetry-sampler=' + Date.now()
        )
        const result = await judgmentsJobsSampleProviderTelemetry({
          sampledAt: new Date('2026-05-12T15:12:44.999Z'),
        })

        console.log(JSON.stringify({
          insertedSamples,
          projectionCalls,
          providerConnectionCalls,
          result: {...result, sampledAt: result.sampledAt.toISOString()},
          runningJobArgs,
          snapshotInputs,
        }))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString() || runScript.stdout.toString() || 'Provider telemetry sampler discovery test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    insertedSamples: Array<{
      jobId: string
      projectId: string
      providerKey: string
      readyCount: number
      sampledAt: string
    }>
    projectionCalls: Array<{dbName: string; jobIds: string[]; now: string}>
    providerConnectionCalls: Array<{dbName: string; modelId: string}>
    result: {attempted: number; inserted: number; runningJobCount: number; sampledAt: string; skipped: number}
    runningJobArgs: Array<{applyRuntimeMatchFilter: boolean}>
    snapshotInputs: Array<{jobId: string; providerConnectionId: string | null; readyCount: number}>
  }

  expect(result.runningJobArgs).toEqual([{applyRuntimeMatchFilter: false}])
  expect(result.projectionCalls).toEqual([
    {dbName: 'fake-db', jobIds: ['job-a', 'job-b'], now: '2026-05-12T15:12:44.999Z'},
  ])
  expect(result.providerConnectionCalls).toEqual([
    {dbName: 'fake-db', modelId: 'model-a'},
    {dbName: 'fake-db', modelId: 'model-b'},
  ])
  expect(result.snapshotInputs).toEqual([
    {jobId: 'job-a', providerConnectionId: 'connection-for-model-a', readyCount: 3},
    {jobId: 'job-b', providerConnectionId: 'connection-for-model-b', readyCount: 7},
  ])
  expect(result.insertedSamples).toEqual([
    {
      jobId: 'job-a',
      projectId: 'project-a',
      providerKey: 'provider-job-a',
      readyCount: 3,
      sampledAt: '2026-05-12T15:12:44.999Z',
    },
    {
      jobId: 'job-b',
      projectId: 'project-b',
      providerKey: 'provider-job-b',
      readyCount: 7,
      sampledAt: '2026-05-12T15:12:44.999Z',
    },
  ])
  expect(result.result).toEqual({
    attempted: 2,
    inserted: 2,
    runningJobCount: 2,
    sampledAt: '2026-05-12T15:12:44.999Z',
    skipped: 0,
  })
})

test('add-to-queue cron ignores a stale judgment import latch', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').href
        }

        const judgmentsJobsModulePath = getModulePath('./src/server/cron/judgmentsJobs.ts')
        const stateModulePath = getModulePath('./src/server/cron/judgmentsJobsCronState.ts')
        const serverIdentityModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobServerIdentity.ts')
        const backgroundImportModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteBackgroundImport.ts')
        const sqliteServiceModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts')
        const addToQueueModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.ts')
        const checkStatusModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsCheckLLMStatus.ts')
        const cleanupModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsCleanupStale.ts')
        const getRunningJobsModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsGetRunningJobs.ts')
        const sampleTelemetryModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsSampleProviderTelemetry.ts')
        const sendToLlmModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.ts')
        const exclusiveWorkModulePath = getModulePath('./src/server/utils/duckdbExclusiveWork.ts')
        const runtimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
        const runtimeLoggerModulePath = getModulePath('./src/server/utils/runtimeLogger.ts')
        const addCalls = []
        let now = 1_000

        Date.now = () => now
        console.warn = () => {}

        void mock.module('elysia', () => {
          return {
            Elysia: class {
              constructor() {
                this.uses = []
              }

              use(plugin) {
                this.uses.push(plugin)
                return this
              }
            },
          }
        })
        void mock.module('@elysiajs/cron', () => {
          return {
            cron: (config) => {
              return {config, name: config.name}
            },
          }
        })
        void mock.module(serverIdentityModulePath, () => {
          return {getDefaultJudgmentServerJobId: () => 'server-stale-add'}
        })
        void mock.module(backgroundImportModulePath, () => {
          return {runJudgmentJobSqliteBackgroundImport: async () => ({})}
        })
        void mock.module(sqliteServiceModulePath, () => {
          return {
            getJudgmentJobSqliteService: () => {
              return {publishHealthProjections: async () => {}, syncOwnedLeases: async () => {}}
            },
          }
        })
        void mock.module(addToQueueModulePath, () => {
          return {
            judgmentsJobsAddToQueue: async (serverJobId) => {
              addCalls.push(serverJobId)
            },
          }
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
        void mock.module(sampleTelemetryModulePath, () => {
          return {judgmentsJobsSampleProviderTelemetry: async () => ({})}
        })
        void mock.module(sendToLlmModulePath, () => {
          return {judgmentsJobsSendToLLM: async () => {}}
        })
        void mock.module(exclusiveWorkModulePath, () => {
          return {
            hasActiveDuckdbExclusiveWork: () => false,
            isDuckdbExclusiveWorkAdmissionError: () => false,
          }
        })
        void mock.module(runtimeRoleModulePath, () => {
          return {
            getCurrentServerRole: () => 'maintenance-worker',
            isExpectedDuckdbOwnerRoleLossError: () => false,
            shouldCurrentServerRunJudgingLoops: () => false,
            shouldCurrentServerRunMaintenanceLoops: () => true,
          }
        })
        void mock.module(runtimeLoggerModulePath, () => {
          return {
            getRuntimeLogConfig: () => ({
              logDir: '/tmp/forska-test-logs',
              logLevel: 'INFO',
              logStderrLevel: 'ERROR',
              runtimeProfile: 'local',
            }),
            getRuntimeLogProfile: () => 'local',
            isRuntimeJsonlSinkInstalled: () => false,
            writeRuntimeFailureLogEvent: () => {},
            writeRuntimeLogEvent: () => false,
          }
        })

        const state = await import(stateModulePath)
        state.beginJudgmentsImportCronRun(now)
        now += state.JUDGMENTS_IMPORT_STALE_AFTER_MS

        const cronModule = await import(judgmentsJobsModulePath + '?stale-add=' + Math.random())
        const addCron = cronModule.judgmentsJobsMaintenanceCron.uses.find((plugin) => {
          return plugin.name === 'judgments-jobs-add-to-queue'
        })

        if (!addCron) {
          throw new Error('Expected add-to-queue cron on maintenance worker')
        }

        await addCron.config.run()

        console.log(JSON.stringify({addCalls}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString() || runScript.stdout.toString() || 'Add-to-queue stale import latch test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {addCalls: string[]}

  expect(result.addCalls).toEqual(['server-stale-add'])
})

test('judging cron ignores a stale judgment import latch', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').href
        }

        const judgingCronModulePath = getModulePath('./src/server/cron/judgmentsJobsJudgingCron.ts')
        const stateModulePath = getModulePath('./src/server/cron/judgmentsJobsCronState.ts')
        const serverIdentityModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobServerIdentity.ts')
        const sqliteServiceModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts')
        const getRunningJobsModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsGetRunningJobs.ts')
        const sendToLlmModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.ts')
        const runtimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
        const runtimeLoggerModulePath = getModulePath('./src/server/utils/runtimeLogger.ts')
        const runningJobs = [{id: 'job-stale-latch'}]
        const sendCalls = []
        let now = 1_000

        Date.now = () => now

        void mock.module('elysia', () => {
          return {
            Elysia: class {
              constructor() {
                this.uses = []
              }

              use(plugin) {
                this.uses.push(plugin)
                return this
              }
            },
          }
        })
        void mock.module('@elysiajs/cron', () => {
          return {
            cron: (config) => {
              return {config, name: config.name}
            },
          }
        })
        void mock.module(serverIdentityModulePath, () => {
          return {getDefaultJudgmentServerJobId: () => 'server-stale-judge'}
        })
        void mock.module(sqliteServiceModulePath, () => {
          return {
            getJudgmentJobSqliteService: () => {
              return {publishHealthProjections: async () => {}, syncOwnedLeases: async () => {}}
            },
          }
        })
        void mock.module(getRunningJobsModulePath, () => {
          return {judgmentsJobsGetRunningJobs: async () => runningJobs}
        })
        void mock.module(sendToLlmModulePath, () => {
          return {
            judgmentsJobsSendToLLM: async (jobs, serverJobId) => {
              sendCalls.push({jobIds: jobs.map((job) => job.id), serverJobId})
            },
          }
        })
        void mock.module(runtimeRoleModulePath, () => {
          return {
            getCurrentServerRole: () => 'judge-worker',
            isExpectedDuckdbOwnerRoleLossError: () => false,
            shouldCurrentServerRunJudgingLoops: () => true,
            shouldCurrentServerRunMaintenanceLoops: () => false,
          }
        })
        void mock.module(runtimeLoggerModulePath, () => {
          return {
            getRuntimeLogConfig: () => ({
              logDir: '/tmp/forska-test-logs',
              logLevel: 'INFO',
              logStderrLevel: 'ERROR',
              runtimeProfile: 'local',
            }),
            writeRuntimeFailureLogEvent: () => {},
          }
        })

        const state = await import(stateModulePath)
        state.beginJudgmentsImportCronRun(now)
        now += state.JUDGMENTS_IMPORT_STALE_AFTER_MS

        const cronModule = await import(judgingCronModulePath + '?stale-judge=' + Math.random())
        const sendCron = cronModule.judgmentsJobsJudgingCron.uses.find((plugin) => {
          return plugin.name === 'judgments-jobs-send-to-llm'
        })

        if (!sendCron) {
          throw new Error('Expected send-to-llm cron on judge worker')
        }

        await sendCron.config.run()

        console.log(JSON.stringify({sendCalls}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString() || runScript.stdout.toString() || 'Judging stale import latch test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    sendCalls: Array<{jobIds: string[]; serverJobId: string}>
  }

  expect(result.sendCalls).toEqual([{jobIds: ['job-stale-latch'], serverJobId: 'server-stale-judge'}])
})
