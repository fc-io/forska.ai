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
const defaultReadableComponents: readonly ReviewServingProjectionComponent[] = [
  'display',
  'projectScope',
  'selectedImport',
  'llmStatus',
  'humanStatus',
  'posting',
  'summary',
  'queue',
]
const forbiddenSqlFragments = ['selected_scoped_article_import', 'FROM app.article', 'FROM app.judgment', 'OFFSET']
const hasArticleServingRowSource = (statement: string) => {
  return statement.includes('FROM mart.review_article_serving_base_v4 serving')
}

const getComponentState = (inputComponents: readonly ReviewServingProjectionComponent[] = components) => {
  return {
    optional: [],
    required: inputComponents.map((component) => {
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

const getSnapshotRow = (
  status: ReviewServingSnapshotStatus,
  inputComponents: readonly ReviewServingProjectionComponent[] = components,
) => {
  return {
    componentStateJson: getComponentState(inputComponents),
    composedIdentityJson: {snapshot: `${status}-snapshot`},
    lastError: status === 'failed' ? 'projection failed' : null,
    lastKnownGoodSnapshotId: status === 'active' ? 'retired-snapshot' : null,
    optionalComponentsJson: [],
    projectId: 'project-1',
    requiredComponentsJson: inputComponents,
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

const createManifestDatabase = (
  status: ReviewServingSnapshotStatus | 'missing',
  inputComponents: readonly ReviewServingProjectionComponent[] = components,
) => {
  const database: ReviewServingManifestRepositoryDatabase = {
    queryJson: async <T>(statement: string): Promise<T[]> => {
      if (!statement.includes('FROM app.review_serving_snapshot_manifest')) {
        return getDiagnosticsRows(statement) as T[]
      }

      if (status === 'missing') {
        return []
      }

      if (statement.includes("snapshot_status = 'active'")) {
        return status === 'active' ? ([getSnapshotRow('active', inputComponents)] as T[]) : []
      }

      if (statement.includes("snapshot_status = 'retired'")) {
        return status === 'retired' ? ([getSnapshotRow('retired', inputComponents)] as T[]) : []
      }

      return [getSnapshotRow(status, inputComponents)] as T[]
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

      if (statement.includes('SELECT COUNT(*)::INTEGER AS promptCount')) {
        return [{promptCount: 1}] as T[]
      }

      if (statement.includes(' AS totalCount')) {
        return [{totalCount: 1}] as T[]
      }

      if (statement.includes('FROM mart.review_unassessed_queue_article_rank_serving_v4')) {
        return [{activity_sort_at: '2026-01-04T00:00:00.000Z', article_id: 'article-1', priority_bucket: 1}] as T[]
      }

      if (hasArticleServingRowSource(statement)) {
        return [
          {
            activity_sort_at: '2026-01-02T00:00:00.000Z',
            article_created_at: null,
            article_external_id: 'external-1',
            article_id: 'article-1',
            article_title: 'Article 1',
            journal_title: 'Journal',
            source_metadata: JSON.stringify({covidence: {studyId: 'study-1'}}),
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
            detail_updated_at: '2026-01-04T00:00:00.000Z',
            human_comment: 'human note',
            judgment_created_at: '2026-01-03T00:00:00.000Z',
          },
        ] as T[]
      }

      if (statement.includes('FROM mart.review_article_judgment_detail_serving_v4')) {
        return [
          {
            article_id: 'article-1',
            prompt_id: 'prompt-1',
            judgment_id: 'llm-1',
            answered_original: 'yes',
            answered_original_as_array: ['yes'],
            detail_updated_at: '2026-01-03T00:00:00.000Z',
            explanation: 'because',
            judgment_model_id: 'model-1',
            quotes: [],
          },
          {
            article_id: 'article-1',
            prompt_id: 'prompt-2',
            judgment_id: null,
            answered_original: null,
            answered_original_as_array: [],
            placeholder_kind: 'llm.unanswered',
          },
        ] as T[]
      }

      return [{availability: 'ready', count_value: 1}] as T[]
    },
  }

  return {database, statements}
}

const expectUnavailableSnapshotRejection = async (promise: Promise<unknown>) => {
  await promise.then(
    () => {
      throw new Error('Expected unavailable snapshot rejection')
    },
    (error) => {
      expect(error).toEqual(expect.objectContaining({message: 'Review serving snapshot is unavailable'}))
    },
  )
}

const createChunkedHydrationReaderDatabase = (articleCount: number, enabledPromptCount?: number) => {
  const statements: string[] = []
  const articleIds = Array.from({length: articleCount}, (_, index) => {
    return `article-${String(index + 1).padStart(3, '0')}`
  })
  const database: ReviewServingReaderDatabase = {
    queryJson: async <T>(statement: string, _workloadContext?: DuckdbWorkloadContext): Promise<T[]> => {
      statements.push(statement)

      if (statement.includes(' AS totalCount')) {
        return [{totalCount: articleCount}] as T[]
      }

      if (statement.includes('SELECT COUNT(*)::INTEGER AS promptCount')) {
        return [{promptCount: enabledPromptCount ?? 1}] as T[]
      }

      if (hasArticleServingRowSource(statement)) {
        return articleIds.map((articleId) => {
          return {article_id: articleId, article_title: articleId, sort_key: '2026-01-01T00:00:00.000Z'}
        }) as T[]
      }

      if (statement.includes('FROM mart.review_article_judgment_detail_serving_v4')) {
        return [] as T[]
      }

      return [{availability: 'ready', count_value: articleCount}] as T[]
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

  const [firstRow] = result.data as Array<{
    articleCreatedAt: Date | null
    judgments: {answer: string | null}[]
    sourceMetadata: unknown
  }>

  expect(firstRow?.judgments[0]?.answer).toBe('yes')
  expect(firstRow?.articleCreatedAt).toBeNull()
  expect(firstRow?.sourceMetadata).toEqual({covidence: {studyId: 'study-1'}})
  expect(reader.statements).toHaveLength(13)
  expect(sql).toContain('DELETE FROM mart.review_article_filter_posting_serving_v4')
  expect(sql).toContain('INSERT INTO mart.review_article_filter_posting_serving_v4')
  expect(sql).toContain('FROM mart.review_article_serving_base_v4 serving')
  expect(sql).toContain('INNER JOIN mart.review_article_serving_list_mode_state_v4 list_mode_state')
  expect(sql).toContain('list_mode_state.has_human_list_mode IS TRUE')
  expect(sql).toContain('FROM mart.review_article_judgment_detail_serving_v4')
  expect(sql).toContain('LEFT JOIN app.article article')
  expect(sql).toContain('LEFT JOIN app.article_import_route_source_record selected_source')
  expect(sql).toContain('json_merge_patch')
  expect(sql).toContain("payload_kind = 'human'")
  expect(sql).toContain('SELECT COUNT(DISTINCT filtered_article_ids.article_id) AS totalCount')
  expect(sql).toContain('posting_filtered_article_ids AS')
  expect(sql).toContain("posting.filter_value IN (SELECT unnest(['human:promptAnswer:prompt-1:yes']::VARCHAR[]))")
  expect(sql).not.toContain('state_filtered_article_ids AS')
  expect(sql).toContain('list_mode_state.duplicate_flag IS TRUE')
  expect(sql).toContain('list_mode_state.conflict_flag IS TRUE')
  expect(sql).toContain("list_mode_state.human_status IN (SELECT unnest(['answered']::VARCHAR[]))")
  expect(sql).not.toContain('serving.duplicate_flag = TRUE')
  expect(sql).not.toContain('serving.conflict_flag = TRUE')
  expect(sql).not.toContain('serving.human_status_key =')
  expect(sql).toContain("article_id IN (SELECT unnest(['article-1']::VARCHAR[]))")
  forbiddenSqlFragments.forEach((fragment) => {
    expect(sql).not.toContain(fragment)
  })
})

test('human review prompt-filtered count intersects through one posting CTE with human prompt answer prefix', async () => {
  const reader = createReaderDatabase()

  await getHumanReviewArticlesFromServing(
    {projectId: 'project-1', page: 1, limit: 100, prompts: {'prompt-1': ['yes', 'maybe']}},
    {
      currentReviewConfigHash: 'config-1',
      database: reader.database,
      manifestDatabase: createManifestDatabase('active'),
    },
  )
  const countStatement = reader.statements.find((statement) => {
    return statement.includes('SELECT COUNT(DISTINCT filtered_article_ids.article_id) AS totalCount')
  })

  expect(countStatement).toContain('posting_filtered_article_ids AS')
  expect(countStatement).toContain('FROM mart.review_article_filter_posting_serving_v4 posting')
  expect(countStatement).toContain("posting.filter_kind = 'promptAnswer'")
  expect(countStatement).toContain(
    "posting.filter_value IN (SELECT unnest(['human:promptAnswer:prompt-1:maybe', 'human:promptAnswer:prompt-1:yes']::VARCHAR[]))",
  )
  expect(countStatement).not.toContain('state_filtered_article_ids AS')
  expect(countStatement).toContain('FROM mart.review_article_serving_base_v4 serving')
  expect(countStatement).toContain('INNER JOIN mart.review_article_serving_list_mode_state_v4 list_mode_state')
  expect(countStatement).toContain("WHEN 'human' THEN list_mode_state.has_human_list_mode")
  expect(countStatement).toContain("list_mode_state.human_status IN (SELECT unnest(['answered']::VARCHAR[]))")
  expect(countStatement).not.toContain("serving.human_status_key = 'answered'")
})

test('human and both unfiltered tab counts stay scoped to served base rows', async () => {
  const humanReader = createReaderDatabase()
  const bothReader = createReaderDatabase()

  await getHumanReviewArticlesFromServing(
    {projectId: 'project-1', page: 1, limit: 100, prompts: {}},
    {
      currentReviewConfigHash: 'config-1',
      database: humanReader.database,
      manifestDatabase: createManifestDatabase('active'),
    },
  )
  await getBothReviewArticlesFromServing(
    {projectId: 'project-1', page: 1, limit: 100, prompts: {}},
    {
      currentReviewConfigHash: 'config-1',
      database: bothReader.database,
      manifestDatabase: createManifestDatabase('active'),
    },
  )
  const humanCountStatement = humanReader.statements.find((statement) => {
    return statement.includes('SELECT COUNT(DISTINCT serving.article_id) AS totalCount')
  })
  const bothCountStatement = bothReader.statements.find((statement) => {
    return statement.includes('SELECT COUNT(DISTINCT serving.article_id) AS totalCount')
  })

  for (const statement of [humanCountStatement, bothCountStatement]) {
    expect(statement).toContain('FROM mart.review_article_serving_base_v4 serving')
    expect(statement).toContain('INNER JOIN mart.review_article_serving_list_mode_state_v4 list_mode_state')
    expect(statement).toContain('list_mode_state.article_id = serving.article_id')
    expect(statement).not.toContain(
      'FROM mart.review_article_serving_list_mode_state_v4 list_mode_state\n    CROSS JOIN scoped',
    )
  }
  expect(humanCountStatement).toContain("list_mode_state.human_status IN (SELECT unnest(['answered']::VARCHAR[]))")
  expect(bothCountStatement).toContain("list_mode_state.llm_status IN (SELECT unnest(['answered']::VARCHAR[]))")
  expect(bothCountStatement).toContain("list_mode_state.human_status IN (SELECT unnest(['answered']::VARCHAR[]))")
})

test('Human, Both, and Unassessed default routes stay foreground-readable without search or payload enrichment', async () => {
  const humanReader = createReaderDatabase()
  const bothReader = createReaderDatabase()
  const unassessedReader = createReaderDatabase()
  const manifestDatabase = createManifestDatabase('active', defaultReadableComponents)

  const [humanResult, bothResult, unassessedResult] = await Promise.all([
    getHumanReviewArticlesFromServing(
      {projectId: 'project-1', page: 1, limit: 25, prompts: {}},
      {currentReviewConfigHash: 'config-1', database: humanReader.database, manifestDatabase},
    ),
    getBothReviewArticlesFromServing(
      {projectId: 'project-1', page: 1, limit: 25, prompts: {}},
      {currentReviewConfigHash: 'config-1', database: bothReader.database, manifestDatabase},
    ),
    getUnassessedReviewArticlesFromServing(
      {projectId: 'project-1', page: 1, limit: 25, prompts: {}},
      {currentReviewConfigHash: 'config-1', database: unassessedReader.database, manifestDatabase},
    ),
  ])
  const sql = [...humanReader.statements, ...bothReader.statements, ...unassessedReader.statements].join('\n')

  expect(humanResult.data).toHaveLength(1)
  expect(bothResult.data).toHaveLength(1)
  expect(unassessedResult.data).toHaveLength(1)
  expect(sql).toContain('FROM mart.review_article_serving_base_v4 serving')
  expect(sql).toContain('FROM mart.review_unassessed_queue_article_rank_serving_v4 queue')
  expect(sql).toContain('FROM mart.review_article_judgment_detail_serving_v4')
  expect(sql).not.toContain('mart.review_title_search_serving_v4')
  expect(sql).not.toContain('search_identity')
  expect(sql).not.toContain('lazy-detail-hydration')
  expect(sql).not.toContain('model_id AS modelId')
})

test('human review route service retries transient filtered count read failures', async () => {
  const reader = createReaderDatabase()
  let countAttempts = 0
  const countStatements: string[] = []
  const database: ReviewServingReaderDatabase = {
    queryJson: async <T>(statement: string, workloadContext?: DuckdbWorkloadContext): Promise<T[]> => {
      if (statement.includes(' AS totalCount')) {
        countAttempts += 1
        countStatements.push(statement)

        if (countAttempts === 1) {
          throw new Error('An unknown error occurred in Effect.tryPromise')
        }

        return [{totalCount: 1}] as T[]
      }

      return reader.database.queryJson<T>(statement, workloadContext)
    },
  }

  const result = await getHumanReviewArticlesFromServing(
    {projectId: 'project-1', page: 1, limit: 100, hasDuplicateStudyRecords: true, prompts: {}},
    {currentReviewConfigHash: 'config-1', database, manifestDatabase: createManifestDatabase('active')},
  )

  expect(result.totalCount).toBe(1)
  expect(countAttempts).toBe(2)
  expect(countStatements.join('\n')).toContain(' AS totalCount')
})

test('human review route service retries transient filtered row read failures', async () => {
  const reader = createReaderDatabase()
  let rowAttempts = 0
  const rowStatements: string[] = []
  const database: ReviewServingReaderDatabase = {
    queryJson: async <T>(statement: string, workloadContext?: DuckdbWorkloadContext): Promise<T[]> => {
      if (
        statement.includes('FROM mart.review_article_serving_base_v4 serving')
        && statement.includes('list_mode_state.duplicate_flag IS TRUE')
        && !statement.includes('COUNT(DISTINCT')
      ) {
        rowAttempts += 1
        rowStatements.push(statement)

        if (rowAttempts === 1) {
          throw new Error('An unknown error occurred in Effect.tryPromise')
        }
      }

      return reader.database.queryJson<T>(statement, workloadContext)
    },
  }

  const result = await getHumanReviewArticlesFromServing(
    {projectId: 'project-1', page: 1, limit: 100, hasDuplicateStudyRecords: true, prompts: {}},
    {currentReviewConfigHash: 'config-1', database, manifestDatabase: createManifestDatabase('active')},
  )

  expect(result.data).toHaveLength(1)
  expect(rowAttempts).toBe(2)
  expect(rowStatements.join('\n')).toContain('list_mode_state.duplicate_flag IS TRUE')
  expect(rowStatements.join('\n')).not.toContain("filter_0.filter_kind = 'duplicateFlag'")
})

test('human review route service allows the 500-row page cursor probe within the reader contract', async () => {
  const reader = createChunkedHydrationReaderDatabase(501)

  await getHumanReviewArticlesFromServing(
    {projectId: 'project-1', page: 1, limit: 500, prompts: {}},
    {
      currentReviewConfigHash: 'config-1',
      database: reader.database,
      manifestDatabase: createManifestDatabase('active'),
    },
  )

  expect(
    reader.statements.find((statement) => {
      return statement.includes('FROM mart.review_article_serving_base_v4 serving')
    }),
  ).toContain('LIMIT 501')
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
  expect(result.data[0]?.judgments).toHaveLength(1)
  expect(result.data[0]?.humanAnswersByPrompt?.['prompt-1']).toEqual(['yes'])
  expect(reader.statements).toHaveLength(14)
  expect(sql).toContain('DELETE FROM mart.review_article_filter_posting_serving_v4')
  expect(sql).toContain('INSERT INTO mart.review_article_filter_posting_serving_v4')
  expect(sql.match(/article_id IN \(SELECT unnest\(\['article-1'\]::VARCHAR\[\]\)\)/gu)?.length).toBe(2)
  expect(sql).toContain('list_mode_state.has_both_list_mode IS TRUE')
  expect(sql).toContain("llm_status IN (SELECT unnest(['answered']::VARCHAR[]))")
  expect(sql).toContain("human_status IN (SELECT unnest(['answered']::VARCHAR[]))")
  expect(sql).not.toContain('serving.llm_status_key =')
  expect(sql).not.toContain('serving.human_status_key =')
  expect(sql).toContain("payload_kind = 'llm'")
  expect(sql).toContain("payload_kind = 'human'")
  forbiddenSqlFragments.forEach((fragment) => {
    expect(sql).not.toContain(fragment)
  })
})

test('both review route service chunks judgment hydration at reader article-set bounds', async () => {
  const reader = createChunkedHydrationReaderDatabase(250, 100)

  await getBothReviewArticlesFromServing(
    {projectId: 'project-1', page: 1, limit: 250, prompts: {}},
    {
      currentReviewConfigHash: 'config-1',
      database: reader.database,
      manifestDatabase: createManifestDatabase('active'),
    },
  )

  const judgmentStatements = reader.statements.filter((statement) => {
    return statement.includes('FROM mart.review_article_judgment_detail_serving_v4')
  })

  expect(judgmentStatements).toHaveLength(6)
  expect(judgmentStatements[0]).toContain('article-100')
  expect(judgmentStatements[0]).not.toContain('article-101')
  expect(judgmentStatements[1]).toContain('article-200')
  expect(judgmentStatements[1]).not.toContain('article-201')
  expect(judgmentStatements[2]).toContain('article-250')
})

test('both review route service sizes judgment hydration from bounded enabled prompt metadata', async () => {
  const reader = createChunkedHydrationReaderDatabase(45, 250)

  await getBothReviewArticlesFromServing(
    {projectId: 'project-1', page: 1, limit: 45, prompts: {}},
    {
      currentReviewConfigHash: 'config-1',
      database: reader.database,
      manifestDatabase: createManifestDatabase('active'),
    },
  )

  const judgmentStatements = reader.statements.filter((statement) => {
    return statement.includes('FROM mart.review_article_judgment_detail_serving_v4')
  })

  expect(judgmentStatements).toHaveLength(4)
  expect(judgmentStatements[0]).toContain('LIMIT 10000')
  expect(judgmentStatements[0]).toContain('article-040')
  expect(judgmentStatements[0]).not.toContain('article-041')
  expect(judgmentStatements[1]).toContain('LIMIT 1250')
  expect(judgmentStatements[1]).toContain('article-045')
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
  const servingStatement = reader.statements.find((statement) => {
    return statement.includes('unassessed_queue_page AS')
  })
  const countStatement = reader.statements.find((statement) => {
    return statement.includes('SELECT COUNT(DISTINCT filtered_article_ids.article_id) AS totalCount')
  })

  expect(reader.statements).toHaveLength(7)
  expect(servingStatement).toContain('unassessed_queue_page AS')
  expect(servingStatement).toContain('FROM mart.review_unassessed_queue_article_rank_serving_v4 queue')
  expect(servingStatement).toContain('FROM unassessed_queue_page')
  expect(servingStatement).toContain('INNER JOIN mart.review_article_serving_list_mode_state_v4 list_mode_state')
  expect(servingStatement).toContain('list_mode_state.has_unassessed_list_mode IS TRUE')
  expect(servingStatement).toContain('unassessed_queue_candidate AS (SELECT')
  expect(servingStatement).toContain('queue.activity_sort_at')
  expect(servingStatement).not.toContain('MAX(queue.activity_sort_at) AS activity_sort_at')
  expect(servingStatement).toContain(
    'ORDER BY unassessed_queue_candidate.activity_sort_at DESC, unassessed_queue_candidate.article_id DESC LIMIT 26',
  )
  expect(servingStatement).toContain("unnest(['heart']::VARCHAR[])")
  expect(servingStatement).toContain('starts_with(search.token, search_prefix.token_prefix)')
  expect(countStatement).toContain('SELECT COUNT(DISTINCT filtered_article_ids.article_id) AS totalCount')
  expect(countStatement).toContain("'unassessed' AS list_mode_key")
  expect(countStatement).toContain("WHEN 'unassessed' THEN list_mode_state.has_unassessed_list_mode")
  expect(countStatement).toContain('unassessed_queue_article_ids AS')
  expect(countStatement).toContain('FROM mart.review_unassessed_queue_article_rank_serving_v4 queue')
  expect(countStatement).toContain("queue.queue_kind = 'unassessed'")
  expect(countStatement).toContain('search_filtered_article_ids AS')
  expect(countStatement).toContain('starts_with(search.token, search_prefix.token_prefix)')
  forbiddenSqlFragments.forEach((fragment) => {
    expect(sql).not.toContain(fragment)
  })
})

test('human, both, and unassessed routes read one cursor page for numeric direct page jumps', async () => {
  const humanReader = createReaderDatabase()
  const humanResult = await getHumanReviewArticlesFromServing(
    {projectId: 'project-1', page: 99, limit: 25, prompts: {}},
    {
      currentReviewConfigHash: 'config-1',
      database: humanReader.database,
      manifestDatabase: createManifestDatabase('active'),
    },
  )
  const bothReader = createReaderDatabase()
  const bothResult = await getBothReviewArticlesFromServing(
    {projectId: 'project-1', page: 99, limit: 25, prompts: {}},
    {
      currentReviewConfigHash: 'config-1',
      database: bothReader.database,
      manifestDatabase: createManifestDatabase('active'),
    },
  )
  const unassessedReader = createReaderDatabase()
  const unassessedResult = await getUnassessedReviewArticlesFromServing(
    {projectId: 'project-1', page: 99, limit: 25, prompts: {}},
    {
      currentReviewConfigHash: 'config-1',
      database: unassessedReader.database,
      manifestDatabase: createManifestDatabase('active'),
    },
  )

  expect(humanResult.page).toBe(1)
  expect(bothResult.page).toBe(1)
  expect(unassessedResult.page).toBe(1)
  expect(humanReader.statements).toHaveLength(9)
  expect(bothReader.statements).toHaveLength(10)
  expect(unassessedReader.statements).toHaveLength(7)
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
  expect(staleReader.statements.join('\n')).toContain('FROM mart.review_unassessed_queue_article_rank_serving_v4')

  const humanReader = createReaderDatabase()
  const bothReader = createReaderDatabase()
  const unassessedReader = createReaderDatabase()

  await expectUnavailableSnapshotRejection(
    getHumanReviewArticlesFromServing(
      {projectId: 'project-1', page: 1, limit: 25, prompts: {}},
      {
        currentReviewConfigHash: 'config-1',
        database: humanReader.database,
        manifestDatabase: createManifestDatabase('candidate'),
      },
    ),
  )
  await expectUnavailableSnapshotRejection(
    getBothReviewArticlesFromServing(
      {projectId: 'project-1', page: 1, limit: 25, prompts: {}},
      {
        currentReviewConfigHash: 'config-1',
        database: bothReader.database,
        manifestDatabase: createManifestDatabase('missing'),
      },
    ),
  )
  await expectUnavailableSnapshotRejection(
    getUnassessedReviewArticlesFromServing(
      {projectId: 'project-1', page: 1, limit: 25, prompts: {}},
      {
        currentReviewConfigHash: 'config-1',
        database: unassessedReader.database,
        manifestDatabase: createManifestDatabase('missing'),
      },
    ),
  )
  expect(humanReader.statements.join('\n')).not.toContain('FROM mart.review_article_serving_v4')
  expect(bothReader.statements.join('\n')).not.toContain('FROM mart.review_article_serving_v4')
  expect(unassessedReader.statements.join('\n')).not.toContain('FROM mart.review_article_serving_v4')
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
