import {afterEach, expect, mock, test} from 'bun:test'

const getModulePath = (relativePath: string) => {
  return new URL(relativePath, 'file://' + process.cwd() + '/').href
}

const appReadOnlyDatabaseServiceModulePath = getModulePath('./src/server/services/appReadOnlyDatabaseService.ts')
const reviewServingJudgmentJobQueueServiceModulePath = getModulePath(
  './src/server/reviewServing/reviewServingJudgmentJobQueueService.ts',
)
const judgmentsJobsCronGetPromptsModulePath = getModulePath(
  './src/server/cron/judgmentsJobs/judgmentsJobsCronGetPrompts.ts',
)

afterEach(() => {
  mock.restore()
})

test('metadata reads use execution-time budgets so DuckDB queue wait does not block refill', async () => {
  const workloadContexts: unknown[] = []

  void mock.module(appReadOnlyDatabaseServiceModulePath, () => {
    return {
      getJudgeWorkerReadOnlyAppDatabaseService: () => {
        return {
          queryJson: async <T>(statement: string, workloadContext?: unknown): Promise<T[]> => {
            workloadContexts.push(workloadContext)

            return statement.includes('FROM app.project_prompt')
              ? ([{count: 1}] as T[])
              : statement.includes('FROM app.project')
                ? ([{archived: false, id: 'project-1'}] as T[])
                : []
          },
        }
      },
    }
  })
  void mock.module(reviewServingJudgmentJobQueueServiceModulePath, () => {
    return {
      getJudgmentJobUnassessedPairsFromServing: async () => {
        return {nextCursor: null, promptEntries: []}
      },
    }
  })

  const module = (await import(
    `${judgmentsJobsCronGetPromptsModulePath}?metadata-execution-budget=${Date.now()}`
  )) as typeof import('./judgmentsJobsCronGetPrompts.ts')

  await module.judgmentsJobsCronGetPrompts('project-1', 'job-1', 1)

  const metadataContexts = workloadContexts.filter((context) => {
    return (
      context !== undefined
      && context !== null
      && typeof context === 'object'
      && (context as {workloadClass?: unknown}).workloadClass === 'judgmentJobMetadata'
    )
  })

  expect(metadataContexts).toEqual([
    expect.objectContaining({routeOrJobKey: 'judgmentQueue.job-1.project', timeoutMs: 2000, timeoutScope: 'execution'}),
    expect.objectContaining({
      routeOrJobKey: 'judgmentQueue.job-1.enabledPromptCount',
      timeoutMs: 2000,
      timeoutScope: 'execution',
    }),
  ])
})
