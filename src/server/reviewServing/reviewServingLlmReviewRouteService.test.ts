import {readFile} from 'node:fs/promises'

import {expect, test} from 'bun:test'

import type {DuckdbWorkloadContext} from '../utils/duckdbService.ts'
import type {ReviewServingProjectionComponent, ReviewServingSnapshotStatus} from './reviewServingContracts.ts'
import {
  countLlmReviewArticlesFromServing,
  getLlmReviewArticlesFromServing,
} from './reviewServingLlmReviewRouteService.ts'
import type {ReviewServingManifestRepositoryDatabase} from './reviewServingManifestRepository.ts'
import {readReviewServingRows, type ReviewServingReaderDatabase} from './reviewServingReader.ts'

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
    optional: [
      {
        baseGeneration: '1',
        component: 'search' as const,
        patchWatermark: '2',
        projectionIdentity: 'search-identity',
        requirement: 'optional' as const,
      },
    ],
    required: components
      .filter((component) => {
        return component !== 'search'
      })
      .map((component) => {
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

const createArticleRows = (articleCount: number, enabledPromptCount?: number) => {
  return Array.from({length: articleCount}, (_value, index) => {
    const articleNumber = index + 1

    return {
      article_id: `article-${articleNumber}`,
      article_created_at: null,
      article_external_id: `external-${articleNumber}`,
      article_title: `Article ${articleNumber}`,
      article_updated_at: null,
      arxiv_id: `2401.0000${articleNumber}`,
      doi: `10.1000/article-${articleNumber}`,
      ...(enabledPromptCount ? {enabled_prompt_count: enabledPromptCount} : {}),
      full_text_conversion_status: 'converted',
      full_text_fetched_at: '2026-01-04T00:00:00.000Z',
      journal_title: 'Journal',
      llm_status_key: 'answered',
      pmid: `1234${articleNumber}`,
      sort_key: `2026-01-01T00:00:00.${String(index).padStart(3, '0')}Z`,
      source_metadata: JSON.stringify({covidence: {studyId: `study-${articleNumber}`}}),
      activity_sort_at: '2026-01-02T00:00:00.000Z',
      url: `https://example.test/article-${articleNumber}`,
    }
  })
}

const createReaderDatabase = (totalCount = 1, articleCount = 1, enabledPromptCount?: number) => {
  const statements: string[] = []
  const database: ReviewServingReaderDatabase = {
    queryJson: async <T>(statement: string, _workloadContext?: DuckdbWorkloadContext): Promise<T[]> => {
      statements.push(statement)

      if (statement.includes('COUNT(DISTINCT serving.article_id)')) {
        return [{totalCount}] as T[]
      }

      if (statement.includes('FROM app.project')) {
        return [{dateFrom: '2026-01-10T00:00:00.000Z', dateTo: '2026-01-20T00:00:00.000Z'}] as T[]
      }

      if (statement.includes('FROM mart.review_article_serving_v4')) {
        return createArticleRows(articleCount, enabledPromptCount) as T[]
      }

      if (statement.includes('FROM mart.review_article_judgment_detail_serving_v4')) {
        return [
          {
            article_id: 'article-1',
            prompt_id: 'prompt-1',
            model_id: 'model-1',
            judgment_id: 'judgment-1',
            answered_original: 'yes',
            answered_original_as_array: ['yes'],
            judgment_payload_json: {createdAt: '2026-01-03T00:00:00.000Z', explanation: 'because', quotes: []},
          },
          {
            article_id: 'article-1',
            prompt_id: 'prompt-2',
            model_id: 'model-1',
            judgment_id: null,
            answered_original: null,
            answered_original_as_array: [],
            judgment_payload_json: null,
            placeholder_kind: 'llm.unanswered',
          },
        ] as T[]
      }

      return [{availability: 'ready', count_value: totalCount}] as T[]
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

test('LLM review route honors the largest offered page size', async () => {
  const reader = createReaderDatabase(1001)
  const result = await getLlmReviewArticlesFromServing(
    {projectId: 'project-1', page: 1, limit: 500, prompts: {}},
    {
      currentReviewConfigHash: 'config-1',
      database: reader.database,
      manifestDatabase: createManifestDatabase('active'),
    },
  )

  expect(result.limit).toBe(500)
  expect(result.totalPages).toBe(3)
  expect(reader.statements.join('\n')).toContain('LIMIT 501')
})

test('LLM review route chunks judgment hydration above the reader article-set cap', async () => {
  const reader = createReaderDatabase(250, 250, 100)

  await getLlmReviewArticlesFromServing(
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

  expect(judgmentStatements).toHaveLength(3)
  expect(judgmentStatements[0]).toContain('article-100')
  expect(judgmentStatements[0]).not.toContain('article-101')
  expect(judgmentStatements[1]).toContain('article-101')
  expect(judgmentStatements[1]).toContain('article-200')
  expect(judgmentStatements[2]).toContain('article-201')
  expect(judgmentStatements[2]).toContain('article-250')
})

test('LLM review route sizes judgment hydration chunks by enabled prompt count', async () => {
  const reader = createReaderDatabase(51, 51, 200)

  await getLlmReviewArticlesFromServing(
    {projectId: 'project-1', page: 1, limit: 51, prompts: {}},
    {
      currentReviewConfigHash: 'config-1',
      database: reader.database,
      manifestDatabase: createManifestDatabase('active'),
    },
  )

  const judgmentStatements = reader.statements.filter((statement) => {
    return statement.includes('FROM mart.review_article_judgment_detail_serving_v4')
  })

  expect(judgmentStatements).toHaveLength(2)
  expect(judgmentStatements[0]).toContain('LIMIT 10000')
  expect(judgmentStatements[0]).toContain('article-50')
  expect(judgmentStatements[0]).not.toContain('article-51')
  expect(judgmentStatements[1]).toContain('LIMIT 200')
  expect(judgmentStatements[1]).toContain('article-51')
})

test('LLM review list route service composes serving rows, judgments, and count without raw fallback SQL', async () => {
  const reader = createReaderDatabase()
  const result = await getLlmReviewArticlesFromServing(
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
      llmStatus: 'complete',
    },
    {
      currentReviewConfigHash: 'config-1',
      database: reader.database,
      manifestDatabase: createManifestDatabase('active'),
    },
  )
  const sql = reader.statements.join('\n')

  expect(result.data[0]?.judgments[0]?.answeredOriginal).toBe('yes')
  expect(result.data[0]?.articleCreatedAt).toBeNull()
  expect(result.data[0]?.articleUpdatedAt).toBeNull()
  expect(result.data[0]?.arxivId).toBe('2401.00001')
  expect(result.data[0]?.doi).toBe('10.1000/article-1')
  expect(result.data[0]?.fullTextConversionStatus).toBe('converted')
  expect(result.data[0]?.fullTextFetchedAt).toEqual(new Date('2026-01-04T00:00:00.000Z'))
  expect(result.data[0]?.pubmedId).toBe('12341')
  expect(result.data[0]?.sourceMetadata).toEqual({covidence: {studyId: 'study-1'}})
  expect(result.data[0]?.judgments).toHaveLength(1)
  expect(result.data[0]?.judgedPromptIds).toEqual(['prompt-1'])
  expect(result.data[0]?.isFullyJudged).toBe(true)
  expect(reader.statements).toHaveLength(4)
  expect(sql).toContain('FROM mart.review_article_serving_v4')
  expect(sql).toContain('FROM mart.review_article_judgment_detail_serving_v4')
  expect(sql).toContain('COUNT(DISTINCT serving.article_id)')
  expect(sql).toContain("article_id IN (SELECT unnest(['article-1']::VARCHAR[]))")
  expect(sql).toContain("article_created_at >= TIMESTAMPTZ '2026-01-10T00:00:00.000Z'")
  expect(sql).toContain("article_created_at <= TIMESTAMPTZ '2026-01-20T00:00:00.000Z'")
  forbiddenSqlFragments.forEach((fragment) => {
    expect(sql).not.toContain(fragment)
  })
})

test('LLM review route tokenizes title search like the title search projector and reads optional search identity for counts', async () => {
  const reader = createReaderDatabase()
  const result = await countLlmReviewArticlesFromServing(
    {projectId: 'project-1', page: 1, limit: 25, prompts: {}, search: 'COVID-19 heart failure'},
    {
      currentReviewConfigHash: 'config-1',
      database: reader.database,
      manifestDatabase: createManifestDatabase('active'),
    },
  )
  const sql = reader.statements.join('\n')

  expect(result).toEqual({totalCount: 1, totalPages: 1})
  expect(sql).toContain("unnest(['covid', '19', 'heart', 'failure']::VARCHAR[])")
  expect(sql).toContain("search.search_identity = 'search-identity'")
  expect(sql).toContain('starts_with(search.token, search_prefix.token_prefix)')
})

test('LLM review count route service requires reviewed LLM rows without row hydration', async () => {
  const reader = createReaderDatabase()
  const result = await countLlmReviewArticlesFromServing(
    {projectId: 'project-1', page: 1, limit: 25, prompts: {}},
    {
      currentReviewConfigHash: 'config-1',
      database: reader.database,
      manifestDatabase: createManifestDatabase('active'),
    },
  )

  expect(result).toEqual({totalCount: 1, totalPages: 1})
  expect(reader.statements).toHaveLength(2)
  expect(reader.statements[1]).toContain('FROM mart.review_article_serving_v4')
  expect(reader.statements[1]).toContain('serving.llm_judged_prompt_count > 0')
})

test('LLM review list route rejects when no serving snapshot is readable', async () => {
  const reader = createReaderDatabase()

  await expectUnavailableSnapshotRejection(
    getLlmReviewArticlesFromServing(
      {projectId: 'project-1', page: 2, limit: 25, prompts: {}},
      {
        currentReviewConfigHash: 'config-1',
        database: reader.database,
        manifestDatabase: createManifestDatabase('missing'),
      },
    ),
  )
  expect(reader.statements.join('\n')).not.toContain('FROM mart.review_article_serving_v4')
})

test('LLM review route service surfaces stale, indexing, and unavailable freshness without raw fallback', async () => {
  const staleReader = createReaderDatabase()
  const staleResult = await countLlmReviewArticlesFromServing(
    {projectId: 'project-1', page: 1, limit: 25, prompts: {}},
    {
      currentReviewConfigHash: 'config-1',
      database: staleReader.database,
      manifestDatabase: createManifestDatabase('retired'),
    },
  )

  expect(staleResult.totalCount).toBe(1)
  expect(staleReader.statements.join('\n')).toContain('serving.llm_judged_prompt_count > 0')
  const indexingReader = createReaderDatabase()
  const missingReader = createReaderDatabase()

  await expectUnavailableSnapshotRejection(
    countLlmReviewArticlesFromServing(
      {projectId: 'project-1', page: 1, limit: 25, prompts: {}},
      {
        currentReviewConfigHash: 'config-1',
        database: indexingReader.database,
        manifestDatabase: createManifestDatabase('candidate'),
      },
    ),
  )
  await expectUnavailableSnapshotRejection(
    countLlmReviewArticlesFromServing(
      {projectId: 'project-1', page: 1, limit: 25, prompts: {}},
      {
        currentReviewConfigHash: 'config-1',
        database: missingReader.database,
        manifestDatabase: createManifestDatabase('missing'),
      },
    ),
  )
  expect(indexingReader.statements.join('\n')).not.toContain('FROM mart.review_article_serving_v4')
  expect(missingReader.statements.join('\n')).not.toContain('FROM mart.review_article_serving_v4')
})

test('LLM review route diagnostics surface failed snapshot errors for articlesreviews readers', async () => {
  const result = await readReviewServingRows(
    {
      contractKey: 'review.llm.rows',
      limit: 25,
      projectId: 'project-1',
      reviewConfigHash: 'config-1',
      snapshotId: 'failed-snapshot',
    },
    {
      database: createReaderDatabase().database,
      diagnosticsDatabase: createManifestDatabase('failed'),
      manifestDatabase: createManifestDatabase('failed'),
    },
  )

  expect(result.status).toBe('rejected')
  expect(result.diagnostics.manifest).toEqual({
    freshness: 'unavailable',
    lastError: 'projection failed',
    projectId: 'project-1',
    snapshotId: 'failed-snapshot',
    status: 'failed',
  })
  expect(result.diagnostics.rejectionReason).toBe('manifestStatusRejected')
})

test('LLM review route diagnostics surface candidate and missing snapshot states for articlesreviews readers', async () => {
  const candidate = await readReviewServingRows(
    {
      contractKey: 'review.llm.rows',
      limit: 25,
      projectId: 'project-1',
      reviewConfigHash: 'config-1',
      snapshotId: 'candidate-snapshot',
    },
    {
      database: createReaderDatabase().database,
      diagnosticsDatabase: createManifestDatabase('candidate'),
      manifestDatabase: createManifestDatabase('candidate'),
    },
  )
  const missing = await readReviewServingRows(
    {
      contractKey: 'review.llm.rows',
      limit: 25,
      projectId: 'project-1',
      reviewConfigHash: 'config-1',
      snapshotId: 'missing-snapshot',
    },
    {
      database: createReaderDatabase().database,
      diagnosticsDatabase: createManifestDatabase('missing'),
      manifestDatabase: createManifestDatabase('missing'),
    },
  )

  expect(candidate.status).toBe('rejected')
  expect(candidate.diagnostics.manifest).toMatchObject({freshness: 'indexing', status: 'candidate'})
  expect(candidate.diagnostics.rejectionReason).toBe('manifestStatusRejected')
  expect(missing.status).toBe('rejected')
  expect(missing.diagnostics.manifest).toMatchObject({freshness: 'unavailable', snapshotId: null, status: 'missing'})
  expect(missing.diagnostics.rejectionReason).toBe('servingIdentityMissing')
})

test('migrated LLM review routes do not import OLAP fallback wrappers', async () => {
  const listRoute = await readFile('src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviews.ts', 'utf8')
  const countRoute = await readFile('src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsCount.ts', 'utf8')

  expect(listRoute).not.toContain('articlesReviewsOlap')
  expect(listRoute).not.toContain('queryArticlesReviewsFromOlap')
  expect(countRoute).not.toContain('articlesReviewsOlap')
  expect(countRoute).not.toContain('countArticlesReviewsFromOlap')
})
