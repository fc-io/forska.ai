import {Buffer} from 'node:buffer'
import {existsSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

const runBunSpawnSync = (
  command: Parameters<typeof globalThis.Bun.spawnSync>[0],
  options: Parameters<typeof globalThis.Bun.spawnSync>[1],
) => {
  const outputPath = join(
    tmpdir(),
    `f1-judging-cron-child-output-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.log`,
  )
  const patchedCommand = Array.from(command)

  if (patchedCommand[1] === '-e' && typeof patchedCommand[2] === 'string') {
    patchedCommand[2] = `
      const __forskaChildOutputPath = process.env.FORSKA_TEST_CHILD_OUTPUT_PATH
      if (__forskaChildOutputPath) {
        const {appendFileSync} = await import('node:fs')
        const __forskaOriginalStdoutWrite = process.stdout.write.bind(process.stdout)
        const __forskaOriginalStderrWrite = process.stderr.write.bind(process.stderr)
        process.stdout.write = (chunk, ...args) => {
          appendFileSync(__forskaChildOutputPath, String(chunk))
          return __forskaOriginalStdoutWrite(chunk, ...args)
        }
        process.stderr.write = (chunk, ...args) => {
          appendFileSync(__forskaChildOutputPath, String(chunk))
          return __forskaOriginalStderrWrite(chunk, ...args)
        }
        for (const __forskaConsoleMethod of ['log', 'warn', 'error']) {
          const __forskaOriginalConsoleMethod = console[__forskaConsoleMethod].bind(console)
          console[__forskaConsoleMethod] = (...args) => {
            appendFileSync(__forskaChildOutputPath, args.map(String).join(' ') + '\\n')
            __forskaOriginalConsoleMethod(...args)
          }
        }
      }
      ${patchedCommand[2]}
    `
  }

  const result = globalThis.Bun.spawnSync(patchedCommand, {
    ...options,
    env: {...options?.env, FORSKA_TEST_CHILD_OUTPUT_PATH: outputPath},
    stderr: 'pipe',
    stdout: 'pipe',
  })
  const fileOutput = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : ''
  rmSync(outputPath, {force: true})

  return {...result, stdout: Buffer.from(`${result.stdout.toString()}\n${result.stderr.toString()}\n${fileOutput}`)}
}

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

test('judging cron prevents overlapping owner reads and syncs judge-worker SQLite leases', () => {
  const runScript = runBunSpawnSync(
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

        const cronModulePath = getModulePath('./src/server/cron/judgmentsJobsJudgingCron.ts')
        const serverIdentityModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobServerIdentity.ts')
        const sqliteServiceModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts')
        const getRunningJobsModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsGetRunningJobs.ts')
        const sendToLlmModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.ts')
        const runtimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
        const runtimeLoggerModulePath = getModulePath('./src/server/utils/runtimeLogger.ts')
        const cronConfigs = []
        let getRunningJobsCallCount = 0
        let resolveRunningJobs = () => {}
        let sendToLlmCallCount = 0
        const syncOwnedLeaseInputs = []

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
          return {getDefaultJudgmentServerJobId: () => 'judge-worker-overlap'}
        })
        void mock.module(sqliteServiceModulePath, () => {
          return {
            getJudgmentJobSqliteService: () => {
              return {
                publishHealthProjections: async () => {},
                syncOwnedLeases: async (jobIds) => {
                  syncOwnedLeaseInputs.push(jobIds)
                },
              }
            },
          }
        })
        void mock.module(getRunningJobsModulePath, () => {
          return {
            judgmentsJobsGetRunningJobs: async () => {
              getRunningJobsCallCount += 1

              if (getRunningJobsCallCount === 1) {
                await new Promise((resolve) => {
                  resolveRunningJobs = resolve
                })
              }

              if (getRunningJobsCallCount === 2) {
                throw new Error('owner running-jobs read failed')
              }

              return []
            },
          }
        })
        void mock.module(sendToLlmModulePath, () => {
          return {
            judgmentsJobsSendToLLM: async () => {
              sendToLlmCallCount += 1
            },
          }
        })
        void mock.module(runtimeRoleModulePath, () => {
          return {
            isExpectedDuckdbOwnerRoleLossError: () => false,
            shouldCurrentServerRunJudgingLoops: () => true,
            shouldCurrentServerRunMaintenanceLoops: () => false,
          }
        })
        void mock.module(runtimeLoggerModulePath, () => {
          return {writeRuntimeFailureLogEvent: () => {}}
        })

        await import(cronModulePath)
        const judgingCron = cronConfigs.find((config) => {
          return config.name === 'judgments-jobs-send-to-llm'
        })

        const firstRun = judgingCron.run()
        await Promise.resolve()
        await judgingCron.run()
        const countsDuringFirstRun = {getRunningJobsCallCount, sendToLlmCallCount}
        resolveRunningJobs()
        await firstRun
        await judgingCron.run()
        const countsAfterRejectedRun = {getRunningJobsCallCount, sendToLlmCallCount}
        await judgingCron.run()

        console.log(JSON.stringify({
          countsAfterResume: {getRunningJobsCallCount, sendToLlmCallCount},
          countsAfterRejectedRun,
          countsDuringFirstRun,
          syncOwnedLeaseInputs,
        }))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString() || runScript.stdout.toString() || 'Judging cron overlap guard test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    countsAfterResume: {getRunningJobsCallCount: number; sendToLlmCallCount: number}
    countsAfterRejectedRun: {getRunningJobsCallCount: number; sendToLlmCallCount: number}
    countsDuringFirstRun: {getRunningJobsCallCount: number; sendToLlmCallCount: number}
    syncOwnedLeaseInputs: string[][]
  }

  expect(result.countsDuringFirstRun).toEqual({getRunningJobsCallCount: 1, sendToLlmCallCount: 0})
  expect(result.countsAfterRejectedRun).toEqual({getRunningJobsCallCount: 2, sendToLlmCallCount: 1})
  expect(result.countsAfterResume).toEqual({getRunningJobsCallCount: 3, sendToLlmCallCount: 2})
  expect(result.syncOwnedLeaseInputs).toEqual([[], []])
})
