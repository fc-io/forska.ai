import {readFile} from 'node:fs/promises'

import {expect, test} from 'bun:test'

import type {DuckdbWorkloadContext} from '../utils/duckdbService.ts'
import {
  namedReviewFastCountDefinitions,
  type ReviewServingProjectionComponent,
  type ReviewServingSnapshotStatus,
} from './reviewServingContracts.ts'
import {
  getBothReviewArticlesFromServing,
  getHumanReviewArticlesFromServing,
  getUnassessedReviewArticlesFromServing,
} from './reviewServingHumanBothUnassessedRouteService.ts'
import {countLlmReviewArticlesFromServing} from './reviewServingLlmReviewRouteService.ts'
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

const createReaderDatabase = (input?: {
  humanRows?: readonly Record<string, unknown>[]
  llmRows?: readonly Record<string, unknown>[]
  projectHumanJudgmentMode?: 'prompt' | 'summary'
  promptCount?: number
  rowCount?: number
}) => {
  const statements: string[] = []
  const database: ReviewServingReaderDatabase = {
    queryJson: async <T>(statement: string, _workloadContext?: DuckdbWorkloadContext): Promise<T[]> => {
      statements.push(statement)

      if (statement.includes('FROM app.project')) {
        return [{humanJudgmentMode: input?.projectHumanJudgmentMode ?? 'prompt'}] as T[]
      }

      if (statement.includes('SELECT COUNT(*)::INTEGER AS promptCount')) {
        return [{promptCount: input?.promptCount ?? 1}] as T[]
      }

      if (statement.includes(' AS totalCount')) {
        return [{totalCount: input?.rowCount ?? 1}] as T[]
      }

      if (statement.includes('FROM mart.review_unassessed_queue_article_rank_serving_v4')) {
        return [{activity_sort_at: '2026-01-04T00:00:00.000Z', article_id: 'article-1', priority_bucket: 1}] as T[]
      }

      if (hasArticleServingRowSource(statement)) {
        if (input?.rowCount === 0) {
          return [] as T[]
        }

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
        return (input?.humanRows ?? [
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
        ]) as T[]
      }

      if (statement.includes('FROM mart.review_article_judgment_detail_serving_v4')) {
        return (input?.llmRows ?? [
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
        ]) as T[]
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

type ReviewTabCountFixtureArticle = {
  archived?: boolean
  hasCompleteLlmJudgment?: boolean
  hasHumanJudgment?: boolean
  hasLlmJudgment?: boolean
  id: string
  projectActive?: boolean
  projectArchived?: boolean
  projectId?: string
}
type ReviewTabCountListMode = 'both' | 'human' | 'llm' | 'unassessed'

const reviewTabCountProjectId = 'project-1'
const reviewTabCountConfigHash = 'config-1'
const reviewTabCountSnapshotId = 'active-snapshot'
const reviewTabCountListModes = ['llm', 'human', 'both', 'unassessed'] as const
const reviewTabCountFixtureArticles: readonly ReviewTabCountFixtureArticle[] = [
  {hasCompleteLlmJudgment: true, hasHumanJudgment: true, hasLlmJudgment: true, id: 'article-both-1'},
  {hasCompleteLlmJudgment: true, hasHumanJudgment: true, hasLlmJudgment: true, id: 'article-both-2'},
  {hasCompleteLlmJudgment: true, hasLlmJudgment: true, id: 'article-llm-only'},
  {hasLlmJudgment: true, id: 'article-partial-llm'},
  {hasHumanJudgment: true, id: 'article-human-only'},
  {id: 'article-unassessed-1'},
  {id: 'article-unassessed-2'},
  {archived: true, hasCompleteLlmJudgment: true, hasHumanJudgment: true, hasLlmJudgment: true, id: 'article-archived'},
  {
    hasCompleteLlmJudgment: true,
    hasHumanJudgment: true,
    hasLlmJudgment: true,
    id: 'article-other-project',
    projectId: 'project-2',
  },
  {
    hasCompleteLlmJudgment: true,
    hasHumanJudgment: true,
    hasLlmJudgment: true,
    id: 'article-inactive-project',
    projectActive: false,
  },
  {
    hasCompleteLlmJudgment: true,
    hasHumanJudgment: true,
    hasLlmJudgment: true,
    id: 'article-archived-project',
    projectArchived: true,
  },
]

const isActiveSourceProjectReviewArticle = (article: ReviewTabCountFixtureArticle) => {
  return (
    (article.projectId ?? reviewTabCountProjectId) === reviewTabCountProjectId
    && article.archived !== true
    && article.projectActive !== false
    && article.projectArchived !== true
  )
}

const getSourceTruthReviewTabCounts = (articles: readonly ReviewTabCountFixtureArticle[]) => {
  const activeArticles = articles.filter(isActiveSourceProjectReviewArticle)

  return {
    both: activeArticles.filter((article) => {
      return article.hasCompleteLlmJudgment === true && article.hasHumanJudgment === true
    }).length,
    human: activeArticles.filter((article) => {
      return article.hasHumanJudgment === true
    }).length,
    llm: activeArticles.filter((article) => {
      return article.hasLlmJudgment === true
    }).length,
    unassessed: activeArticles.filter((article) => {
      return article.hasCompleteLlmJudgment !== true
    }).length,
  }
}

const getMartListModeFlags = (article: ReviewTabCountFixtureArticle) => {
  const isActiveArticle = isActiveSourceProjectReviewArticle(article)
  const hasLlm = isActiveArticle && article.hasLlmJudgment === true
  const hasCompleteLlm = isActiveArticle && article.hasCompleteLlmJudgment === true
  const hasHuman = isActiveArticle && article.hasHumanJudgment === true

  return {
    both: hasCompleteLlm && hasHuman,
    human: hasHuman,
    llm: hasLlm,
    unassessed: isActiveArticle && !hasCompleteLlm,
  }
}

const getReviewTabCountRows = (articles: readonly ReviewTabCountFixtureArticle[]) => {
  const sourceTruth = getSourceTruthReviewTabCounts(articles)

  return reviewTabCountListModes.map((listMode) => {
    const countKind = listMode === 'unassessed' ? 'review.queue.unassessedReady' : 'review.list.total'
    const definition = namedReviewFastCountDefinitions[countKind]

    return {
      availability: 'ready',
      count_kind: countKind,
      count_value: sourceTruth[listMode],
      filter_key: listMode === 'unassessed' ? 'queue:ready' : 'list:all',
      list_mode_key: listMode,
      project_id: reviewTabCountProjectId,
      review_config_hash: reviewTabCountConfigHash,
      snapshot_id: reviewTabCountSnapshotId,
      summary_definition_version: definition.summaryDefinitionVersion,
    }
  })
}

const getRowsForListMode = (articles: readonly ReviewTabCountFixtureArticle[], listMode: ReviewTabCountListMode) => {
  return articles
    .filter((article) => {
      return getMartListModeFlags(article)[listMode]
    })
    .map((article, index) => {
      return {
        activity_sort_at: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
        article_id: article.id,
        article_title: article.id,
        sort_key: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
      }
    })
}

const getListModeFromStatement = (statement: string): ReviewTabCountListMode | null => {
  const match = statement.match(/list_mode_key\s*=\s*'([^']+)'/u) ?? statement.match(/'([^']+)'\s+AS list_mode_key/u)
  const value = match?.[1]

  if (value === 'llm' || value === 'human' || value === 'both' || value === 'unassessed') {
    return value
  }

  if (statement.includes("WHEN 'unassessed' THEN list_mode_state.has_unassessed_list_mode")) {
    return 'unassessed'
  }

  if (statement.includes("WHEN 'both' THEN list_mode_state.has_both_list_mode")) {
    return 'both'
  }

  if (statement.includes("WHEN 'human' THEN list_mode_state.has_human_list_mode")) {
    return 'human'
  }

  if (statement.includes("WHEN 'llm' THEN list_mode_state.has_llm_list_mode")) {
    return 'llm'
  }

  return null
}

const createReviewTabCountDatabase = (articles: readonly ReviewTabCountFixtureArticle[]) => {
  const statements: string[] = []
  const sourceTruth = getSourceTruthReviewTabCounts(articles)
  const countRows = getReviewTabCountRows(articles)
  const database: ReviewServingReaderDatabase & {run: (statement: string) => Promise<void>} = {
    queryJson: async <T>(statement: string): Promise<T[]> => {
      statements.push(statement)

      if (statement.includes('FROM app.project')) {
        return [{dateFrom: null, dateTo: null}] as T[]
      }

      if (statement.includes('SELECT COUNT(*)::INTEGER AS promptCount')) {
        return [{promptCount: 1}] as T[]
      }

      if (statement.includes('FROM source_review_truth')) {
        return [sourceTruth] as T[]
      }

      if (statement.includes('SELECT COUNT(DISTINCT filtered_article_ids.article_id) AS totalCount')) {
        const listMode = getListModeFromStatement(statement) ?? 'llm'

        return [{totalCount: sourceTruth[listMode]}] as T[]
      }

      if (statement.includes('SELECT COUNT(DISTINCT serving.article_id) AS totalCount')) {
        const listMode = getListModeFromStatement(statement) ?? 'llm'

        return [{totalCount: sourceTruth[listMode]}] as T[]
      }

      if (statement.includes('SELECT COUNT(DISTINCT queue.article_id) AS totalCount')) {
        return [{totalCount: sourceTruth.unassessed}] as T[]
      }

      if (statement.includes('FROM mart.review_article_count_serving_v4')) {
        const row = countRows.find((candidate) => {
          return (
            statement.includes(`list_mode_key = '${candidate.list_mode_key}'`)
            && statement.includes(`count_kind = '${candidate.count_kind}'`)
            && statement.includes(`filter_key = '${candidate.filter_key}'`)
            && statement.includes(`summary_definition_version = '${candidate.summary_definition_version}'`)
          )
        })

        return (row ? [row] : []) as T[]
      }

      if (statement.includes('FROM mart.review_unassessed_queue_article_rank_serving_v4')) {
        return getRowsForListMode(articles, 'unassessed') as T[]
      }

      if (statement.includes('FROM mart.review_article_serving_base_v4 serving')) {
        const listMode = getListModeFromStatement(statement)

        return getRowsForListMode(articles, listMode ?? 'llm') as T[]
      }

      if (statement.includes('FROM mart.review_article_judgment_detail_serving_v4')) {
        return [] as T[]
      }

      return [] as T[]
    },
    run: async (statement: string): Promise<void> => {
      statements.push(statement)
    },
  }

  return {database, sourceTruth, statements}
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

test('project review tab counts match active non-archived source judgment truth', async () => {
  const fixture = createReviewTabCountDatabase(reviewTabCountFixtureArticles)
  const dependencies = {
    currentReviewConfigHash: reviewTabCountConfigHash,
    database: fixture.database,
    manifestDatabase: createManifestDatabase('active'),
  }
  const [sourceTruth] = await fixture.database.queryJson<Record<ReviewTabCountListMode, number>>(`
    WITH source_review_truth AS (
      SELECT 'ordinary source DB truth for active non-archived project review counts' AS contract
    )
    SELECT * FROM source_review_truth
  `)

  const [llmCount, humanResult, bothResult, unassessedResult] = await Promise.all([
    countLlmReviewArticlesFromServing(
      {projectId: reviewTabCountProjectId, page: 1, limit: 100, prompts: {}},
      dependencies,
    ),
    getHumanReviewArticlesFromServing(
      {projectId: reviewTabCountProjectId, page: 1, limit: 100, prompts: {}},
      dependencies,
    ),
    getBothReviewArticlesFromServing(
      {projectId: reviewTabCountProjectId, page: 1, limit: 100, prompts: {}},
      dependencies,
    ),
    getUnassessedReviewArticlesFromServing(
      {projectId: reviewTabCountProjectId, page: 1, limit: 100, prompts: {}},
      dependencies,
    ),
  ])
  const sql = fixture.statements.join('\n')

  expect(sourceTruth).toEqual({both: 2, human: 3, llm: 4, unassessed: 4})
  expect({
    both: bothResult.totalCount,
    human: humanResult.totalCount,
    llm: llmCount.totalCount,
    unassessed: unassessedResult.totalCount,
  }).toEqual(sourceTruth)
  expect({
    both: bothResult.data.length,
    human: humanResult.data.length,
    unassessed: unassessedResult.data.length,
  }).toEqual({both: sourceTruth.both, human: sourceTruth.human, unassessed: sourceTruth.unassessed})
  expect(sql).toContain('FROM mart.review_article_serving_base_v4 serving')
  expect(sql).toContain('FROM mart.review_unassessed_queue_article_rank_serving_v4')
  expect(sql).toContain('list_mode_state.has_llm_list_mode')
  expect(sql).toContain('list_mode_state.has_human_list_mode')
  expect(sql).toContain('list_mode_state.has_both_list_mode')
  expect(sql).toContain('list_mode_state.has_unassessed_list_mode')
})

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
  expect(reader.statements).toHaveLength(12)
  expect(sql).toContain('SELECT requested.filter_value AS filterValue')
  expect(sql).not.toContain('DELETE FROM mart.review_article_filter_posting_serving_v4')
  expect(sql).not.toContain('INSERT INTO mart.review_article_filter_posting_serving_v4')
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

test('human review route service reports summary project mode even while the summary page is empty', async () => {
  const reader = createReaderDatabase({projectHumanJudgmentMode: 'summary', rowCount: 0})
  const result = await getHumanReviewArticlesFromServing(
    {projectId: 'project-1', page: 1, limit: 100, prompts: {}},
    {
      currentReviewConfigHash: 'config-1',
      database: reader.database,
      manifestDatabase: createManifestDatabase('active'),
    },
  )
  const sql = reader.statements.join('\n')

  expect(result).toEqual({
    data: [],
    detailReadiness: 'ready',
    humanJudgmentMode: 'summary',
    limit: 100,
    nextCursor: null,
    page: 1,
    totalCount: 0,
    totalPages: 0,
  })
  expect(sql).toContain('SELECT human_judgment_mode AS humanJudgmentMode')
  expect(sql).toContain('FROM app.project')
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

test('human review prompt-filtered count falls back to canonical prompt answers when publication fails', async () => {
  const reader = createReaderDatabase()
  const database = {
    ...reader.database,
    queryJson: async <T>(statement: string, workloadContext?: DuckdbWorkloadContext): Promise<T[]> => {
      if (/\binsert\s+into\s+mart\.review_article_filter_posting_serving_v4\b/iu.test(statement)) {
        reader.statements.push(statement)
        throw new Error('publication failed')
      }

      if (statement.includes('SELECT requested.filter_value AS filterValue')) {
        reader.statements.push(statement)

        return [{filterValue: 'human:promptAnswer:prompt-1:yes'}] as T[]
      }

      return reader.database.queryJson<T>(statement, workloadContext)
    },
    run: async (statement: string) => {
      reader.statements.push(statement)
      if (/\binsert\s+into\s+mart\.review_article_filter_posting_serving_v4\b/iu.test(statement)) {
        throw new Error('publication failed')
      }
    },
  }

  await getHumanReviewArticlesFromServing(
    {projectId: 'project-1', page: 1, limit: 100, prompts: {'prompt-1': ['yes']}},
    {currentReviewConfigHash: 'config-1', database, manifestDatabase: createManifestDatabase('active')},
  )
  const countStatement = reader.statements.find((statement) => {
    return statement.includes('SELECT COUNT(DISTINCT filtered_article_ids.article_id) AS totalCount')
  })

  expect(reader.statements.join('\n')).toContain('ROLLBACK')
  expect(countStatement).toContain('canonical_prompt_answer_posting_rows AS')
  expect(countStatement).toContain('posting_filter_rows AS')
  expect(countStatement).toContain('FROM app."judgment_human" judgment_human')
  expect(countStatement).toContain('human:promptAnswer:prompt-1:yes')
  expect(countStatement).toContain('FROM posting_filter_rows posting')
})

test('both review prompt-filtered count fallback keeps LLM prompt-answer semantics', async () => {
  const reader = createReaderDatabase()
  const database = {
    ...reader.database,
    queryJson: async <T>(statement: string, workloadContext?: DuckdbWorkloadContext): Promise<T[]> => {
      if (/\binsert\s+into\s+mart\.review_article_filter_posting_serving_v4\b/iu.test(statement)) {
        reader.statements.push(statement)
        throw new Error('publication failed')
      }

      if (statement.includes('SELECT requested.filter_value AS filterValue')) {
        reader.statements.push(statement)

        return [{filterValue: 'review:promptAnswer:prompt-1:yes'}] as T[]
      }

      return reader.database.queryJson<T>(statement, workloadContext)
    },
    run: async (statement: string) => {
      reader.statements.push(statement)
      if (/\binsert\s+into\s+mart\.review_article_filter_posting_serving_v4\b/iu.test(statement)) {
        throw new Error('publication failed')
      }
    },
  }

  await getBothReviewArticlesFromServing(
    {
      projectId: 'project-1',
      page: 1,
      limit: 100,
      prompts: {'human:promptAnswer:summary': ['yes'], 'prompt-1': ['yes'], 'review:promptAnswer:summary': ['maybe']},
    },
    {currentReviewConfigHash: 'config-1', database, manifestDatabase: createManifestDatabase('active')},
  )
  const countStatement = reader.statements.find((statement) => {
    return statement.includes('SELECT COUNT(DISTINCT filtered_article_ids.article_id) AS totalCount')
  })

  expect(reader.statements.join('\n')).toContain('ROLLBACK')
  expect(countStatement).toContain('canonical_prompt_answer_posting_rows AS')
  expect(countStatement).toContain('review:promptAnswer:prompt-1:yes')
  expect(countStatement).toContain('review:promptAnswer:summary:maybe')
  expect(countStatement).toContain('human:promptAnswer:summary:yes')
  expect(countStatement).not.toContain('human:promptAnswer:prompt-1:yes')
})

test('human and both unfiltered tab counts require answered human rows', async () => {
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

  expect(humanCountStatement).toContain('FROM mart.review_article_serving_base_v4 serving')
  expect(humanCountStatement).toContain('INNER JOIN mart.review_article_serving_list_mode_state_v4 list_mode_state')
  expect(humanCountStatement).toContain("WHEN 'human' THEN list_mode_state.has_human_list_mode")
  expect(humanCountStatement).toContain("list_mode_state.human_status IN (SELECT unnest(['answered']::VARCHAR[]))")

  expect(bothCountStatement).toContain('FROM mart.review_article_serving_base_v4 serving')
  expect(bothCountStatement).toContain('INNER JOIN mart.review_article_serving_list_mode_state_v4 list_mode_state')
  expect(bothCountStatement).toContain("WHEN 'both' THEN list_mode_state.has_both_list_mode")
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
  expect(humanResult.detailReadiness).toBe('indexing')
  expect(bothResult.detailReadiness).toBe('indexing')
  expect(sql).toContain('FROM mart.review_article_serving_base_v4 serving')
  expect(sql).toContain('FROM mart.review_unassessed_queue_article_rank_serving_v4 queue')
  expect(sql).not.toContain('FROM mart.review_article_judgment_detail_serving_v4')
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
  expect(reader.statements).toHaveLength(13)
  expect(sql).toContain('SELECT requested.filter_value AS filterValue')
  expect(sql).not.toContain('DELETE FROM mart.review_article_filter_posting_serving_v4')
  expect(sql).not.toContain('INSERT INTO mart.review_article_filter_posting_serving_v4')
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

test('both review route service derives displayed LLM summaries with criteria semantics', async () => {
  const reader = createReaderDatabase({
    humanRows: [
      {
        article_id: 'article-1',
        prompt_id: 'summary',
        judgment_id: 'human-summary-1',
        answered_original: 'yes',
        answered_original_as_array: [],
        detail_updated_at: '2026-01-04T00:00:00.000Z',
        judgment_created_at: '2026-01-03T00:00:00.000Z',
      },
    ],
    llmRows: [
      {
        article_id: 'article-1',
        prompt_id: 'include-prompt',
        judgment_id: 'llm-include',
        answered_original: 'yes',
        answered_original_as_array: [' yes '],
        detail_updated_at: '2026-01-03T00:00:00.000Z',
        explanation: 'because',
        judgment_model_id: 'model-1',
        prompt_criteria_disposition: 'include',
        quotes: [],
      },
      {
        article_id: 'article-1',
        prompt_id: 'exclude-prompt',
        judgment_id: 'llm-exclude',
        answered_original: 'no',
        answered_original_as_array: [' no '],
        detail_updated_at: '2026-01-03T00:00:00.000Z',
        explanation: 'because',
        judgment_model_id: 'model-1',
        prompt_criteria_disposition: 'exclude',
        quotes: [],
      },
    ],
    promptCount: 2,
    projectHumanJudgmentMode: 'summary',
  })

  const result = await getBothReviewArticlesFromServing(
    {projectId: 'project-1', page: 1, limit: 50, prompts: {}},
    {
      currentReviewConfigHash: 'config-1',
      database: reader.database,
      manifestDatabase: createManifestDatabase('active'),
    },
  )

  expect(result.data[0]?.humanJudgmentMode).toBe('summary')
  expect(result.data[0]?.llmSummaryAnswer).toBe('yes')
  expect(result.data[0]?.judgments[0]).not.toHaveProperty('criteriaDisposition')
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

test('unassessed review route service counts unfiltered pages from the queue serving rows', async () => {
  const reader = createReaderDatabase()
  const database: ReviewServingReaderDatabase = {
    queryJson: async <T>(statement: string, workloadContext?: DuckdbWorkloadContext): Promise<T[]> => {
      if (statement.includes('FROM mart.review_filtered_count_serving_v4')) {
        return [{countFound: true, countValue: 0}] as T[]
      }

      if (statement.includes('FROM mart.review_article_count_serving_v4')) {
        return [
          {
            availability: 'ready',
            count_value: 0,
            countValue: 0,
            filter_key: 'queue:ready',
            key: 'review.queue.unassessedReady',
          },
        ] as T[]
      }

      return reader.database.queryJson<T>(statement, workloadContext)
    },
  }

  const result = await getUnassessedReviewArticlesFromServing(
    {projectId: 'project-1', page: 1, limit: 25, prompts: {}},
    {currentReviewConfigHash: 'config-1', database, manifestDatabase: createManifestDatabase('active')},
  )
  const sql = reader.statements.join('\n')

  expect(result.data).toHaveLength(1)
  expect(result.totalCount).toBe(1)
  expect(result.totalPages).toBe(1)
  expect(sql).toContain('SELECT COUNT(DISTINCT queue.article_id) AS totalCount')
  expect(sql).toContain('FROM mart.review_unassessed_queue_article_rank_serving_v4 queue')
  expect(sql).toContain('INNER JOIN mart.review_article_serving_base_v4 serving')
  expect(sql).toContain('INNER JOIN mart.review_article_serving_list_mode_state_v4 list_mode_state')
  expect(sql).toContain("queue.queue_kind = 'unassessed'")
  expect(sql).toContain('list_mode_state.has_unassessed_list_mode IS TRUE')
  expect(sql).not.toContain('FROM mart.review_article_count_serving_v4')
  expect(sql).not.toContain('FROM mart.review_filtered_count_serving_v4')
  expect(sql).not.toContain('SELECT COUNT(DISTINCT filtered_article_ids.article_id) AS totalCount')
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
  expect(humanReader.statements).toHaveLength(10)
  expect(bothReader.statements).toHaveLength(11)
  expect(unassessedReader.statements).toHaveLength(3)
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
