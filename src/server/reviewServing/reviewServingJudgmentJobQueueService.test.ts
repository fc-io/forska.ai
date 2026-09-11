import {expect, mock, test} from 'bun:test'

import type {DuckdbWorkloadContext} from '../utils/duckdbService.ts'

type JudgmentJobQueueServiceScopeRow = {
  componentStateJson: string
  projectId: string
  reviewConfigHash: string
  selectedImportSnapshotId: string | null
  snapshotId: string
  snapshotStatus: 'active' | 'candidate'
}

type CandidateReadinessRow = {
  incompleteComponentCount: number
  readyComponentCount: number
  selectedImportCompletedCount: number
}

type FakeReadOnlyDatabase = {
  candidateReadinessRows: CandidateReadinessRow[]
  close: () => Promise<void>
  queryJson: <T>(statement: string, workloadContext?: DuckdbWorkloadContext) => Promise<T[]>
  snapshotRows: ReturnType<typeof getScopeRow>[]
  statements: string[]
  validate: () => Promise<void>
}
type JudgmentJobQueueServiceModule = typeof import('./reviewServingJudgmentJobQueueService.ts')

const appReadOnlyDatabaseServiceModulePath = new URL('../services/appReadOnlyDatabaseService.ts', import.meta.url).href
const reviewServingReviewConfigModulePath = new URL('./reviewServingReviewConfig.ts', import.meta.url).href
const serviceModulePath = new URL('./reviewServingJudgmentJobQueueService.ts', import.meta.url).href
let currentReviewConfigHash = 'config-1'

const getScopeRow = (overrides: Partial<JudgmentJobQueueServiceScopeRow> = {}) => {
  return {
    componentStateJson: JSON.stringify({
      optional: [],
      required: [{component: 'projectScope', projectionIdentity: 'project-scope-1'}],
    }),
    projectId: 'project-1',
    reviewConfigHash: 'config-1',
    selectedImportSnapshotId: 'selected-import-snapshot-1',
    snapshotId: 'snapshot-1',
    snapshotStatus: 'active' as const,
    ...overrides,
  }
}

const getArticleRow = () => {
  return {
    articleCreatedAt: '2026-01-01T00:00:00.000Z',
    articleId: 'article-1',
    articleTitle: 'Article 1',
    articleUpdatedAt: '2026-01-02T00:00:00.000Z',
  }
}

const createFakeReadOnlyDatabase = () => {
  const database: FakeReadOnlyDatabase = {
    candidateReadinessRows: [{incompleteComponentCount: 0, readyComponentCount: 6, selectedImportCompletedCount: 1}],
    close: async () => {},
    queryJson: async <T>(statement: string): Promise<T[]> => {
      database.statements.push(statement)

      if (statement.includes('FROM app.review_serving_snapshot_manifest')) {
        const reviewConfigHashMatch = statement.match(/review_config_hash = '([^']+)'/u)?.[1] ?? null

        return (
          reviewConfigHashMatch === null
            ? database.snapshotRows
            : database.snapshotRows.filter((row) => {
                return row.reviewConfigHash === reviewConfigHashMatch
              })
        ) as T[]
      }

      if (statement.includes('WITH required_component') && statement.includes('app.review_rebuild_chunk_manifest')) {
        return database.candidateReadinessRows as T[]
      }

      if (statement.includes('SELECT COUNT(DISTINCT queue.article_id) AS count')) {
        return [{count: 1}] as T[]
      }

      if (statement.includes('FROM mart.review_unassessed_queue_article_rank_serving_v4 queue')) {
        return [getArticleRow()] as T[]
      }

      if (statement.includes('SELECT') && statement.includes('queue.prompt_id AS promptId')) {
        return [
          {activitySortAt: '2026-01-03T00:00:00.000Z', articleId: 'article-1', priorityBucket: 1, promptId: 'prompt-1'},
        ] as T[]
      }

      return [] as T[]
    },
    snapshotRows: [getScopeRow()],
    statements: [],
    validate: async () => {},
  }

  return database
}

const apiDatabase = createFakeReadOnlyDatabase()
const judgeWorkerDatabase = createFakeReadOnlyDatabase()

void mock.module(appReadOnlyDatabaseServiceModulePath, () => {
  return {
    getApiReadOnlyAppDatabaseService: () => {
      return apiDatabase
    },
    getJudgeWorkerReadOnlyAppDatabaseService: () => {
      return judgeWorkerDatabase
    },
  }
})

void mock.module(reviewServingReviewConfigModulePath, () => {
  return {
    getCurrentReviewServingReviewConfigHash: async () => {
      return currentReviewConfigHash
    },
  }
})

const resetDatabases = () => {
  currentReviewConfigHash = 'config-1'
  apiDatabase.candidateReadinessRows = [
    {incompleteComponentCount: 0, readyComponentCount: 6, selectedImportCompletedCount: 1},
  ]
  apiDatabase.snapshotRows = [getScopeRow()]
  apiDatabase.statements = []
  judgeWorkerDatabase.candidateReadinessRows = [
    {incompleteComponentCount: 0, readyComponentCount: 6, selectedImportCompletedCount: 1},
  ]
  judgeWorkerDatabase.snapshotRows = [getScopeRow()]
  judgeWorkerDatabase.statements = []
}

const expectUnassessedDirectServingJoin = (statement: string) => {
  expect(statement).toContain('INNER JOIN mart.review_article_serving_base_v4 article')
  expect(statement).toContain("queue.queue_kind = 'unassessed'")
  expect(statement).not.toContain('review_article_serving_list_mode_state_v4')
  expect(statement).not.toContain("list_contains(list_mode_state.list_mode_keys, 'unassessed')")
  expect(statement).not.toContain('INNER JOIN mart.review_article_serving_v4 article')
  expect(statement).not.toContain('article.list_mode_key')
}

const expectArticleRankQueueRead = (statement: string) => {
  expect(statement).toContain('FROM mart.review_unassessed_queue_article_rank_serving_v4 queue')
  expect(statement).not.toContain('FROM mart.review_unassessed_queue_serving_v4 queue')
  expect(statement).not.toContain('CROSS JOIN UNNEST(queue.prompt_ids)')
}

const expectPromptQueueRead = (statement: string) => {
  expect(statement).toContain('queue_union AS')
  expect(statement).toContain('FROM queue_union source_queue')
  expect(statement).not.toContain('FROM mart.review_unassessed_queue_serving_v4 queue')
  expect(statement).not.toContain('CROSS JOIN UNNEST(queue.prompt_ids)')
  expect(statement).not.toContain('FROM mart.review_unassessed_queue_article_rank_serving_v4 queue')
}

const service = (await import(
  `${serviceModulePath}?judgment-job-queue-scope=${Date.now()}`
)) as JudgmentJobQueueServiceModule

test('judgment job count and preview scope keeps route matches plus curated articles', async () => {
  resetDatabases()

  const count = await service.getJudgmentJobUnassessedCountFromServing({
    importRouteIds: ['route-1'],
    projectDateFrom: new Date('2026-01-01T00:00:00.000Z'),
    projectDateTo: new Date('2026-01-31T00:00:00.000Z'),
    projectId: 'project-1',
  })
  const {articles} = await service.getJudgmentJobUnassessedArticlesFromServing({
    importRouteIds: ['route-1'],
    limit: 100,
    projectDateFrom: new Date('2026-01-01T00:00:00.000Z'),
    projectDateTo: new Date('2026-01-31T00:00:00.000Z'),
    projectId: 'project-1',
  })
  const queueStatements = apiDatabase.statements.filter((statement) => {
    return statement.includes('FROM mart.review_unassessed_queue_article_rank_serving_v4 queue')
  })

  expect(count).toBe(1)
  expect(articles).toHaveLength(1)
  expect(queueStatements).toHaveLength(2)
  queueStatements.forEach((statement) => {
    expectUnassessedDirectServingJoin(statement)
    expectArticleRankQueueRead(statement)
  })
  expect(
    queueStatements.map((statement) => {
      return statement.includes('FROM app.article_import_route article_route_scope')
    }),
  ).toEqual([true, true])
  expect(
    queueStatements.map((statement) => {
      return statement.includes("article_route_scope.import_route_id IN ('route-1')")
    }),
  ).toEqual([true, true])
  expect(
    queueStatements.map((statement) => {
      return statement.includes('OR EXISTS')
    }),
  ).toEqual([true, true])
  expect(
    queueStatements.map((statement) => {
      return statement.includes('FROM app.project_article project_article_scope')
    }),
  ).toEqual([true, true])
  expect(
    queueStatements.map((statement) => {
      return statement.includes('article.selected_import_route_id IN')
    }),
  ).toEqual([false, false])
})

test('judgment job count scope without import routes uses curated project articles only', async () => {
  resetDatabases()

  await service.getJudgmentJobUnassessedCountFromServing({
    importRouteIds: [],
    projectDateFrom: null,
    projectDateTo: null,
    projectId: 'project-1',
  })
  const countStatement = apiDatabase.statements.find((statement) => {
    return statement.includes('SELECT COUNT(DISTINCT queue.article_id) AS count')
  })

  expectUnassessedDirectServingJoin(countStatement ?? '')
  expectArticleRankQueueRead(countStatement ?? '')
  expect(countStatement ?? '').toContain('FROM app.project_article project_article_scope')
  expect(countStatement ?? '').not.toContain('FROM app.article_import_route article_route_scope')
})

test('judgment job refill uses dispatch-ready candidate snapshot before full snapshot promotion', async () => {
  resetDatabases()
  judgeWorkerDatabase.snapshotRows = [getScopeRow({snapshotId: 'candidate-snapshot-1', snapshotStatus: 'candidate'})]

  const result = await service.getJudgmentJobUnassessedPairsFromServing({
    cursor: null,
    jobId: 'job-1',
    numberOfPromptsToGet: 10,
    projectId: 'project-1',
  })
  const snapshotStatement = judgeWorkerDatabase.statements.find((statement) => {
    return statement.includes('FROM app.review_serving_snapshot_manifest')
  })
  const readinessStatement = judgeWorkerDatabase.statements.find((statement) => {
    return statement.includes('app.review_rebuild_chunk_manifest')
  })

  expect(result.promptEntries).toEqual([{articleId: 'article-1', promptId: 'prompt-1'}])
  expect(snapshotStatement ?? '').toContain("snapshot_status IN ('active', 'candidate')")
  expect(readinessStatement ?? '').toContain("('projectScope')")
  expect(readinessStatement ?? '').toContain("('selectedImport')")
  expect(readinessStatement ?? '').toContain("('display')")
  expect(readinessStatement ?? '').toContain("('llmStatus')")
  expect(readinessStatement ?? '').toContain("('queue')")
  expect(readinessStatement ?? '').toContain("('judgmentInputContent')")
  expect(readinessStatement ?? '').not.toContain("('summary')")
})

test('judgment job refill falls back to dispatch-ready previous review config snapshot', async () => {
  resetDatabases()
  currentReviewConfigHash = 'config-2'
  judgeWorkerDatabase.snapshotRows = [
    getScopeRow({reviewConfigHash: 'config-1', snapshotId: 'candidate-snapshot-1', snapshotStatus: 'candidate'}),
  ]

  const result = await service.getJudgmentJobUnassessedPairsFromServing({
    cursor: null,
    jobId: 'job-1',
    numberOfPromptsToGet: 10,
    projectId: 'project-1',
  })
  const scopeStatements = judgeWorkerDatabase.statements.filter((statement) => {
    return statement.includes('FROM app.review_serving_snapshot_manifest')
  })
  const refillStatement = judgeWorkerDatabase.statements.find((statement) => {
    return statement.includes('queue.prompt_id AS promptId')
  })

  expect(result.promptEntries).toEqual([{articleId: 'article-1', promptId: 'prompt-1'}])
  expect(scopeStatements).toHaveLength(2)
  expect(scopeStatements[0] ?? '').toContain("review_config_hash = 'config-2'")
  expect(scopeStatements[1] ?? '').not.toContain('review_config_hash =')
  expect(refillStatement ?? '').toContain("'config-1' AS review_config_hash")
})

test('judgment job refill ignores incomplete candidate snapshot', async () => {
  resetDatabases()
  judgeWorkerDatabase.snapshotRows = [getScopeRow({snapshotId: 'candidate-snapshot-1', snapshotStatus: 'candidate'})]
  judgeWorkerDatabase.candidateReadinessRows = [
    {incompleteComponentCount: 1, readyComponentCount: 5, selectedImportCompletedCount: 1},
  ]

  const result = await service.getJudgmentJobUnassessedPairsFromServing({
    cursor: null,
    jobId: 'job-1',
    numberOfPromptsToGet: 10,
    projectId: 'project-1',
  })
  const refillStatement = judgeWorkerDatabase.statements.find((statement) => {
    return statement.includes('queue.prompt_id AS promptId')
  })

  expect(result.promptEntries).toEqual([])
  expect(refillStatement).toBeUndefined()
})

test('judgment job refill scope rechecks current project dates routes and curated articles', async () => {
  resetDatabases()

  const result = await service.getJudgmentJobUnassessedPairsFromServing({
    cursor: null,
    jobId: 'job-1',
    numberOfPromptsToGet: 10,
    projectId: 'project-1',
  })
  const refillStatement = judgeWorkerDatabase.statements.find((statement) => {
    return statement.includes('queue.prompt_id AS promptId')
  })

  expect(result.promptEntries).toEqual([{articleId: 'article-1', promptId: 'prompt-1'}])
  expectUnassessedDirectServingJoin(refillStatement ?? '')
  expectPromptQueueRead(refillStatement ?? '')
  expect(refillStatement ?? '').toContain('INNER JOIN app.project current_project')
  expect(refillStatement ?? '').toContain('INNER JOIN app.article current_article')
  expect(refillStatement ?? '').toContain('current_article.article_created_at >= current_project.date_from')
  expect(refillStatement ?? '').toContain(
    'current_article.article_created_at < current_project.date_to + INTERVAL 1 DAY',
  )
  expect(refillStatement ?? '').toContain('FROM app.project_import_route current_project_route_scope')
  expect(refillStatement ?? '').toContain('INNER JOIN app.article_import_route current_article_route_scope')
  expect(refillStatement ?? '').toContain('FROM app.project_article current_project_article_scope')
  expect(refillStatement ?? '').toContain(
    'ORDER BY queue.priority_bucket DESC, queue.activity_sort_at DESC, queue.article_id DESC, queue.prompt_id DESC',
  )
})
