import {rmSync} from 'node:fs'

import {beforeEach, expect, mock, test} from 'bun:test'

import {
  defaultProjectMartRefreshWorkerIncrementalArticleThreshold,
  getProjectMartRefreshExecutionMode,
  type ProjectMartRefreshRunnerService,
  type ProjectMartRefreshStateWorkerService,
  type ProjectMartRefreshWorkerDependencies,
  runProjectMartRefreshWorkerCycle,
  runProjectMartRefreshWorkerOnce,
} from './projectMartRefreshWorker.ts'

type ClaimPlan = {
  claimedToken: number
  lastCompletedToken: number
  leaseExpiresAt: Date
  projectId: string
  workerId: string
}

const getLastJsonLine = (output: string) => {
  return output
    .trim()
    .split('\n')
    .reverse()
    .find((line) => {
      return line.trim().startsWith('{')
    })
}

const createWorkerTestContext = (params: {
  ackPublishShouldThrow?: boolean
  articlesByProject?: Record<string, string[]>
  claims?: ClaimPlan[]
  onRefreshProject?: (projectId: string) => Promise<void>
  reconciledProjectIds?: string[]
  scopeArticleCountByProject?: Record<string, number>
}) => {
  const callLog: string[] = []
  const claims = [...(params.claims ?? [])]
  const acknowledgedProjects: Array<{ackToken: number | null; projectId: string}> = []
  const completed: Array<{completedToken: number; projectId: string; workerId: string}> = []
  const failed: Array<{error: string; projectId: string; workerId: string}> = []
  const heartbeatCalls: Array<{leaseMs: number; projectId: string; workerId: string}> = []
  const released: Array<{projectId: string; workerId: string}> = []
  const stateService: ProjectMartRefreshStateWorkerService = {
    claimDirtyProjects: mock(async ({leaseMs, limit, workerId}: {leaseMs: number; limit: number; workerId: string}) => {
      callLog.push(`claim:${workerId}:${limit}:${leaseMs}`)
      const [claim] = claims

      return claim === undefined ? [] : [claims.shift() as ClaimPlan]
    }),
    completeProjectRefresh: mock(
      async ({completedToken, projectId, workerId}: {completedToken: number; projectId: string; workerId: string}) => {
        callLog.push(`complete:${projectId}:${completedToken}`)
        completed.push({completedToken, projectId, workerId})
        return null
      },
    ),
    failProjectRefresh: mock(
      async ({error, projectId, workerId}: {error: string; projectId: string; workerId: string}) => {
        callLog.push(`fail:${projectId}:${error}`)
        failed.push({error, projectId, workerId})
        return null
      },
    ),
    getDirtyArticlesForClaim: mock(
      async ({projectId}: {claimedToken: number; lastCompletedToken: number; projectId: string}) => {
        callLog.push(`load:${projectId}`)

        return (params.articlesByProject?.[projectId] ?? []).map((articleId) => {
          return {articleId}
        })
      },
    ),
    heartbeatClaim: mock(
      async ({leaseMs, projectId, workerId}: {leaseMs: number; projectId: string; workerId: string}) => {
        callLog.push(`heartbeat:${projectId}`)
        heartbeatCalls.push({leaseMs, projectId, workerId})
        return null
      },
    ),
    releaseProjectRefreshClaim: mock(async ({projectId, workerId}: {projectId: string; workerId: string}) => {
      callLog.push(`release:${projectId}`)
      released.push({projectId, workerId})
      return null
    }),
  }
  const refreshService: ProjectMartRefreshRunnerService = {
    refreshJudgmentArticle: mock(async (articleId: string) => {
      callLog.push(`judgment:${articleId}`)
    }),
    refreshProject: mock(async (projectId: string) => {
      callLog.push(`project:${projectId}`)
      return params.onRefreshProject?.(projectId)
    }),
    refreshProjectArticleServing: mock(async (projectId: string, articleId: string) => {
      callLog.push(`serving:${projectId}:${articleId}`)
    }),
  }
  const remainingReconciledProjectIds = [...(params.reconciledProjectIds ?? [])]
  const sqliteService = {
    publishProjectRefreshAck: mock(async ({ackToken, projectId}: {ackToken: number | null; projectId: string}) => {
      callLog.push(`ack:${projectId}:${ackToken ?? 'null'}`)
      acknowledgedProjects.push({ackToken, projectId})

      if (params.ackPublishShouldThrow) {
        throw new Error('sqlite ack publish exploded')
      }

      return 1
    }),
    reconcileProjectRefreshAcks: mock(async ({projectId}: {projectId?: string} = {}) => {
      callLog.push(`reconcile:${projectId ?? 'all'}`)

      return projectId
        ? Number(remainingReconciledProjectIds.includes(projectId))
        : remainingReconciledProjectIds.splice(0, remainingReconciledProjectIds.length).length
    }),
  }
  const queuedLargeRebuilds: Array<{projectId: string; rebuildPhase: string; refreshToken: number}> = []
  const dependencies: ProjectMartRefreshWorkerDependencies = {
    largeRebuildStateService: {
      queueLargeRebuild: mock(async ({projectId, rebuildPhase, refreshToken}) => {
        callLog.push(`largeRebuild:${projectId}:${rebuildPhase}:${refreshToken}`)
        queuedLargeRebuilds.push({projectId, rebuildPhase, refreshToken})
        return null
      }),
    },
    projectInspector: {
      getProjectScopeArticleCount: mock(async (projectId: string) => {
        callLog.push(`scope:${projectId}`)
        return params.scopeArticleCountByProject?.[projectId] ?? 0
      }),
    },
    refreshService,
    sleep: mock(async () => {}),
    sqliteService,
    stateService,
  }

  return {acknowledgedProjects, callLog, completed, dependencies, failed, heartbeatCalls, queuedLargeRebuilds}
}

beforeEach(() => {
  mock.restore()
})

test('classifies refresh execution mode as idle incremental or full', () => {
  expect(getProjectMartRefreshExecutionMode({dirtyArticleCount: 0, incrementalArticleThreshold: 3})).toBe('idle')
  expect(getProjectMartRefreshExecutionMode({dirtyArticleCount: 3, incrementalArticleThreshold: 3})).toBe('incremental')
  expect(getProjectMartRefreshExecutionMode({dirtyArticleCount: 4, incrementalArticleThreshold: 3})).toBe('full')
})

test('one-shot worker reuses single-cycle behavior and exits after one claim attempt', async () => {
  const context = createWorkerTestContext({
    claims: [
      {
        claimedToken: 3,
        lastCompletedToken: 2,
        leaseExpiresAt: new Date('2026-04-02T13:00:30.000Z'),
        projectId: 'project-1',
        workerId: 'worker-1',
      },
      {
        claimedToken: 1,
        lastCompletedToken: 0,
        leaseExpiresAt: new Date('2026-04-02T13:00:30.000Z'),
        projectId: 'project-2',
        workerId: 'worker-1',
      },
    ],
  })

  const result = await runProjectMartRefreshWorkerOnce({leaseMs: 2_000, workerId: 'worker-1'}, context.dependencies)

  expect(result).toEqual({claimedToken: 3, projectId: 'project-1', status: 'completed', workerId: 'worker-1'})
  expect(context.callLog[0]).toBe('reconcile:all')
  expect(context.callLog[1]).toBe('claim:worker-1:1:2000')
  expect(context.completed).toEqual([{completedToken: 3, projectId: 'project-1', workerId: 'worker-1'}])
  expect(context.acknowledgedProjects).toEqual([{ackToken: 3, projectId: 'project-1'}])
})

test('claims at most one project per cycle', async () => {
  const context = createWorkerTestContext({
    claims: [
      {
        claimedToken: 3,
        lastCompletedToken: 2,
        leaseExpiresAt: new Date('2026-04-02T13:00:30.000Z'),
        projectId: 'project-1',
        workerId: 'worker-1',
      },
      {
        claimedToken: 1,
        lastCompletedToken: 0,
        leaseExpiresAt: new Date('2026-04-02T13:00:30.000Z'),
        projectId: 'project-2',
        workerId: 'worker-1',
      },
    ],
  })

  const result = await runProjectMartRefreshWorkerCycle({leaseMs: 2_000, workerId: 'worker-1'}, context.dependencies)

  expect(result).toEqual({claimedToken: 3, projectId: 'project-1', status: 'completed', workerId: 'worker-1'})
  expect(context.callLog[0]).toBe('reconcile:all')
  expect(context.callLog[1]).toBe('claim:worker-1:1:2000')
  expect(context.completed).toEqual([{completedToken: 3, projectId: 'project-1', workerId: 'worker-1'}])
  expect(context.acknowledgedProjects).toEqual([{ackToken: 3, projectId: 'project-1'}])
})

test('refreshes judgment facts before the project rebuild', async () => {
  const context = createWorkerTestContext({
    articlesByProject: {'project-1': ['article-2', 'article-1']},
    claims: [
      {
        claimedToken: 2,
        lastCompletedToken: 1,
        leaseExpiresAt: new Date('2026-04-02T13:10:30.000Z'),
        projectId: 'project-1',
        workerId: 'worker-1',
      },
    ],
  })

  await runProjectMartRefreshWorkerCycle({incrementalArticleThreshold: 0, workerId: 'worker-1'}, context.dependencies)

  expect(context.callLog).toEqual([
    'reconcile:all',
    'claim:worker-1:1:30000',
    'load:project-1',
    'judgment:article-2',
    'judgment:article-1',
    'scope:project-1',
    'project:project-1',
    'complete:project-1:2',
    'ack:project-1:2',
  ])
})

test('uses incremental article-aware refresh routing for small deltas', async () => {
  const context = createWorkerTestContext({
    articlesByProject: {'project-1': ['article-1', 'article-2']},
    claims: [
      {
        claimedToken: 3,
        lastCompletedToken: 2,
        leaseExpiresAt: new Date('2026-04-02T13:10:30.000Z'),
        projectId: 'project-1',
        workerId: 'worker-1',
      },
    ],
  })

  await runProjectMartRefreshWorkerCycle({incrementalArticleThreshold: 2, workerId: 'worker-1'}, context.dependencies)

  expect(context.callLog).toEqual([
    'reconcile:all',
    'claim:worker-1:1:30000',
    'load:project-1',
    'judgment:article-1',
    'serving:project-1:article-1',
    'judgment:article-2',
    'serving:project-1:article-2',
    'complete:project-1:3',
    'ack:project-1:3',
  ])
})

test('falls back to a full project refresh when the dirty-article delta exceeds the threshold', async () => {
  const context = createWorkerTestContext({
    articlesByProject: {'project-1': ['article-1', 'article-2', 'article-3', 'article-4']},
    claims: [
      {
        claimedToken: 5,
        lastCompletedToken: 4,
        leaseExpiresAt: new Date('2026-04-02T13:10:30.000Z'),
        projectId: 'project-1',
        workerId: 'worker-1',
      },
    ],
  })

  await runProjectMartRefreshWorkerCycle({incrementalArticleThreshold: 3, workerId: 'worker-1'}, context.dependencies)

  expect(context.callLog).toEqual([
    'reconcile:all',
    'claim:worker-1:1:30000',
    'load:project-1',
    'judgment:article-1',
    'judgment:article-2',
    'judgment:article-3',
    'judgment:article-4',
    'scope:project-1',
    'project:project-1',
    'complete:project-1:5',
    'ack:project-1:5',
  ])
})

test('records failures when a claimed refresh errors', async () => {
  const context = createWorkerTestContext({
    articlesByProject: {'project-1': ['article-1']},
    claims: [
      {
        claimedToken: 7,
        lastCompletedToken: 6,
        leaseExpiresAt: new Date('2026-04-02T13:20:30.000Z'),
        projectId: 'project-1',
        workerId: 'worker-1',
      },
    ],
    onRefreshProject: async () => {
      throw new Error('project refresh exploded')
    },
  })

  const result = await runProjectMartRefreshWorkerCycle(
    {incrementalArticleThreshold: 0, workerId: 'worker-1'},
    context.dependencies,
  )

  expect(result).toEqual({
    claimedToken: 7,
    error: 'project refresh exploded',
    projectId: 'project-1',
    status: 'failed',
    workerId: 'worker-1',
  })
  expect(context.failed).toEqual([{error: 'project refresh exploded', projectId: 'project-1', workerId: 'worker-1'}])
  expect(context.completed).toEqual([])
  expect(context.acknowledgedProjects).toEqual([])
})

test('routes oversized automatic full refreshes into large rebuild state before project rebuilds', async () => {
  const context = createWorkerTestContext({
    articlesByProject: {'project-1': ['article-1', 'article-2', 'article-3', 'article-4']},
    claims: [
      {
        claimedToken: 9,
        lastCompletedToken: 8,
        leaseExpiresAt: new Date('2026-04-02T13:20:30.000Z'),
        projectId: 'project-1',
        workerId: 'worker-1',
      },
    ],
    scopeArticleCountByProject: {'project-1': 200_000},
  })

  const result = await runProjectMartRefreshWorkerCycle(
    {incrementalArticleThreshold: 3, maxFullProjectScopeArticles: 100_000, workerId: 'worker-1'},
    context.dependencies,
  )

  expect(result).toEqual({claimedToken: 9, projectId: 'project-1', status: 'completed', workerId: 'worker-1'})
  expect(context.callLog).toEqual([
    'reconcile:all',
    'claim:worker-1:1:30000',
    'load:project-1',
    'judgment:article-1',
    'judgment:article-2',
    'judgment:article-3',
    'judgment:article-4',
    'scope:project-1',
    'largeRebuild:project-1:prompt_answer_fact:9',
    'release:project-1',
  ])
  expect(context.queuedLargeRebuilds).toEqual([{projectId: 'project-1', rebuildPhase: 'prompt_answer_fact', refreshToken: 9}])
  expect(context.failed).toEqual([])
  expect(context.completed).toEqual([])
  expect(context.acknowledgedProjects).toEqual([])
})

test('can process work reclaimed after an expired lease', async () => {
  const context = createWorkerTestContext({
    articlesByProject: {'project-1': ['article-1']},
    claims: [
      {
        claimedToken: 4,
        lastCompletedToken: 3,
        leaseExpiresAt: new Date('2026-04-02T13:30:30.000Z'),
        projectId: 'project-1',
        workerId: 'worker-2',
      },
    ],
  })

  const result = await runProjectMartRefreshWorkerCycle(
    {incrementalArticleThreshold: 0, leaseMs: 5_000, workerId: 'worker-2'},
    context.dependencies,
  )

  expect(result).toEqual({claimedToken: 4, projectId: 'project-1', status: 'completed', workerId: 'worker-2'})
  expect(context.callLog).toEqual([
    'reconcile:all',
    'claim:worker-2:1:5000',
    'load:project-1',
    'judgment:article-1',
    'scope:project-1',
    'project:project-1',
    'complete:project-1:4',
    'ack:project-1:4',
  ])
})

test('returns idle when nothing is claimable', async () => {
  const context = createWorkerTestContext({})

  const result = await runProjectMartRefreshWorkerCycle({workerId: 'worker-1'}, context.dependencies)

  expect(result).toEqual({projectId: null, status: 'idle', workerId: 'worker-1'})
  expect(context.callLog).toEqual(['reconcile:all', 'claim:worker-1:1:30000'])
})

test('replays sqlite ack publication after a post-completion crash without rerunning refresh work', async () => {
  const crashContext = createWorkerTestContext({
    ackPublishShouldThrow: true,
    articlesByProject: {'project-1': ['article-1']},
    claims: [
      {
        claimedToken: 8,
        lastCompletedToken: 7,
        leaseExpiresAt: new Date('2026-04-02T13:40:30.000Z'),
        projectId: 'project-1',
        workerId: 'worker-1',
      },
    ],
  })

  try {
    await runProjectMartRefreshWorkerCycle({workerId: 'worker-1'}, crashContext.dependencies)
    throw new Error('Expected sqlite ack publish failure')
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect(error instanceof Error ? error.message : '').toBe('sqlite ack publish exploded')
  }
  expect(crashContext.completed).toEqual([{completedToken: 8, projectId: 'project-1', workerId: 'worker-1'}])
  expect(crashContext.failed).toEqual([])

  const reconcileContext = createWorkerTestContext({reconciledProjectIds: ['project-1']})

  const result = await runProjectMartRefreshWorkerCycle({workerId: 'worker-1'}, reconcileContext.dependencies)

  expect(result).toEqual({projectId: null, status: 'idle', workerId: 'worker-1'})
  expect(reconcileContext.callLog).toEqual(['reconcile:all', 'claim:worker-1:1:30000'])
  expect(reconcileContext.completed).toEqual([])
  expect(reconcileContext.failed).toEqual([])
})

test('incremental routing keeps review pages counts warnings and prompt queueing aligned with full refresh', () => {
  const runWorkerMode = (duckdbPath: string, threshold: number) => {
    const runScript = globalThis.Bun.spawnSync(
      [
        'bun',
        '-e',
        `
          const {Elysia} = await import('elysia')
          const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
          const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
          const {getProjectMartRefreshStateService} = await import('./src/server/services/projectMartRefreshStateService.ts')
          const {projectsRoutesGetReviewsWarnings} = await import('./src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.ts')
          const {judgmentsJobsCronGetPrompts} = await import('./src/server/cron/judgmentsJobs/judgmentsJobsCronGetPrompts.ts')
          const {queryArticlesReviewsFromDuckdb, getUnassessedCountFromDuckdb} = await import('./src/services/olap/duckdbOlap.ts')
          const {runProjectMartRefreshWorkerCycle} = await import('./src/server/workers/projectMartRefreshWorker.ts')

          await migrateDuckdb()

          const database = getAppDatabaseService()
          const refreshStateService = getProjectMartRefreshStateService()

          await database.run(\`
            INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
            VALUES ('connection-worker-routing-test', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
          \`)
          await database.run(\`
            INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
            VALUES ('model-worker-routing-test', 'connection-worker-routing-test', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
          \`)
          await database.run(\`
            INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
            VALUES ('project-worker-routing-test', 'Worker Routing Project', 'model-worker-routing-test', TRUE, TRUE, FALSE, FALSE)
          \`)
          await database.run(\`
            INSERT INTO app.prompt (id, original_text, content_hash)
            VALUES
              ('prompt-worker-routing-1', 'Prompt 1', 'hash-worker-routing-1'),
              ('prompt-worker-routing-2', 'Prompt 2', 'hash-worker-routing-2')
          \`)
          await database.run(\`
            INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
            VALUES
              ('project-prompt-worker-routing-1', 'project-worker-routing-test', 'prompt-worker-routing-1', 1, TRUE),
              ('project-prompt-worker-routing-2', 'project-worker-routing-test', 'prompt-worker-routing-2', 2, TRUE)
          \`)
          await database.run(\`
            INSERT INTO app.article (id, article_title, article_created_at, article_updated_at, article_id)
            VALUES
              ('article-worker-routing-1', 'Worker Routing Article 1', '2024-01-02T00:00:00.000Z', '2024-01-03T00:00:00.000Z', 'external-worker-routing-1'),
              ('article-worker-routing-2', 'Worker Routing Article 2', '2024-01-04T00:00:00.000Z', '2024-01-05T00:00:00.000Z', 'external-worker-routing-2')
          \`)
          await database.run(\`
            INSERT INTO app.project_article (id, project_id, article_id)
            VALUES
              ('project-article-worker-routing-1', 'project-worker-routing-test', 'article-worker-routing-1'),
              ('project-article-worker-routing-2', 'project-worker-routing-test', 'article-worker-routing-2')
          \`)
          await database.run(\`
            INSERT INTO app.judgment (
              id,
              article_id,
              prompt_id,
              model_id,
              project_id,
              snapshot_project_id,
              use_title,
              use_abstract,
              use_fulltext,
              use_fulltext_no_images,
              is_answered,
              answered_original,
              answered_original_as_array,
              confidence_original
            ) VALUES
              (
                'judgment-worker-routing-1a',
                'article-worker-routing-1',
                'prompt-worker-routing-1',
                'model-worker-routing-test',
                'project-worker-routing-test',
                'project-worker-routing-test',
                TRUE,
                TRUE,
                FALSE,
                FALSE,
                TRUE,
                'yes',
                ['yes'],
                90
              ),
              (
                'judgment-worker-routing-1b',
                'article-worker-routing-1',
                'prompt-worker-routing-2',
                'model-worker-routing-test',
                'project-worker-routing-test',
                'project-worker-routing-test',
                TRUE,
                TRUE,
                FALSE,
                FALSE,
                TRUE,
                'maybe',
                ['maybe'],
                80
              ),
              (
                'judgment-worker-routing-2a',
                'article-worker-routing-2',
                'prompt-worker-routing-1',
                'model-worker-routing-test',
                'project-worker-routing-test',
                'project-worker-routing-test',
                TRUE,
                TRUE,
                FALSE,
                FALSE,
                TRUE,
                'no',
                ['no'],
                75
              )
          \`)

          await refreshStateService.markProjectsDirtyAtomically({
            projects: [{
              articleIds: ['article-worker-routing-1', 'article-worker-routing-2'],
              projectId: 'project-worker-routing-test',
            }],
            reason: 'projectMartRefreshWorker.test.initial',
          })
          await runProjectMartRefreshWorkerCycle({incrementalArticleThreshold: 0, workerId: 'worker-routing-initial'})

          await database.run(\`
            UPDATE app.judgment
            SET answered_original = 'include',
                answered_original_as_array = ['include'],
                updated_at = current_timestamp
            WHERE id = 'judgment-worker-routing-1a'
          \`)

          await refreshStateService.markProjectsDirtyAtomically({
            projects: [{
              articleIds: ['article-worker-routing-1'],
              projectId: 'project-worker-routing-test',
            }],
            reason: 'projectMartRefreshWorker.test.delta',
          })

          await runProjectMartRefreshWorkerCycle({
            incrementalArticleThreshold: Number(process.env.WORKER_INCREMENTAL_THRESHOLD ?? '0'),
            workerId: 'worker-routing-delta',
          })

          const reviews = await queryArticlesReviewsFromDuckdb({limit: 10, page: 1, projectId: 'project-worker-routing-test'})
          const unassessedCount = await getUnassessedCountFromDuckdb({jobId: 'job-worker-routing-test', projectId: 'project-worker-routing-test'})
          const promptQueue = await judgmentsJobsCronGetPrompts('project-worker-routing-test', 'job-worker-routing-test', 10)

          const app = new Elysia().use(projectsRoutesGetReviewsWarnings)
          const warningsResponse = await app.handle(
            new Request('http://localhost/api/projectsreviewswarnings', {
              body: JSON.stringify({projectId: 'project-worker-routing-test'}),
              headers: {'content-type': 'application/json'},
              method: 'POST',
            }),
          )
          const warningsResponseBody = await warningsResponse.json()
          const warnings = warningsResponseBody.data
          const [refreshState] = await database.queryJson(\`
            SELECT
              CAST(dirty_token AS INTEGER) AS dirtyToken,
              CAST(last_completed_refresh_token AS INTEGER) AS lastCompletedRefreshToken,
              refresh_status AS refreshStatus
            FROM app.project_mart_refresh_state
            WHERE project_id = 'project-worker-routing-test'
            LIMIT 1
          \`)

          console.log(JSON.stringify({
            promptEntries: promptQueue.promptEntries,
            refreshState,
            reviews: {
              data: reviews.data.map((row) => {
                return {
                  id: row.id,
                  isFullyJudged: row.isFullyJudged,
                  judgedPromptIds: row.judgedPromptIds,
                }
              }),
              totalCount: reviews.totalCount,
            },
            unassessedCount,
            warnings: {
              indexing: {
                inFlightArticleRefreshCount: warnings.indexing.inFlightArticleRefreshCount,
                inFlightProjectRefreshCount: warnings.indexing.inFlightProjectRefreshCount,
                oldestQueuedAt: warnings.indexing.oldestQueuedAt,
                queuedArticleRefreshCount: warnings.indexing.queuedArticleRefreshCount,
                queuedProjectRefreshCount: warnings.indexing.queuedProjectRefreshCount,
                queuedRefreshCount: warnings.indexing.queuedRefreshCount,
                status: warnings.indexing.status,
              },
              warning: warnings.warning,
            },
          }))

          await database.close()
        `,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          API_SERVER_PORT: '3001',
          DUCKDB_PATH: duckdbPath,
          SERVER_ROLE: 'dev-single',
          VITE_PORT: '3000',
          WORKER_INCREMENTAL_THRESHOLD: String(threshold),
        },
      },
    )

    if (runScript.exitCode !== 0) {
      throw new Error(
        runScript.stderr.toString() || runScript.stdout.toString() || 'Worker incremental routing parity test failed',
      )
    }

    const resultLine = getLastJsonLine(runScript.stdout.toString())

    if (!resultLine) {
      throw new Error(runScript.stdout.toString() || 'Missing JSON result from worker incremental routing test')
    }

    return JSON.parse(resultLine) as {
      promptEntries: Array<{articleId: string; promptId: string}>
      refreshState: {dirtyToken: number; lastCompletedRefreshToken: number; refreshStatus: string}
      reviews: {data: Array<{id: string; isFullyJudged: boolean; judgedPromptIds: string[]}>; totalCount: number | null}
      unassessedCount: number
      warnings: unknown
    }
  }

  const incrementalDuckdbPath = `/tmp/f1-worker-routing-incremental-${Date.now()}.duckdb`
  const fullDuckdbPath = `/tmp/f1-worker-routing-full-${Date.now()}.duckdb`

  try {
    const incrementalResult = runWorkerMode(
      incrementalDuckdbPath,
      defaultProjectMartRefreshWorkerIncrementalArticleThreshold,
    )
    const fullRefreshResult = runWorkerMode(fullDuckdbPath, 0)

    expect(incrementalResult).toEqual(fullRefreshResult)
    expect(incrementalResult.reviews.data).toEqual([
      {id: 'article-worker-routing-2', isFullyJudged: false, judgedPromptIds: ['prompt-worker-routing-1']},
      {
        id: 'article-worker-routing-1',
        isFullyJudged: true,
        judgedPromptIds: ['prompt-worker-routing-1', 'prompt-worker-routing-2'],
      },
    ])
    expect(incrementalResult.unassessedCount).toBe(1)
    expect(incrementalResult.promptEntries).toEqual([
      {articleId: 'article-worker-routing-2', promptId: 'prompt-worker-routing-2'},
    ])
  } finally {
    for (const path of [incrementalDuckdbPath, fullDuckdbPath]) {
      rmSync(path, {force: true})
      rmSync(`${path}.writer.lock`, {force: true})
      rmSync(`${path}.writer.history.json`, {force: true})
    }
  }
})
