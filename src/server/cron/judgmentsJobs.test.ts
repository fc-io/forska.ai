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

test('add-to-queue overlap warning waits for sustained running time', () => {
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
            isExpectedDuckdbOwnerRoleLossError: () => false,
            shouldCurrentServerRunJudgingLoops: () => false,
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

test('llm status cron is owned by maintenance worker instead of judge worker', () => {
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
            isExpectedDuckdbOwnerRoleLossError: () => false,
            shouldCurrentServerRunJudgingLoops: () => shouldRunJudging,
            shouldCurrentServerRunMaintenanceLoops: () => shouldRunMaintenance,
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

        const cronModule = await import(judgmentsJobsModulePath + '?llm-status-role=' + Date.now())
        const maintenanceNames = cronModule.judgmentsJobsMaintenanceCron.uses.map((plugin) => {
          return plugin.name
        })
        const judgingNames = cronModule.judgmentsJobsJudgingCron.uses.map((plugin) => {
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

test('provider telemetry sampler cron is owned by maintenance worker and role gated', () => {
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
            isExpectedDuckdbOwnerRoleLossError: () => false,
            shouldCurrentServerRunJudgingLoops: () => false,
            shouldCurrentServerRunMaintenanceLoops: () => shouldRunMaintenance,
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

        const cronModule = await import(judgmentsJobsModulePath + '?provider-telemetry-role=' + Date.now())
        const maintenanceNames = cronModule.judgmentsJobsMaintenanceCron.uses.map((plugin) => {
          return plugin.name
        })
        const judgingNames = cronModule.judgmentsJobsJudgingCron.uses.map((plugin) => {
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
            isExpectedDuckdbOwnerRoleLossError: () => false,
            shouldCurrentServerRunJudgingLoops: () => false,
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
          return new URL(relativePath, 'file://' + process.cwd() + '/').pathname
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
          return {shouldCurrentServerRunMaintenanceLoops: () => true}
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
