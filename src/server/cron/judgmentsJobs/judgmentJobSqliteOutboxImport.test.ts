import {rmSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {hostname} from 'node:os'
import {join} from 'node:path'

import {afterAll, afterEach, beforeAll, expect, test} from 'bun:test'

import type {ArticleRecord} from '../../../db/schemaTypes.ts'
import {createTempRuntimeRoot} from '../../test/createTempRuntimeRoot.ts'

const tempRuntimeRoot = createTempRuntimeRoot('f1-judgment-job-sqlite-import')
const tempDbPath = tempRuntimeRoot.duckdbPath
const tempJobDir = tempRuntimeRoot.judgmentJobsDirectory

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempDbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.RUN_SERVER_JUDGING = 'false'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

let closeDatabase: (() => Promise<void>) | null = null
let getAppDatabaseService:
  | Awaited<typeof import('../../services/appDatabaseService.ts')>['getAppDatabaseService']
  | null = null
let queryDatabase: (<T>(statement: string) => Promise<T[]>) | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null
let importOutboxBatch: (() => Promise<number>) | null = null
let sqliteService: Awaited<typeof import('./judgmentJobSqliteService.ts')>['getJudgmentJobSqliteService'] | null = null
let storeSinglePromptJudgment:
  | (typeof import('../../../agent/judge/storeSinglePromptJudgment.ts'))['storeSinglePromptJudgment']
  | null = null

const getLastJsonLine = (stdout: string) => {
  const lines = stdout
    .split('\n')
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      return line.startsWith('{') && line.endsWith('}')
    })

  const [lastLine = ''] = lines.slice(-1)

  if (lastLine === '') {
    throw new Error(`Expected JSON output but received: ${stdout}`)
  }

  return lastLine
}

beforeAll(async () => {
  const [
    {migrateDuckdb},
    {getAppDatabaseService: getDatabaseService},
    {resetDuckdbServiceForTests},
    {resetServerRuntimeRoleForTests},
    sqliteModule,
    importModule,
    storeModule,
  ] = await Promise.all([
    import('../../../db/migrateDuckdb.ts'),
    import('../../services/appDatabaseService.ts'),
    import('../../utils/duckdbService.ts'),
    import('../../utils/serverRuntimeRole.ts'),
    import('./judgmentJobSqliteService.ts'),
    import('./judgmentJobSqliteOutboxImport.ts'),
    import('../../../agent/judge/storeSinglePromptJudgment.ts'),
  ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()

  await migrateDuckdb()

  const database = getDatabaseService()

  closeDatabase = () => {
    return database.close()
  }
  queryDatabase = (statement: string) => {
    return database.queryJson(statement)
  }
  getAppDatabaseService = getDatabaseService
  runDatabase = (statement: string) => {
    return database.run(statement)
  }
  sqliteService = sqliteModule.getJudgmentJobSqliteService
  importOutboxBatch = () => {
    return importModule.importJudgmentJobSqliteOutboxBatch()
  }
  storeSinglePromptJudgment = storeModule.storeSinglePromptJudgment
})

afterAll(async () => {
  await sqliteService?.().closeAll()
  await closeDatabase?.()
  tempRuntimeRoot.cleanup()
})

afterEach(async () => {
  await sqliteService?.().closeAll()
  rmSync(tempJobDir, {force: true, recursive: true})
})

test('background import selects the next active or draining job for a single import cycle', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').pathname
        }

        const appDatabaseServiceModulePath = getModulePath('./src/server/services/appDatabaseService.ts')
        const sqliteServiceModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts')
        const outboxImportModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteOutboxImport.ts')
        const backgroundImportModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteBackgroundImport.ts')
        const importedJobIds = []
        const queryStatements = []
        let syncedLeaseJobIds = null

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            getAppDatabaseService: () => {
              return {
                run: async () => {},
                queryJson: async (statement) => {
                  queryStatements.push(statement)

                  return statement.includes("storage_state = 'draining'") && statement.includes('status IN')
                    ? [{id: 'active-job'}, {id: 'draining-job'}]
                    : []
                },
              }
            },
          }
        })

        void mock.module(sqliteServiceModulePath, () => {
          return {
            JudgmentJobLeaseError: class JudgmentJobLeaseError extends Error {},
            getJudgmentJobSqliteService: () => {
              return {
                getHealthSnapshot: async () => {
                  return null
                },
                hasOwnedLease: () => false,
                syncOwnedLeases: async (jobIds) => {
                  syncedLeaseJobIds = jobIds
                },
              }
            },
          }
        })

        void mock.module(outboxImportModulePath, () => {
          return {
            runJudgmentJobSqliteOutboxImportCycle: async ({jobId}) => {
              importedJobIds.push(jobId)
              return {
                claimedBy: 'test-server',
                discardedCount: 0,
                duplicateCount: 0,
                importedCount: 0,
                jobId,
                outboxClaimId: null,
                outboxRowCount: 0,
                status: 'idle',
              }
            },
          }
        })

        const {runJudgmentJobSqliteBackgroundImport} = await import(backgroundImportModulePath + '?storage-states=' + Date.now())
        const summary = await runJudgmentJobSqliteBackgroundImport({claimedBy: 'test-server'})

        console.log(JSON.stringify({importedJobIds, queryStatements, summary, syncedLeaseJobIds}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString() || runScript.stdout.toString() || 'SQLite orphaned job import regression test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    importedJobIds: string[]
    queryStatements: string[]
    summary: {attemptedCount: number; failedCount: number; skippedCount: number; succeededCount: number}
    syncedLeaseJobIds: string[]
  }

  expect(result.importedJobIds).toEqual(['active-job'])
  expect(
    result.queryStatements.some((statement) => {
      return (
        statement.includes("storage_state = 'active'")
        && statement.includes("storage_state = 'draining'")
        && statement.includes(
          "status IN ('not_started', 'running', 'waiting_on_db_connection', 'waiting_on_llm_connection')",
        )
      )
    }),
  ).toBe(true)
  expect(result.syncedLeaseJobIds).toEqual([])
  expect(result.summary).toEqual({attemptedCount: 1, failedCount: 0, skippedCount: 1, succeededCount: 0})
})

test('background import fast flushes draining jobs before active jobs', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').pathname
        }

        const appDatabaseServiceModulePath = getModulePath('./src/server/services/appDatabaseService.ts')
        const sqliteServiceModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts')
        const outboxImportModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteOutboxImport.ts')
        const isolatedImportModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteIsolatedImport.ts')
        const backgroundImportModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteBackgroundImport.ts')
        const activeImportJobIds = []
        const checkpointJobIds = []
        const flushJobIds = []
        const healthSnapshotJobIds = []
        const pruneCalls = []
        const finalizedJobIds = []
        const runStatements = []
        let pruneCallCount = 0

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            getAppDatabaseService: () => {
              return {
                queryJson: async (statement) => {
                  return statement.includes("storage_state = 'draining'") && statement.includes('status IN')
                    ? [
                        {id: 'active-job', storageState: 'active'},
                        {id: 'draining-job', storageState: 'draining'},
                      ]
                    : []
                },
                run: async (statement) => {
                  runStatements.push(statement)
                },
              }
            },
          }
        })

        void mock.module(sqliteServiceModulePath, () => {
          return {
            JudgmentJobLeaseError: class JudgmentJobLeaseError extends Error {},
            getJudgmentJobSqliteService: () => {
              return {
                checkpointWal: async ({jobId}) => {
                  checkpointJobIds.push(jobId)
                  return true
                },
                finalizeDrainingJobs: async ({jobId}) => {
                  finalizedJobIds.push(jobId)
                  return [jobId]
                },
                getHealthSnapshot: async (jobId) => {
                  healthSnapshotJobIds.push(jobId)
                  return null
                },
                hasOwnedLease: () => false,
                pruneVisibilityAckedRetention: async ({jobId, maxRows, serverJobId}) => {
                  pruneCalls.push({jobId, maxRows, serverJobId})
                  pruneCallCount += 1
                  return pruneCallCount === 1
                    ? {outboxRowsDeleted: 700, queuePromptRowsDeleted: 700}
                    : {outboxRowsDeleted: 0, queuePromptRowsDeleted: 0}
                },
                syncOwnedLeases: async () => {},
              }
            },
          }
        })

        void mock.module(outboxImportModulePath, () => {
          return {
            runJudgmentJobSqliteOutboxImportCycle: async ({jobId}) => {
              activeImportJobIds.push(jobId)
              return {
                claimedBy: 'test-server',
                discardedCount: 0,
                duplicateCount: 0,
                importedCount: 0,
                jobId,
                outboxClaimId: null,
                outboxRowCount: 0,
                status: 'idle',
              }
            },
          }
        })

        void mock.module(isolatedImportModulePath, () => {
          return {
            runJudgmentJobSqliteIsolatedFlush: async ({jobId}) => {
              flushJobIds.push(jobId)
              return {
                cycleCount: 8,
                errorMessage: null,
                exitCode: 0,
                importedCount: 700,
                lastResult: null,
              }
            },
          }
        })

        const {runJudgmentJobSqliteBackgroundImport} = await import(backgroundImportModulePath + '?draining-fast-flush=' + Date.now())
        const summary = await runJudgmentJobSqliteBackgroundImport({claimedBy: 'test-server'})

        console.log(
          JSON.stringify({
            activeImportJobIds,
            checkpointJobIds,
            finalizedJobIds,
            flushJobIds,
            healthSnapshotJobIds,
            pruneCalls,
            runStatements,
            summary,
          }),
        )
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString() || runScript.stdout.toString() || 'SQLite draining fast flush regression test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    activeImportJobIds: string[]
    checkpointJobIds: string[]
    finalizedJobIds: string[]
    flushJobIds: string[]
    healthSnapshotJobIds: string[]
    pruneCalls: Array<{jobId: string; maxRows: number; serverJobId: string}>
    runStatements: string[]
    summary: {attemptedCount: number; failedCount: number; skippedCount: number; succeededCount: number}
  }

  expect(result.activeImportJobIds).toEqual([])
  expect(result.flushJobIds).toEqual(['draining-job'])
  expect(result.pruneCalls).toEqual([
    {jobId: 'draining-job', maxRows: 1000, serverJobId: 'test-server'},
    {jobId: 'draining-job', maxRows: 1000, serverJobId: 'test-server'},
  ])
  expect(result.finalizedJobIds).toEqual(['draining-job'])
  expect(result.checkpointJobIds).toEqual(['draining-job'])
  expect(result.healthSnapshotJobIds).toEqual(['draining-job'])
  expect(
    result.runStatements.some((statement) => {
      return statement.includes('last_import_completed_at') && statement.includes('last_import_exit_code = 0')
    }),
  ).toBe(true)
  expect(result.summary).toEqual({attemptedCount: 1, failedCount: 0, skippedCount: 0, succeededCount: 1})
})

test('background import skips locked draining jobs and imports the next candidate', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').pathname
        }

        const appDatabaseServiceModulePath = getModulePath('./src/server/services/appDatabaseService.ts')
        const sqliteServiceModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts')
        const outboxImportModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteOutboxImport.ts')
        const isolatedImportModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteIsolatedImport.ts')
        const backgroundImportModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteBackgroundImport.ts')
        const activeImportJobIds = []
        const flushJobIds = []
        const healthSnapshotJobIds = []
        const queryStatements = []
        const runStatements = []

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            getAppDatabaseService: () => {
              return {
                queryJson: async (statement) => {
                  queryStatements.push(statement)

                  return statement.includes("storage_state = 'draining'") && statement.includes('status IN')
                    ? [
                        {id: 'active-job', storageState: 'active'},
                        {id: 'draining-job', storageState: 'draining'},
                      ]
                    : []
                },
                run: async (statement) => {
                  runStatements.push(statement)
                },
              }
            },
          }
        })

        void mock.module(sqliteServiceModulePath, () => {
          return {
            JudgmentJobLeaseError: class JudgmentJobLeaseError extends Error {},
            getJudgmentJobSqliteService: () => {
              return {
                getHealthSnapshot: async (jobId) => {
                  healthSnapshotJobIds.push(jobId)
                  return null
                },
                hasOwnedLease: () => false,
                syncOwnedLeases: async () => {},
              }
            },
          }
        })

        void mock.module(outboxImportModulePath, () => {
          return {
            runJudgmentJobSqliteOutboxImportCycle: async ({jobId}) => {
              activeImportJobIds.push(jobId)
              return {
                claimedBy: 'test-server',
                discardedCount: 0,
                duplicateCount: 0,
                importedCount: 1,
                jobId,
                outboxClaimId: 'claim-1',
                outboxRowCount: 1,
                status: 'imported',
              }
            },
          }
        })

        void mock.module(isolatedImportModulePath, () => {
          return {
            runJudgmentJobSqliteIsolatedFlush: async ({jobId}) => {
              flushJobIds.push(jobId)
              return {
                cycleCount: 1,
                errorMessage: 'Failed to acquire SQLite job lease for draining-job',
                exitCode: 1,
                importedCount: 0,
                lastResult: null,
              }
            },
          }
        })

        const {runJudgmentJobSqliteBackgroundImport} = await import(backgroundImportModulePath + '?draining-lock-skip=' + Date.now())
        const summary = await runJudgmentJobSqliteBackgroundImport({claimedBy: 'test-server'})

        console.log(
          JSON.stringify({
            activeImportJobIds,
            flushJobIds,
            healthSnapshotJobIds,
            queryStatements,
            runStatements,
            summary,
          }),
        )
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString() || runScript.stdout.toString() || 'SQLite draining lock skip regression test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    activeImportJobIds: string[]
    flushJobIds: string[]
    healthSnapshotJobIds: string[]
    queryStatements: string[]
    runStatements: string[]
    summary: {attemptedCount: number; failedCount: number; skippedCount: number; succeededCount: number}
  }

  expect(result.flushJobIds).toEqual(['draining-job'])
  expect(result.activeImportJobIds).toEqual(['active-job'])
  expect(result.healthSnapshotJobIds).toEqual(['active-job'])
  expect(result.summary).toEqual({attemptedCount: 2, failedCount: 0, skippedCount: 1, succeededCount: 1})
  expect(
    result.queryStatements.some((statement) => {
      return statement.includes('last_import_error')
    }),
  ).toBe(false)
  expect(
    result.runStatements.filter((statement) => {
      return statement.includes('last_import_started_at')
    }),
  ).toHaveLength(2)
})

test('background import records metadata and quarantines repeated failures for the attempted job', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').pathname
        }

        const appDatabaseServiceModulePath = getModulePath('./src/server/services/appDatabaseService.ts')
        const sqliteServiceModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts')
        const outboxImportModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteOutboxImport.ts')
        const backgroundImportModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteBackgroundImport.ts')
        const failureCounts = {'fail-job': 0, 'quarantine-job': 2}
        const queryStatements = []
        const runStatements = []
        const attemptedJobIds = []

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            getAppDatabaseService: () => {
              return {
                queryJson: async (statement) => {
                  queryStatements.push(statement)

                  if (statement.includes("storage_state = 'draining'") && statement.includes('status IN')) {
                    return [{id: 'fail-job'}, {id: 'success-job'}, {id: 'quarantine-job'}]
                  }

                  const matchedJobId = Object.keys(failureCounts).find((jobId) => {
                    return statement.includes("WHERE id = '" + jobId + "'")
                  })

                  if (!matchedJobId) {
                    return []
                  }

                  failureCounts[matchedJobId] += 1
                  return [
                    {
                      importFailureCount: failureCounts[matchedJobId],
                      storageState: failureCounts[matchedJobId] >= 3 ? 'quarantined' : 'active',
                    },
                  ]
                },
                run: async (statement) => {
                  runStatements.push(statement)
                },
              }
            },
          }
        })

        void mock.module(sqliteServiceModulePath, () => {
          return {
            JudgmentJobLeaseError: class JudgmentJobLeaseError extends Error {},
            getJudgmentJobSqliteService: () => {
              return {
                hasOwnedLease: () => false,
                syncOwnedLeases: async () => {},
              }
            },
          }
        })

        void mock.module(outboxImportModulePath, () => {
          return {
            runJudgmentJobSqliteOutboxImportCycle: async ({jobId}) => {
              attemptedJobIds.push(jobId)
              throw new Error(jobId + ' exploded')
            },
          }
        })

        const {runJudgmentJobSqliteBackgroundImport} = await import(backgroundImportModulePath + '?metadata=' + Date.now())
        const summary = await runJudgmentJobSqliteBackgroundImport({claimedBy: 'test-server'})

        console.log(
          JSON.stringify({attemptedJobIds, failureCounts, queryStatements, runStatements, summary}),
        )
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString()
        || runScript.stdout.toString()
        || 'SQLite background import metadata regression test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    attemptedJobIds: string[]
    failureCounts: Record<string, number>
    queryStatements: string[]
    runStatements: string[]
    summary: {attemptedCount: number; failedCount: number; skippedCount: number; succeededCount: number}
  }

  expect(result.attemptedJobIds).toEqual(['fail-job'])
  expect(result.summary).toEqual({attemptedCount: 1, failedCount: 1, skippedCount: 0, succeededCount: 0})
  expect(result.failureCounts).toEqual({'fail-job': 1, 'quarantine-job': 2})
  expect(
    result.runStatements.filter((statement) => {
      return statement.includes('last_import_started_at')
    }),
  ).toHaveLength(1)
  expect(
    result.queryStatements.some((statement) => {
      return statement.includes("WHERE id = 'fail-job'") && statement.includes('last_import_exit_code = 1')
    }),
  ).toBe(true)
  expect(
    result.queryStatements.some((statement) => {
      return statement.includes('storage_state = CASE') && statement.includes("THEN 'quarantined'")
    }),
  ).toBe(true)
})

test('background import records transient SQLite locks and lease conflicts without increasing quarantine failure count', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').pathname
        }

        const appDatabaseServiceModulePath = getModulePath('./src/server/services/appDatabaseService.ts')
        const sqliteServiceModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts')
        const outboxImportModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteOutboxImport.ts')
        const backgroundImportModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteBackgroundImport.ts')
        const queryStatements = []
        const runStatements = []
        const attemptedJobIds = []
        const errorMessages = [
          'SQLITE_BUSY: database is locked',
          'Failed to acquire SQLite job lease for lock-job: Judgment job lease for lock-job is held by host pid=1177 serverJobId=server since 2026-04-28T08:19:22.327Z: EEXIST: file already exists, open lock-job.lease.json',
        ]
        const summaries = []
        let currentErrorMessage = errorMessages[0]

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            getAppDatabaseService: () => {
              return {
                queryJson: async (statement) => {
                  queryStatements.push(statement)

                  if (statement.includes("storage_state = 'draining'") && statement.includes('status IN')) {
                    return [{id: 'lock-job'}]
                  }

                  if (statement.includes("WHERE id = 'lock-job'")) {
                    return [{importFailureCount: 2, storageState: 'active'}]
                  }

                  return []
                },
                run: async (statement) => {
                  runStatements.push(statement)
                },
              }
            },
          }
        })

        void mock.module(sqliteServiceModulePath, () => {
          return {
            JudgmentJobLeaseError: class JudgmentJobLeaseError extends Error {},
            getJudgmentJobSqliteService: () => {
              return {
                hasOwnedLease: () => false,
                syncOwnedLeases: async () => {},
              }
            },
          }
        })

        void mock.module(outboxImportModulePath, () => {
          return {
            runJudgmentJobSqliteOutboxImportCycle: async ({jobId}) => {
              attemptedJobIds.push(jobId)
              throw new Error(currentErrorMessage)
            },
          }
        })

        const {runJudgmentJobSqliteBackgroundImport} = await import(backgroundImportModulePath + '?transient-lock=' + Date.now())
        for (const errorMessage of errorMessages) {
          currentErrorMessage = errorMessage
          summaries.push(await runJudgmentJobSqliteBackgroundImport({claimedBy: 'test-server'}))
        }

        console.log(JSON.stringify({attemptedJobIds, queryStatements, runStatements, summaries}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString()
        || runScript.stdout.toString()
        || 'SQLite background import transient lock and lease conflict regression test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    attemptedJobIds: string[]
    queryStatements: string[]
    runStatements: string[]
    summaries: Array<{attemptedCount: number; failedCount: number; skippedCount: number; succeededCount: number}>
  }

  expect(result.attemptedJobIds).toEqual(['lock-job', 'lock-job'])
  expect(result.summaries).toEqual([
    {attemptedCount: 1, failedCount: 1, skippedCount: 0, succeededCount: 0},
    {attemptedCount: 1, failedCount: 1, skippedCount: 0, succeededCount: 0},
  ])
  expect(
    result.queryStatements.some((statement) => {
      return statement.includes('import_failure_count = import_failure_count + 1')
    }),
  ).toBe(false)
  expect(
    result.queryStatements.some((statement) => {
      return statement.includes("THEN 'quarantined'")
    }),
  ).toBe(false)
  expect(
    result.queryStatements.some((statement) => {
      return statement.includes("WHERE id = 'lock-job'") && statement.includes('last_import_error')
    }),
  ).toBe(true)
})

test('background import releases an owned sqlite lease before importing the next job', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').pathname
        }

        const appDatabaseServiceModulePath = getModulePath('./src/server/services/appDatabaseService.ts')
        const sqliteServiceModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts')
        const outboxImportModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteOutboxImport.ts')
        const backgroundImportModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteBackgroundImport.ts')
        const releasedOwnedLeaseJobIds = []
        const attemptedJobIds = []

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            getAppDatabaseService: () => {
              return {
                queryJson: async (statement) => {
                  return statement.includes("storage_state = 'draining'") && statement.includes('status IN')
                    ? [{id: 'owned-job'}, {id: 'unowned-job'}]
                    : []
                },
                run: async () => {},
              }
            },
          }
        })

        void mock.module(sqliteServiceModulePath, () => {
          return {
            JudgmentJobLeaseError: class JudgmentJobLeaseError extends Error {},
            getJudgmentJobSqliteService: () => {
              return {
                getHealthSnapshot: async () => {
                  return null
                },
                hasOwnedLease: (jobId) => jobId === 'owned-job',
                releaseOwnedLease: async (jobId) => {
                  releasedOwnedLeaseJobIds.push(jobId)
                },
                syncOwnedLeases: async () => {},
              }
            },
          }
        })

        void mock.module(outboxImportModulePath, () => {
          return {
            runJudgmentJobSqliteOutboxImportCycle: async ({jobId}) => {
              attemptedJobIds.push(jobId)
              return {
                claimedBy: 'test-server',
                discardedCount: 0,
                duplicateCount: 0,
                importedCount: 0,
                jobId,
                outboxClaimId: null,
                outboxRowCount: 0,
                status: 'idle',
              }
            },
          }
        })

        const {runJudgmentJobSqliteBackgroundImport} = await import(backgroundImportModulePath + '?owned-lease=' + Date.now())
        const summary = await runJudgmentJobSqliteBackgroundImport({claimedBy: 'test-server'})

        console.log(JSON.stringify({attemptedJobIds, releasedOwnedLeaseJobIds, summary}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString()
        || runScript.stdout.toString()
        || 'SQLite owned-lease background import regression test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    attemptedJobIds: string[]
    releasedOwnedLeaseJobIds: string[]
    summary: {attemptedCount: number; failedCount: number; skippedCount: number; succeededCount: number}
  }

  expect(result.releasedOwnedLeaseJobIds).toEqual(['owned-job'])
  expect(result.attemptedJobIds).toEqual(['owned-job'])
  expect(result.summary).toEqual({attemptedCount: 1, failedCount: 0, skippedCount: 1, succeededCount: 0})
})

test('imports SQLite-backed judgments into DuckDB in batches', async () => {
  if (!runDatabase || !queryDatabase || !sqliteService || !importOutboxBatch || !storeSinglePromptJudgment) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-${Date.now()}`
  const modelId = `model-${Date.now()}`
  const projectId = `project-${Date.now()}`
  const linkedProjectId = `project-linked-${Date.now()}`
  const archivedProjectId = `project-archived-${Date.now()}`
  const jobId = `job-${Date.now()}`
  const promptId = `prompt-${Date.now()}`
  const articleId = `article-${Date.now()}`
  const importRouteId = `import-route-${Date.now()}`

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
    VALUES ('${projectId}', 'SQLite Import Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${linkedProjectId}', 'SQLite Import Linked Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id, archived, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${archivedProjectId}', 'SQLite Import Archived Test', '${modelId}', TRUE, TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('${promptId}', 'Prompt', '${promptId}-hash')
  `)
  await runDatabase(`
    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
    VALUES
      ('${jobId}-project-prompt', '${projectId}', '${promptId}', 1, TRUE),
      ('${jobId}-linked-project-prompt', '${linkedProjectId}', '${promptId}', 1, TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('${articleId}', 'Article')
  `)
  await runDatabase(`
    INSERT INTO app.import_route (id, route, name)
    VALUES ('${importRouteId}', '/sqlite-import-route', 'manual')
  `)
  await runDatabase(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES ('${jobId}-project-article', '${projectId}', '${articleId}')
  `)
  await runDatabase(`
    INSERT INTO app.project_import_route (id, project_id, import_route_id)
    VALUES
      ('${jobId}-linked-route', '${linkedProjectId}', '${importRouteId}'),
      ('${jobId}-archived-route', '${archivedProjectId}', '${importRouteId}')
  `)
  await runDatabase(`
    INSERT INTO app.article_import_route (id, article_id, import_route_id)
    VALUES ('${jobId}-article-route', '${articleId}', '${importRouteId}')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(jobId, [{articleId, promptId}], 'server-a')

  const [claimed] = await service.claimReadyPrompts(jobId, 'server-a', 1)

  if (!claimed) {
    throw new Error('Failed to claim SQLite queue prompt')
  }

  await storeSinglePromptJudgment({
    article: {id: articleId} as ArticleRecord,
    judgmentsJobId: jobId,
    promptId,
    queueRecordId: claimed.recordId,
    modelId,
    projectId,
    judgment: {answer: 'yes', explanation: 'because', quotes: ['quote']},
    chunkingStrategy: null,
  })

  expect((await service.getPendingOutboxBatch({maxBytes: 1024 * 1024, maxRows: 10})).length).toBe(1)
  expect(await importOutboxBatch()).toBe(1)

  const rows = await queryDatabase<{id: string}>(`
    SELECT id
    FROM app.judgment
    WHERE article_id = '${articleId}'
      AND prompt_id = '${promptId}'
      AND model_id = '${modelId}'
  `)

  const reviewChangeDeltaRows = await queryDatabase<{changeKind: string; projectId: string}>(`
    SELECT
      change_kind AS changeKind,
      project_id AS projectId
    FROM app.review_change_delta
    WHERE article_id = '${articleId}'
      AND prompt_id = '${promptId}'
      AND model_id = '${modelId}'
    ORDER BY project_id ASC
  `)

  expect(rows).toHaveLength(1)
  expect(reviewChangeDeltaRows).toEqual([
    {changeKind: 'judgment.llm.created', projectId},
    {changeKind: 'judgment.llm.created', projectId: linkedProjectId},
  ])
  expect((await service.getPendingOutboxBatch({jobId, maxBytes: 1024 * 1024, maxRows: 10})).length).toBe(0)
})

test('outbox import canonicalizes scoped external article ids before DuckDB writes', async () => {
  if (!runDatabase || !queryDatabase || !sqliteService || !importOutboxBatch) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const suffix = Date.now()
  const connectionId = `canonical-outbox-connection-${suffix}`
  const modelId = `canonical-outbox-model-${suffix}`
  const projectId = `canonical-outbox-project-${suffix}`
  const jobId = `canonical-outbox-job-${suffix}`
  const promptId = `canonical-outbox-prompt-${suffix}`
  const articleId = `canonical-outbox-article-${suffix}`
  const externalArticleId = `covidence-outbox:${suffix}`
  const importRouteId = `canonical-outbox-route-${suffix}`
  const judgmentId = `canonical-outbox-judgment-${suffix}`

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
    VALUES ('${projectId}', 'Canonical Outbox Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('${promptId}', 'Prompt', '${promptId}-hash')
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('${articleId}', 'Canonical Outbox Article')
  `)
  await runDatabase(`
    INSERT INTO app.import_route (id, route, name)
    VALUES ('${importRouteId}', 'covidence:outbox-${suffix}', 'manual')
  `)
  await runDatabase(`
    INSERT INTO app.project_import_route (id, project_id, import_route_id)
    VALUES ('project-import-route-${suffix}', '${projectId}', '${importRouteId}')
  `)
  await runDatabase(`
    INSERT INTO app.article_import_route (
      id,
      article_id,
      import_route_id,
      external_article_id,
      source_record_key,
      source_record_hash
    ) VALUES (
      'article-import-route-${suffix}',
      '${articleId}',
      '${importRouteId}',
      '${externalArticleId}',
      'source-record-${suffix}',
      'source-hash-${suffix}'
    )
  `)

  await service.initializeJob(jobId)
  await service.recordJudgmentSuccess(jobId, {
    answeredOriginal: 'yes',
    answeredOriginalAsArray: ['yes'],
    articleId: externalArticleId,
    chunkingStrategy: null,
    confidenceOriginal: 50,
    createdAt: new Date(),
    explanation: 'because',
    isAnswered: true,
    judgmentId,
    modelId,
    projectId,
    promptId,
    queuePromptId: `canonical-outbox-queue-${suffix}`,
    quotes: ['quote'],
    rawResponseJson: {answer: 'yes'},
    snapshotProjectId: projectId,
    snapshotProjectModelName: null,
    updatedAt: new Date(),
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  })

  expect(await importOutboxBatch()).toBe(1)

  const judgmentRows = await queryDatabase<{articleId: string; id: string}>(`
    SELECT id, article_id AS articleId
    FROM app.judgment
    WHERE id = '${judgmentId}'
  `)
  const markerRows = await queryDatabase<{articleId: string}>(`
    SELECT article_id AS articleId
    FROM app.judgment_job_sqlite_outbox_import
    WHERE judgment_id = '${judgmentId}'
  `)

  expect(judgmentRows).toEqual([{articleId, id: judgmentId}])
  expect(markerRows).toEqual([{articleId}])
})

test('drops orphaned SQLite-backed judgments when the article no longer exists', async () => {
  if (!runDatabase || !queryDatabase || !sqliteService || !importOutboxBatch || !storeSinglePromptJudgment) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-orphan-${Date.now()}`
  const modelId = `model-orphan-${Date.now()}`
  const projectId = `project-orphan-${Date.now()}`
  const jobId = `job-orphan-${Date.now()}`
  const promptId = `prompt-orphan-${Date.now()}`
  const articleId = `article-orphan-${Date.now()}`

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
    VALUES ('${projectId}', 'SQLite Import Orphan Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('${promptId}', 'Prompt', '${promptId}-hash')
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('${articleId}', 'Article')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(jobId, [{articleId, promptId}], 'server-a')

  const [claimed] = await service.claimReadyPrompts(jobId, 'server-a', 1)

  if (!claimed) {
    throw new Error('Failed to claim SQLite queue prompt')
  }

  await storeSinglePromptJudgment({
    article: {id: articleId} as ArticleRecord,
    judgmentsJobId: jobId,
    promptId,
    queueRecordId: claimed.recordId,
    modelId,
    projectId,
    judgment: {answer: 'yes', explanation: 'because', quotes: ['quote']},
    chunkingStrategy: null,
  })

  await runDatabase(`
    DELETE FROM app.article
    WHERE id = '${articleId}'
  `)

  expect((await service.getPendingOutboxBatch({maxBytes: 1024 * 1024, maxRows: 10})).length).toBe(1)
  expect(await importOutboxBatch()).toBe(0)
  expect(await service.getUnexportedOutboxCount(jobId)).toBe(0)

  const rows = await queryDatabase<{id: string}>(`
    SELECT id
    FROM app.judgment
    WHERE article_id = '${articleId}'
      AND prompt_id = '${promptId}'
      AND model_id = '${modelId}'
  `)

  expect(rows).toHaveLength(0)
})

test('skips lease-blocked SQLite jobs and imports the next available outbox batch', async () => {
  if (!runDatabase || !queryDatabase || !sqliteService || !importOutboxBatch || !storeSinglePromptJudgment) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-lease-skip-${Date.now()}`
  const modelId = `model-lease-skip-${Date.now()}`
  const blockedProjectId = `project-lease-skip-a-${Date.now()}`
  const blockedJobId = `job-a-lease-skip-${Date.now()}`
  const importableProjectId = `project-lease-skip-z-${Date.now()}`
  const importableJobId = `job-z-lease-skip-${Date.now()}`
  const promptId = `prompt-lease-skip-${Date.now()}`
  const articleId = `article-lease-skip-${Date.now()}`

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
    VALUES ('${blockedProjectId}', 'SQLite Import Lease Skip Blocked', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${importableProjectId}', 'SQLite Import Lease Skip Importable', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${blockedJobId}', '${blockedProjectId}', 'running')
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${importableJobId}', '${importableProjectId}', 'running')
  `)
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('${promptId}', 'Prompt', '${promptId}-hash')
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('${articleId}', 'Article')
  `)

  await service.initializeJob(blockedJobId)
  await service.initializeJob(importableJobId)
  await writeFile(
    join(tempJobDir, `${blockedJobId}.lease.json`),
    JSON.stringify(
      {
        acquiredAt: new Date().toISOString(),
        apiServerPort: 3002,
        heartbeatAt: new Date().toISOString(),
        hostname: hostname(),
        jobId: blockedJobId,
        leaseId: crypto.randomUUID(),
        pid: process.ppid,
        serverJobId: 'other-process',
      },
      null,
      2,
    ),
    'utf8',
  )
  await service.addReadyPrompts(importableJobId, [{articleId, promptId}], 'server-a')

  const [claimed] = await service.claimReadyPrompts(importableJobId, 'server-a', 1)

  if (!claimed) {
    throw new Error('Failed to claim SQLite queue prompt')
  }

  await storeSinglePromptJudgment({
    article: {id: articleId} as ArticleRecord,
    judgmentsJobId: importableJobId,
    promptId,
    queueRecordId: claimed.recordId,
    modelId,
    projectId: importableProjectId,
    judgment: {answer: 'yes', explanation: 'because', quotes: ['quote']},
    chunkingStrategy: null,
  })

  expect(await importOutboxBatch()).toBe(1)

  const rows = await queryDatabase<{id: string}>(`
    SELECT id
    FROM app.judgment
    WHERE article_id = '${articleId}'
      AND prompt_id = '${promptId}'
      AND model_id = '${modelId}'
  `)

  expect(rows).toHaveLength(1)
  expect(
    (await service.getPendingOutboxBatch({jobId: importableJobId, maxBytes: 1024 * 1024, maxRows: 10})).length,
  ).toBe(0)
})

test('replays a SQLite outbox batch after crashing between DuckDB commit and SQLite acknowledgement', async () => {
  if (!runDatabase || !queryDatabase || !sqliteService || !importOutboxBatch || !storeSinglePromptJudgment) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const originalCompleteOutboxClaim = service.completeOutboxClaim
  const connectionId = `connection-replay-${Date.now()}`
  const modelId = `model-replay-${Date.now()}`
  const projectId = `project-replay-${Date.now()}`
  const jobId = `job-replay-${Date.now()}`
  const promptId = `prompt-replay-${Date.now()}`
  const articleId = `article-replay-${Date.now()}`

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
    VALUES ('${projectId}', 'SQLite Import Replay Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('${promptId}', 'Prompt', '${promptId}-hash')
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('${articleId}', 'Article')
  `)
  await runDatabase(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES ('${jobId}-project-article', '${projectId}', '${articleId}')
  `)
  await runDatabase(`
    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
    VALUES ('${jobId}-project-prompt', '${projectId}', '${promptId}', 1, TRUE)
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(jobId, [{articleId, promptId}], 'server-a')

  const [claimedPrompt] = await service.claimReadyPrompts(jobId, 'server-a', 1)

  if (!claimedPrompt) {
    throw new Error('Failed to claim SQLite queue prompt')
  }

  await storeSinglePromptJudgment({
    article: {id: articleId} as ArticleRecord,
    judgmentsJobId: jobId,
    promptId,
    queueRecordId: claimedPrompt.recordId,
    modelId,
    projectId,
    judgment: {answer: 'yes', explanation: 'because', quotes: ['quote']},
    chunkingStrategy: null,
  })

  service.completeOutboxClaim = async () => {
    throw new Error('sqlite acknowledgement crashed')
  }

  try {
    await importOutboxBatch()
    throw new Error('Expected SQLite acknowledgement crash')
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect(error instanceof Error ? error.message : '').toBe('sqlite acknowledgement crashed')
  } finally {
    service.completeOutboxClaim = originalCompleteOutboxClaim
  }

  const rowsAfterCrash = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.judgment
    WHERE article_id = '${articleId}'
      AND prompt_id = '${promptId}'
      AND model_id = '${modelId}'
  `)

  expect(Number(rowsAfterCrash[0]?.count ?? 0)).toBe(1)
  expect(await service.getUnexportedOutboxCount(jobId)).toBe(1)

  const [stateAfterCrash] = await queryDatabase<{dirtyWorkRows: number; markerRows: number}>(`
    SELECT
      (SELECT COUNT(*) FROM app.review_serving_dirty_work WHERE project_id = '${projectId}') AS dirtyWorkRows,
      (SELECT COUNT(*) FROM app.judgment_job_sqlite_outbox_import WHERE job_id = '${jobId}') AS markerRows
  `)

  expect(Number(stateAfterCrash?.dirtyWorkRows ?? 0)).toBe(5)
  expect(Number(stateAfterCrash?.markerRows ?? 0)).toBe(1)
  expect(await importOutboxBatch()).toBe(1)

  const rows = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.judgment
    WHERE article_id = '${articleId}'
      AND prompt_id = '${promptId}'
      AND model_id = '${modelId}'
  `)

  expect(Number(rows[0]?.count ?? 0)).toBe(1)
  expect(await service.getUnexportedOutboxCount(jobId)).toBe(0)

  const [stateAfterRetry] = await queryDatabase<{dirtyWorkRows: number; markerRows: number}>(`
    SELECT
      (SELECT COUNT(*) FROM app.review_serving_dirty_work WHERE project_id = '${projectId}') AS dirtyWorkRows,
      (SELECT COUNT(*) FROM app.judgment_job_sqlite_outbox_import WHERE job_id = '${jobId}') AS markerRows
  `)

  expect(Number(stateAfterRetry?.dirtyWorkRows ?? 0)).toBe(5)
  expect(Number(stateAfterRetry?.markerRows ?? 0)).toBe(1)
})

test('releases claimed SQLite outbox batches for retry when DuckDB insert fails before commit', async () => {
  if (
    !getAppDatabaseService
    || !runDatabase
    || !queryDatabase
    || !sqliteService
    || !importOutboxBatch
    || !storeSinglePromptJudgment
  ) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const database = getAppDatabaseService()
  const originalTransaction = database.transaction
  const connectionId = `connection-retry-${Date.now()}`
  const modelId = `model-retry-${Date.now()}`
  const projectId = `project-retry-${Date.now()}`
  const jobId = `job-retry-${Date.now()}`
  const promptId = `prompt-retry-${Date.now()}`
  const articleId = `article-retry-${Date.now()}`

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
    VALUES ('${projectId}', 'SQLite Import Retry Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('${promptId}', 'Prompt', '${promptId}-hash')
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('${articleId}', 'Article')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(jobId, [{articleId, promptId}], 'server-a')

  const [claimedPrompt] = await service.claimReadyPrompts(jobId, 'server-a', 1)

  if (!claimedPrompt) {
    throw new Error('Failed to claim SQLite queue prompt')
  }

  await storeSinglePromptJudgment({
    article: {id: articleId} as ArticleRecord,
    judgmentsJobId: jobId,
    promptId,
    queueRecordId: claimedPrompt.recordId,
    modelId,
    projectId,
    judgment: {answer: 'yes', explanation: 'because', quotes: ['quote']},
    chunkingStrategy: null,
  })

  try {
    database.transaction = async () => {
      throw new Error('duckdb transaction failed before commit')
    }

    await importOutboxBatch()
    throw new Error('Expected outbox import failure')
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect(error instanceof Error ? error.message : '').toBe('duckdb transaction failed before commit')
  } finally {
    database.transaction = originalTransaction
  }

  expect(await service.getUnexportedOutboxCount(jobId)).toBe(1)
  expect(await importOutboxBatch()).toBe(1)

  const rows = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.judgment
    WHERE article_id = '${articleId}'
      AND prompt_id = '${promptId}'
      AND model_id = '${modelId}'
  `)

  expect(Number(rows[0]?.count ?? 0)).toBe(1)
  expect(await service.getUnexportedOutboxCount(jobId)).toBe(0)
})

test('completes drained import maintenance work after SQLite acknowledgement crash', async () => {
  if (!runDatabase || !queryDatabase || !sqliteService || !importOutboxBatch || !storeSinglePromptJudgment) {
    throw new Error('Test database not initialized')
  }

  const {getMaintenanceWorkLeaseService} = await import('../../services/maintenanceWorkLeaseService.ts')
  const maintenanceWorkLeaseService = getMaintenanceWorkLeaseService()
  const originalCompleteMaintenanceWorkLease = maintenanceWorkLeaseService.completeMaintenanceWorkLease
  const service = sqliteService()
  const connectionId = `connection-maintenance-replay-${Date.now()}`
  const modelId = `model-maintenance-replay-${Date.now()}`
  const projectId = `project-maintenance-replay-${Date.now()}`
  const jobId = `job-maintenance-replay-${Date.now()}`
  const promptId = `prompt-maintenance-replay-${Date.now()}`
  const articleId = `article-maintenance-replay-${Date.now()}`

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
    VALUES ('${projectId}', 'SQLite Import Maintenance Replay Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('${promptId}', 'Prompt', '${promptId}-hash')
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('${articleId}', 'Article')
  `)
  await runDatabase(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES ('${jobId}-project-article', '${projectId}', '${articleId}')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(jobId, [{articleId, promptId}], 'server-a')

  const [claimedPrompt] = await service.claimReadyPrompts(jobId, 'server-a', 1)

  if (!claimedPrompt) {
    throw new Error('Failed to claim SQLite queue prompt')
  }

  await storeSinglePromptJudgment({
    article: {id: articleId} as ArticleRecord,
    judgmentsJobId: jobId,
    promptId,
    queueRecordId: claimedPrompt.recordId,
    modelId,
    projectId,
    judgment: {answer: 'yes', explanation: 'because', quotes: ['quote']},
    chunkingStrategy: null,
  })

  maintenanceWorkLeaseService.completeMaintenanceWorkLease = async () => {
    throw new Error('maintenance completion crashed')
  }

  try {
    await importOutboxBatch()
    throw new Error('Expected maintenance completion crash')
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect(error instanceof Error ? error.message : '').toBe('maintenance completion crashed')
  } finally {
    maintenanceWorkLeaseService.completeMaintenanceWorkLease = originalCompleteMaintenanceWorkLease
  }

  const [leaseAfterCrash] = await queryDatabase<{incompleteLeases: number}>(`
    SELECT COUNT(*) AS incompleteLeases
    FROM app.maintenance_work_lease
    WHERE judgment_job_id = '${jobId}'
      AND work_kind = 'judgment_sqlite_outbox_import'
      AND completed_at IS NULL
  `)

  expect(await service.getUnexportedOutboxCount(jobId)).toBe(0)
  expect(Number(leaseAfterCrash?.incompleteLeases ?? 0)).toBe(1)
  expect(await importOutboxBatch()).toBe(0)

  const [leaseAfterIdle] = await queryDatabase<{incompleteLeases: number}>(`
    SELECT COUNT(*) AS incompleteLeases
    FROM app.maintenance_work_lease
    WHERE judgment_job_id = '${jobId}'
      AND work_kind = 'judgment_sqlite_outbox_import'
      AND completed_at IS NULL
  `)

  expect(Number(leaseAfterIdle?.incompleteLeases ?? 0)).toBe(0)
})

test('leaves refresh acknowledgement publication to the worker when mart visibility completes', async () => {
  if (!runDatabase || !sqliteService || !importOutboxBatch || !storeSinglePromptJudgment) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-ack-${Date.now()}`
  const modelId = `model-ack-${Date.now()}`
  const projectId = `project-ack-${Date.now()}`
  const jobId = `job-ack-${Date.now()}`
  const promptId = `prompt-ack-${Date.now()}`
  const articleId = `article-ack-${Date.now()}`

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
    VALUES ('${projectId}', 'SQLite Import Ack Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('${promptId}', 'Prompt', '${promptId}-hash')
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('${articleId}', 'Article')
  `)

  await service.initializeJob(jobId)
  await service.setLastProjectRefreshAckSeq(jobId, 0)
  await service.addReadyPrompts(jobId, [{articleId, promptId}], 'server-a')

  const [claimedPrompt] = await service.claimReadyPrompts(jobId, 'server-a', 1)

  if (!claimedPrompt) {
    throw new Error('Failed to claim SQLite queue prompt')
  }

  await storeSinglePromptJudgment({
    article: {id: articleId} as ArticleRecord,
    judgmentsJobId: jobId,
    promptId,
    queueRecordId: claimedPrompt.recordId,
    modelId,
    projectId,
    judgment: {answer: 'yes', explanation: 'because', quotes: ['quote']},
    chunkingStrategy: null,
  })

  expect(await importOutboxBatch()).toBe(1)
  expect((await service.getScanState(jobId)).lastProjectRefreshAckSeq).toBe(0)
})

test('does not call legacy mart visibility acknowledgement during outbox import', async () => {
  if (!runDatabase || !queryDatabase || !sqliteService || !importOutboxBatch || !storeSinglePromptJudgment) {
    throw new Error('Test database not initialized')
  }

  const {getProjectMartDirtyRefreshStateService} = await import('../../services/projectMartDirtyRefreshStateService.ts')
  const refreshStateService = getProjectMartDirtyRefreshStateService()
  const originalMarkArticleProjectsDirtyAtomically = refreshStateService.markArticleProjectsDirtyAtomically
  const service = sqliteService()
  const connectionId = `connection-ack-fail-${Date.now()}`
  const modelId = `model-ack-fail-${Date.now()}`
  const projectId = `project-ack-fail-${Date.now()}`
  const jobId = `job-ack-fail-${Date.now()}`
  const promptId = `prompt-ack-fail-${Date.now()}`
  const articleId = `article-ack-fail-${Date.now()}`

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
    VALUES ('${projectId}', 'SQLite Import Ack Failure Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('${promptId}', 'Prompt', '${promptId}-hash')
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('${articleId}', 'Article')
  `)

  await service.initializeJob(jobId)
  await service.setLastProjectRefreshAckSeq(jobId, 0)
  await service.addReadyPrompts(jobId, [{articleId, promptId}], 'server-a')

  const [claimedPrompt] = await service.claimReadyPrompts(jobId, 'server-a', 1)

  if (!claimedPrompt) {
    throw new Error('Failed to claim SQLite queue prompt')
  }

  await storeSinglePromptJudgment({
    article: {id: articleId} as ArticleRecord,
    judgmentsJobId: jobId,
    promptId,
    queueRecordId: claimedPrompt.recordId,
    modelId,
    projectId,
    judgment: {answer: 'yes', explanation: 'because', quotes: ['quote']},
    chunkingStrategy: null,
  })

  refreshStateService.markArticleProjectsDirtyAtomically = async () => {
    throw new Error('refresh state dirty mark failed')
  }

  try {
    expect(await importOutboxBatch()).toBe(1)
  } finally {
    refreshStateService.markArticleProjectsDirtyAtomically = originalMarkArticleProjectsDirtyAtomically
  }

  expect((await service.getScanState(jobId)).lastProjectRefreshAckSeq).toBe(0)
  expect(await service.getUnexportedOutboxCount(jobId)).toBe(0)

  const [stateAfterFailure] = await queryDatabase<{judgmentRows: number; markerRows: number}>(`
    SELECT
      (SELECT COUNT(*) FROM app.judgment WHERE article_id = '${articleId}' AND prompt_id = '${promptId}' AND model_id = '${modelId}') AS judgmentRows,
      (SELECT COUNT(*) FROM app.judgment_job_sqlite_outbox_import WHERE job_id = '${jobId}') AS markerRows
  `)

  expect(Number(stateAfterFailure?.judgmentRows ?? 0)).toBe(1)
  expect(Number(stateAfterFailure?.markerRows ?? 0)).toBe(1)
})

test('single-job sqlite importer emits structured JSON success output', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').pathname
        }

        const appDatabaseServiceModulePath = getModulePath('./src/server/services/appDatabaseService.ts')
        const sqliteServiceModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts')
        const importModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteOutboxImport.ts')
        const scriptAccessModulePath = getModulePath('./src/server/utils/duckdbScriptAccess.ts')
        const scriptModulePath = getModulePath('./scripts/runJudgmentJobSqliteSingleJobImport.ts')

        process.argv = [
          'bun',
          scriptModulePath,
          '--jobId=test-job',
          '--claimedBy=test-claimer',
        ]

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            getAppDatabaseService: () => {
              return {
                close: async () => {},
              }
            },
          }
        })

        void mock.module(sqliteServiceModulePath, () => {
          return {
            getJudgmentJobSqliteService: () => {
              return {
                closeAll: async () => {},
              }
            },
          }
        })

        void mock.module(importModulePath, () => {
          return {
            runJudgmentJobSqliteOutboxImportCycle: async () => {
              return {
                claimedBy: 'test-claimer',
                discardedCount: 1,
                duplicateCount: 2,
                importedCount: 3,
                jobId: 'test-job',
                outboxClaimId: 'claim-1',
                outboxRowCount: 6,
                status: 'imported',
              }
            },
          }
        })

        void mock.module(scriptAccessModulePath, () => {
          return {
            withDuckdbMaintenanceAccess: async (_taskName, work) => {
              return work()
            },
          }
        })

        const {runJudgmentJobSqliteSingleJobImport} = await import(scriptModulePath + '?success=' + Date.now())
        await runJudgmentJobSqliteSingleJobImport()
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString() || runScript.stdout.toString() || 'SQLite single-job importer success test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    claimedBy: string
    cycleStatus: string
    discardedCount: number
    duplicateCount: number
    importedCount: number
    jobId: string
    outboxClaimId: string
    outboxRowCount: number
    status: string
  }

  expect(result).toEqual({
    claimedBy: 'test-claimer',
    cycleStatus: 'imported',
    discardedCount: 1,
    duplicateCount: 2,
    importedCount: 3,
    jobId: 'test-job',
    outboxClaimId: 'claim-1',
    outboxRowCount: 6,
    status: 'ok',
  })
})

test('single-job sqlite importer emits structured JSON failure output and exits non-zero', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').pathname
        }

        const appDatabaseServiceModulePath = getModulePath('./src/server/services/appDatabaseService.ts')
        const sqliteServiceModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts')
        const importModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteOutboxImport.ts')
        const scriptAccessModulePath = getModulePath('./src/server/utils/duckdbScriptAccess.ts')
        const scriptModulePath = getModulePath('./scripts/runJudgmentJobSqliteSingleJobImport.ts')

        process.argv = [
          'bun',
          scriptModulePath,
          '--jobId=test-job',
          '--claimedBy=test-claimer',
        ]

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            getAppDatabaseService: () => {
              return {
                close: async () => {},
              }
            },
          }
        })

        void mock.module(sqliteServiceModulePath, () => {
          return {
            getJudgmentJobSqliteService: () => {
              return {
                closeAll: async () => {},
              }
            },
          }
        })

        void mock.module(importModulePath, () => {
          return {
            runJudgmentJobSqliteOutboxImportCycle: async () => {
              throw new Error('boom')
            },
          }
        })

        void mock.module(scriptAccessModulePath, () => {
          return {
            withDuckdbMaintenanceAccess: async (_taskName, work) => {
              return work()
            },
          }
        })

        const {runJudgmentJobSqliteSingleJobImport} = await import(scriptModulePath + '?failure=' + Date.now())
        await runJudgmentJobSqliteSingleJobImport()
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  expect(runScript.exitCode).toBe(1)

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    claimedBy: string
    error: string
    jobId: string
    status: string
  }

  expect(result).toEqual({claimedBy: 'test-claimer', error: 'boom', jobId: 'test-job', status: 'failed'})
})
