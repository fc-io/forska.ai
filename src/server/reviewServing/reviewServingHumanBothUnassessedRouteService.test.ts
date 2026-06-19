import {readFile} from 'node:fs/promises'

import {expect, test} from 'bun:test'

import type {DuckdbWorkloadContext} from '../utils/duckdbService.ts'
import type {ReviewServingProjectionComponent, ReviewServingSnapshotStatus} from './reviewServingContracts.ts'
import {
  getBothReviewArticlesFromServing,
  getHumanReviewArticlesFromServing,
  getUnassessedReviewArticlesFromServing,
} from './reviewServingHumanBothUnassessedRouteService.ts'
import type {ReviewServingManifestRepositoryDatabase} from './reviewServingManifestRepository.ts'
import type {ReviewServingReaderDatabase} from './reviewServingReader.ts'

const components: readonly ReviewServingProjectionComponent[] = [
  'display',
  'projectScope',
  'selectedImport',
  'payload',
  'llmStatus',
  'humanStatus',
  'posting',
  'summary',
  'queue',
  'search',
  'judgmentInputContent',
]
const forbiddenSqlFragments = [
  'selected_scoped_article_import',
  'FROM app.article',
  'FROM app.judgment',
  'OFFSET',
  'json_extract',
  'json_extract_string',
]

const getComponentState = () => {
  return {
    optional: [],
    required: components.map((component) => {
      return {
        baseGeneration: '1',
        component,
        patchWatermark: '2',
        projectionIdentity: `${component}-identity`,
        requirement: 'required' as const,
      }
    }),
  }
}

const getSnapshotRow = (status: ReviewServingSnapshotStatus) => {
  return {
    componentStateJson: getComponentState(),
    composedIdentityJson: {snapshot: `${status}-snapshot`},
    lastError: status === 'failed' ? 'projection failed' : null,
    lastKnownGoodSnapshotId: status === 'active' ? 'retired-snapshot' : null,
    optionalComponentsJson: [],
    projectId: 'project-1',
    requiredComponentsJson: components,
    reviewConfigHash: 'config-1',
    selectedImportSnapshotId: 'selected-import-snapshot-1',
    snapshotId: `${status}-snapshot`,
    snapshotStatus: status,
    sourceWatermarksJson: {},
    validationResultJson: null,
  }
}

const getDiagnosticsRows = (statement: string) => {
  return statement.includes('GROUP BY snapshot_status') ? [{snapshotCount: 1, snapshotStatus: 'active'}] : []
}

const createManifestDatabase = (status: ReviewServingSnapshotStatus | 'missing') => {
  const database: ReviewServingManifestRepositoryDatabase = {
    queryJson: async <T>(statement: string): Promise<T[]> => {
      if (!statement.includes('FROM app.review_serving_snapshot_manifest')) {
        return getDiagnosticsRows(statement) as T[]
      }

      if (status === 'missing') {
        return []
      }

      if (statement.includes("snapshot_status = 'active'")) {
        return status === 'active' ? ([getSnapshotRow('active')] as T[]) : []
      }

      if (statement.includes("snapshot_status = 'retired'")) {
        return status === 'retired' ? ([getSnapshotRow('retired')] as T[]) : []
      }

      return [getSnapshotRow(status)] as T[]
    },
    run: async () => {},
    transaction: async (operation) => {
      return operation(database)
    },
  }

  return database
}

const createReaderDatabase = () => {
  const statements: string[] = []
  const database: ReviewServingReaderDatabase = {
    queryJson: async <T>(statement: string, _workloadContext?: DuckdbWorkloadContext): Promise<T[]> => {
      statements.push(statement)

      if (statement.includes('FROM mart.review_unassessed_queue_serving_v4')) {
        return [{activity_sort_at: '2026-01-04T00:00:00.000Z', article_id: 'article-1', priority_bucket: 1}] as T[]
      }

      if (statement.includes('FROM mart.review_article_serving_v4')) {
        return [
          {
            activity_sort_at: '2026-01-02T00:00:00.000Z',
            article_external_id: 'external-1',
            article_id: 'article-1',
            article_title: 'Article 1',
            journal_title: 'Journal',
            sort_key: '2026-01-01T00:00:00.000Z',
            url: 'https://example.test/article-1',
          },
        ] as T[]
      }

      if (
        statement.includes('FROM mart.review_article_judgment_detail_serving_v4')
        && statement.includes("payload_kind = 'human'")
      ) {
        return [
          {
            article_id: 'article-1',
            prompt_id: 'prompt-1',
            judgment_id: 'human-1',
            answered_original: 'yes',
            answered_original_as_array: ['yes'],
            judgment_payload_json: {answer: 'yes', createdAt: '2026-01-03T00:00:00.000Z', isAnswered: true},
          },
        ] as T[]
      }

      if (statement.includes('FROM mart.review_article_judgment_detail_serving_v4')) {
        return [
          {
            article_id: 'article-1',
            prompt_id: 'prompt-1',
            model_id: 'model-1',
            judgment_id: 'llm-1',
            answered_original: 'yes',
            answered_original_as_array: ['yes'],
            judgment_payload_json: {createdAt: '2026-01-03T00:00:00.000Z', explanation: 'because', quotes: []},
          },
        ] as T[]
      }

      return [{availability: 'ready', count_value: 1}] as T[]
    },
  }

  return {database, statements}
}

test('human review route service uses serving rows, human payload hydration, and count without raw fallback', async () => {
  const reader = createReaderDatabase()
  const result = await getHumanReviewArticlesFromServing(
    {
      projectId: 'project-1',
      page: 1,
      limit: 100,
      from: '2026-01-01',
      to: '2026-01-31',
      search: 'heart',
      hasDuplicateStudyRecords: true,
      hasStudyDecisionConflict: true,
      prompts: {'prompt-1': ['yes']},
    },
    {
      currentReviewConfigHash: 'config-1',
      database: reader.database,
      manifestDatabase: createManifestDatabase('active'),
    },
  )
  const sql = reader.statements.join('\n')

  expect((result.data[0] as {judgments: {answer: string | null}[]}).judgments[0]?.answer).toBe('yes')
  expect(reader.statements).toHaveLength(3)
  expect(sql).toContain('FROM mart.review_article_serving_v4')
  expect(sql).toContain('FROM mart.review_article_judgment_detail_serving_v4')
  expect(sql).toContain("payload_kind = 'human'")
  expect(sql).toContain('SELECT COUNT(DISTINCT serving.article_id) AS totalCount')
  expect(sql).toContain("article_id IN (SELECT unnest(['article-1']::VARCHAR[]))")
  forbiddenSqlFragments.forEach((fragment) => {
    expect(sql).not.toContain(fragment)
  })
})

test('both review route service hydrates LLM and human payloads in bounded article-set reads', async () => {
  const reader = createReaderDatabase()
  const result = await getBothReviewArticlesFromServing(
    {projectId: 'project-1', page: 1, limit: 50, prompts: {'prompt-1': ['yes']}},
    {
      currentReviewConfigHash: 'config-1',
      database: reader.database,
      manifestDatabase: createManifestDatabase('active'),
    },
  )
  const sql = reader.statements.join('\n')

  expect(result.data[0]?.judgments[0]?.answeredOriginal).toBe('yes')
  expect(result.data[0]?.humanAnswersByPrompt?.['prompt-1']).toEqual(['yes'])
  expect(reader.statements).toHaveLength(4)
  expect(sql.match(/article_id IN \(SELECT unnest\(\['article-1'\]::VARCHAR\[\]\)\)/gu)?.length).toBe(2)
  expect(sql).toContain("list_mode_key = 'both'")
  expect(sql).toContain("payload_kind = 'llm'")
  expect(sql).toContain("payload_kind = 'human'")
  forbiddenSqlFragments.forEach((fragment) => {
    expect(sql).not.toContain(fragment)
  })
})

test('unassessed review route service pages filtered distinct article rows and queue count', async () => {
  const reader = createReaderDatabase()
  const result = await getUnassessedReviewArticlesFromServing(
    {projectId: 'project-1', page: 1, limit: 25, search: 'heart', prompts: {}},
    {
      currentReviewConfigHash: 'config-1',
      database: reader.database,
      manifestDatabase: createManifestDatabase('active'),
    },
  )
  const sql = reader.statements.join('\n')

  expect(result.data).toHaveLength(1)
  expect(reader.statements).toHaveLength(2)
  expect(reader.statements[0]).toContain('FROM mart.review_article_serving_v4')
  expect(reader.statements[0]).toContain('EXISTS (SELECT 1 FROM mart.review_unassessed_queue_serving_v4 queue')
  expect(reader.statements[0]).toContain("starts_with(search.token, 'heart')")
  expect(reader.statements[1]).toContain("count_kind = 'review.queue.unassessedReady'")
  forbiddenSqlFragments.forEach((fragment) => {
    expect(sql).not.toContain(fragment)
  })
})

test('human, both, and unassessed services surface stale and unavailable freshness without raw fallback', async () => {
  const staleReader = createReaderDatabase()
  const staleResult = await getUnassessedReviewArticlesFromServing(
    {projectId: 'project-1', page: 1, limit: 25, prompts: {}},
    {
      currentReviewConfigHash: 'config-1',
      database: staleReader.database,
      manifestDatabase: createManifestDatabase('retired'),
    },
  )

  expect(staleResult.totalCount).toBe(1)
  expect(staleReader.statements.join('\n')).toContain('FROM mart.review_unassessed_queue_serving_v4')

  await getHumanReviewArticlesFromServing(
    {projectId: 'project-1', page: 1, limit: 25, prompts: {}},
    {
      currentReviewConfigHash: 'config-1',
      database: createReaderDatabase().database,
      manifestDatabase: createManifestDatabase('candidate'),
    },
  )
    .then(() => {
      throw new Error('expected indexing freshness to reject')
    })
    .catch((error: unknown) => {
      expect(error).toBeInstanceOf(Error)
      expect(error instanceof Error ? error.message : '').toContain('Review serving snapshot is unavailable')
    })
  await getBothReviewArticlesFromServing(
    {projectId: 'project-1', page: 1, limit: 25, prompts: {}},
    {
      currentReviewConfigHash: 'config-1',
      database: createReaderDatabase().database,
      manifestDatabase: createManifestDatabase('missing'),
    },
  )
    .then(() => {
      throw new Error('expected unavailable freshness to reject')
    })
    .catch((error: unknown) => {
      expect(error).toBeInstanceOf(Error)
      expect(error instanceof Error ? error.message : '').toContain('Review serving snapshot is unavailable')
    })
})

test('migrated human, both, and unassessed routes do not import OLAP or raw fallback wrappers', async () => {
  const humanRoute = await readFile('src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsHuman.ts', 'utf8')
  const bothRoute = await readFile('src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsBoth.ts', 'utf8')
  const unassessedRoute = await readFile(
    'src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsUnassessed.ts',
    'utf8',
  )

  expect(humanRoute).not.toContain('getAppDatabaseService')
  expect(humanRoute).not.toContain('OFFSET')
  expect(bothRoute).not.toContain('articlesReviewsBothOlap')
  expect(bothRoute).not.toContain('queryArticlesReviewsBothFromOlap')
  expect(unassessedRoute).not.toContain('unassessedArticlesOlap')
  expect(unassessedRoute).not.toContain('getUnassessedArticlesFromOlap')
})
