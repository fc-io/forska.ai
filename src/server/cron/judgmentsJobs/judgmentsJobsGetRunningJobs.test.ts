import {afterEach, expect, mock, test} from 'bun:test'

import {filterRunningJobsByRuntimeMatch, type RunningJudgmentJob} from './judgmentsJobsGetRunningJobs.ts'

const getLoggedDetailsText = (value: unknown) => {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

const getJob = (id: string): RunningJudgmentJob => {
  return {
    id,
    maxInflightRequests: null,
    modelId: `${id}-model`,
    modelName: 'Qwen/Qwen3.5-35B-A3B',
    modelProvider: 'sglang',
    quarantineReason: null,
    providerConnectionId: `${id}-connection`,
    projectId: `${id}-project`,
    storageState: 'active',
  }
}

afterEach(() => {
  mock.restore()
})

test('judge-worker running jobs come from the owner-backed API', async () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').pathname
        }

        const judgmentsJobsGetRunningJobsModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsGetRunningJobs.ts')
        const judgeWorkerCompletionJournalModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgeWorkerCompletionJournal.ts')
        const readOnlyDatabaseServiceModulePath = getModulePath('./src/server/services/appReadOnlyDatabaseService.ts')
        const sqlitePreflightModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqlitePreflight.ts')
        let readOnlyQueries = 0

        void mock.module(judgeWorkerCompletionJournalModulePath, () => {
          return {
            getOwnerBackedRunningJudgmentJobs: async () => [{
              id: 'job-owner-backed',
              maxInflightRequests: null,
              modelId: 'job-owner-backed-model',
              modelName: 'Qwen/Qwen3.5-35B-A3B',
              modelProvider: 'sglang',
              quarantineReason: null,
              providerConnectionId: 'job-owner-backed-connection',
              projectId: 'job-owner-backed-project',
              storageState: 'active',
            }],
            shouldUseJudgeWorkerOwnerHandoff: () => true,
          }
        })
        void mock.module(readOnlyDatabaseServiceModulePath, () => {
          return {
            getJudgeWorkerReadOnlyAppDatabaseService: () => {
              return {
                queryJson: async () => {
                  readOnlyQueries += 1
                  return []
                },
              }
            },
          }
        })
        void mock.module(sqlitePreflightModulePath, () => {
          return {
            filterRunningJobsBySqlitePreflight: async (jobs) => jobs,
          }
        })

        const {judgmentsJobsGetRunningJobs} = await import(judgmentsJobsGetRunningJobsModulePath + '?owner-backed=' + Date.now())
        const jobs = await judgmentsJobsGetRunningJobs({applyRuntimeMatchFilter: false})
        console.log(JSON.stringify({jobs, readOnlyQueries}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString() || runScript.stdout.toString() || 'owner-backed running jobs test failed',
    )
  }

  const result = JSON.parse(runScript.stdout.toString()) as {jobs: RunningJudgmentJob[]; readOnlyQueries: number}

  expect(result.jobs).toEqual([getJob('job-owner-backed')])
  expect(result.readOnlyQueries).toBe(0)
})

test('filterRunningJobsByRuntimeMatch filters out jobs with runtime mismatch', async () => {
  const getRuntimeMatch = mock(async ({modelId}: {modelId: string}) => {
    return {
      message: modelId === 'model-mismatch' ? 'runtime mismatch' : null,
      ok: modelId !== 'model-mismatch',
      reason: modelId === 'model-mismatch' ? ('runtime-mismatch' as const) : null,
    }
  })
  const jobs: RunningJudgmentJob[] = [
    {
      id: 'job-ok',
      maxInflightRequests: null,
      modelId: 'model-ok',
      modelName: 'Qwen/Qwen3.5-35B-A3B',
      modelProvider: 'sglang',
      quarantineReason: null,
      providerConnectionId: 'connection-ok',
      projectId: 'project-ok',
      storageState: 'active',
    },
    {
      id: 'job-mismatch',
      maxInflightRequests: null,
      modelId: 'model-mismatch',
      modelName: 'Qwen/Qwen3.5-32B',
      modelProvider: 'sglang',
      quarantineReason: null,
      providerConnectionId: 'connection-mismatch',
      projectId: 'project-mismatch',
      storageState: 'active',
    },
  ]

  const filtered = await filterRunningJobsByRuntimeMatch(jobs, getRuntimeMatch)

  expect(
    filtered.map((job) => {
      return job.id
    }),
  ).toEqual(['job-ok'])
  expect(getRuntimeMatch).toHaveBeenCalledTimes(2)
})

test('filterRunningJobsByRuntimeMatch logs when the runtime is unreachable', async () => {
  const getRuntimeMatch = mock(async () => {
    return {
      message:
        'Could not reach the configured SGLang runtime at http://127.0.0.1:30000/v1, so Forska could not confirm it serves Qwen/Qwen3.5-35B-A3B. Connection error.',
      ok: false,
      reason: 'runtime-unreachable' as const,
    }
  })
  const originalWarn = console.warn
  const warn = mock((_message: unknown, _details: unknown) => {})

  console.warn = warn as typeof console.warn

  try {
    const filtered = await filterRunningJobsByRuntimeMatch([getJob('job-unreachable')], getRuntimeMatch)
    const details = getLoggedDetailsText(warn.mock.calls[0]?.[1] ?? null)

    expect(filtered).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toBe('[judgments] skipping running job because the SGLang runtime is unreachable')
    expect(details).toContain('"reason":"runtime-unreachable"')
  } finally {
    console.warn = originalWarn
  }
})

test('filterRunningJobsByRuntimeMatch logs when the runtime is serving a different model', async () => {
  const getRuntimeMatch = mock(async () => {
    return {
      message:
        'Configured SGLang runtime at http://127.0.0.1:30000/v1 is serving other-model, but the project expects Qwen/Qwen3.5-35B-A3B.',
      ok: false,
      reason: 'runtime-mismatch' as const,
    }
  })
  const originalWarn = console.warn
  const warn = mock((_message: unknown, _details: unknown) => {})

  console.warn = warn as typeof console.warn

  try {
    const filtered = await filterRunningJobsByRuntimeMatch([getJob('job-mismatch-log')], getRuntimeMatch)
    const details = getLoggedDetailsText(warn.mock.calls[0]?.[1] ?? null)

    expect(filtered).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toBe(
      '[judgments] skipping running job because the SGLang runtime is serving a different model',
    )
    expect(details).toContain('"reason":"runtime-mismatch"')
  } finally {
    console.warn = originalWarn
  }
})
