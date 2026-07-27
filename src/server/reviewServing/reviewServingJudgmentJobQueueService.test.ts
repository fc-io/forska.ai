import {expect, mock, test} from 'bun:test'

import type {DuckdbWorkloadContext} from '../utils/duckdbService.ts'

type FakeReadOnlyDatabase = {
  close: () => Promise<void>
  queryJson: <T>(statement: string, workloadContext?: DuckdbWorkloadContext) => Promise<T[]>
  statements: string[]
  validate: () => Promise<void>
}
type JudgmentJobQueueServiceModule = typeof import('./reviewServingJudgmentJobQueueService.ts')

const appReadOnlyDatabaseServiceModulePath = new URL('../services/appReadOnlyDatabaseService.ts', import.meta.url)
  .pathname
const reviewServingReviewConfigModulePath = new URL('./reviewServingReviewConfig.ts', import.meta.url).pathname
const serviceModulePath = new URL('./reviewServingJudgmentJobQueueService.ts', import.meta.url).pathname

const getScopeRow = () => {
  return {projectId: 'project-1', reviewConfigHash: 'config-1', snapshotId: 'snapshot-1'}
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
    close: async () => {},
    queryJson: async <T>(statement: string): Promise<T[]> => {
      database.statements.push(statement)

      if (statement.includes('FROM app.review_serving_snapshot_manifest')) {
        return [getScopeRow()] as T[]
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
      return 'config-1'
    },
  }
})

const resetDatabases = () => {
  apiDatabase.statements = []
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
  expect(statement).toContain('FROM mart.review_unassessed_queue_serving_v4 queue')
  expect(statement).toContain('CROSS JOIN UNNEST(queue.prompt_ids) AS expanded_prompt(prompt_id)')
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
  expect(refillStatement ?? '').toContain('article.article_created_at >= current_project.date_from')
  expect(refillStatement ?? '').toContain('article.article_created_at < current_project.date_to + INTERVAL 1 DAY')
  expect(refillStatement ?? '').toContain('FROM app.project_import_route current_project_route_scope')
  expect(refillStatement ?? '').toContain('INNER JOIN app.article_import_route current_article_route_scope')
  expect(refillStatement ?? '').toContain('FROM app.project_article current_project_article_scope')
  expect(refillStatement ?? '').toContain(
    'ORDER BY queue.priority_bucket DESC, queue.activity_sort_at DESC, queue.article_id DESC, queue.prompt_id DESC',
  )
})
