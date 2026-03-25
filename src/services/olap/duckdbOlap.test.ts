import {expect, mock, test} from 'bun:test'

const duckdbRunnerModulePath = new URL('./duckdbRunner.ts', import.meta.url).pathname

const createDuckdbRunnerMock = (queryResults: unknown[]) => {
  const resultsQueue = [...queryResults]
  const queries: string[] = []

  return {
    queries,
    runDuckdbJsonQuery: async <T>(query: string): Promise<T[]> => {
      queries.push(query)
      const result = resultsQueue.shift() ?? []
      return (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)) as Promise<T[]>
    },
  }
}

const getDuckdbSqlString = (value: string) => {
  return `'${value.replaceAll("'", "''")}'`
}

const getPromptFilter = (
  overrides: Partial<{
    promptId: string
    promptName: string
    type: string | null
    strategy: 'database' | 'numeric'
    specialValues: string[] | null
  }>,
) => {
  return {
    promptId: overrides.promptId ?? 'prompt-1',
    promptName: overrides.promptName ?? 'Prompt 1',
    type: overrides.type ?? null,
    strategy: overrides.strategy ?? 'database',
    enumOptions: null,
    specialValues: overrides.specialValues ?? null,
  }
}

const getPromptRows = () => {
  return [{id: 'prompt-1', order: 0, promptHeading: 'Prompt 1', originalText: 'Prompt 1', type: 'string'}]
}

const getPromptRowsWithTie = () => {
  return [
    {id: 'prompt-1', order: 0, promptHeading: 'Prompt 1', originalText: 'Prompt 1', type: 'string'},
    {id: 'prompt-2', order: 0, promptHeading: 'Prompt 2', originalText: 'Prompt 2', type: 'string'},
  ]
}

const getProjectRows = (modelId: string | null) => {
  return [
    {
      id: 'project-1',
      dateFrom: null,
      dateTo: null,
      modelId,
      useTitle: true,
      useAbstract: true,
      useFulltext: false,
      useFulltextNoImages: false,
    },
  ]
}

const getScopeRouteRows = () => {
  return [{importRouteId: 'route-1'}]
}

const getDuckdbScopedArticleRow = (
  overrides: Partial<{
    id: string
    createdAt: string | null
    updatedAt: string | null
    articleId: string | null
    articleTitle: string
    articleCreatedAt: string | null
    articleUpdatedAt: string | null
    importRoute: string | null
    url: string | null
    fullTextPDF: string | null
    fullTextFetchedAt: string | null
    fullTextConversionStatus: string | null
    originalData: unknown
  }>,
) => {
  return {
    id: overrides.id ?? 'article-1',
    createdAt: 'createdAt' in overrides ? overrides.createdAt : '2024-01-01T00:00:00.000Z',
    updatedAt: 'updatedAt' in overrides ? overrides.updatedAt : '2024-01-01T00:00:00.000Z',
    articleId: 'articleId' in overrides ? overrides.articleId : 'external-1',
    articleTitle: overrides.articleTitle ?? 'Article 1',
    articleCreatedAt: 'articleCreatedAt' in overrides ? overrides.articleCreatedAt : '2024-01-01T00:00:00.000Z',
    articleUpdatedAt: 'articleUpdatedAt' in overrides ? overrides.articleUpdatedAt : '2024-01-01T00:00:00.000Z',
    importRoute: 'importRoute' in overrides ? overrides.importRoute : null,
    url: 'url' in overrides ? overrides.url : null,
    fullTextPDF: 'fullTextPDF' in overrides ? overrides.fullTextPDF : null,
    fullTextFetchedAt: 'fullTextFetchedAt' in overrides ? overrides.fullTextFetchedAt : null,
    fullTextConversionStatus: 'fullTextConversionStatus' in overrides ? overrides.fullTextConversionStatus : null,
    originalData: 'originalData' in overrides ? overrides.originalData : null,
  }
}

const getDuckdbJudgmentRow = (
  overrides: Partial<{
    id: string
    createdAt: string
    articleId: string
    articleTitle: string
    articleCreatedAt: string | null
    articleUpdatedAt: string | null
    articleImportRoute: string | null
    promptId: string
    modelId: string
    answeredOriginal: string | null
    answeredOriginalAsArray: unknown
    explanation: string | null
    quotes: unknown
  }>,
) => {
  return {
    id: overrides.id ?? 'judgment-1',
    createdAt: overrides.createdAt ?? '2024-01-03T00:00:00.000Z',
    articleId: overrides.articleId ?? 'article-1',
    articleTitle: overrides.articleTitle ?? 'Article 1',
    articleCreatedAt: 'articleCreatedAt' in overrides ? overrides.articleCreatedAt : '2024-01-01T00:00:00.000Z',
    articleUpdatedAt: 'articleUpdatedAt' in overrides ? overrides.articleUpdatedAt : '2024-01-01T00:00:00.000Z',
    articleImportRoute: 'articleImportRoute' in overrides ? overrides.articleImportRoute : null,
    promptId: overrides.promptId ?? 'prompt-1',
    modelId: overrides.modelId ?? 'model-1',
    answeredOriginal: 'answeredOriginal' in overrides ? overrides.answeredOriginal : 'yes',
    answeredOriginalAsArray: 'answeredOriginalAsArray' in overrides ? overrides.answeredOriginalAsArray : null,
    explanation: 'explanation' in overrides ? overrides.explanation : null,
    quotes: 'quotes' in overrides ? overrides.quotes : [],
  }
}

const getDuckdbHumanAnswerRow = (
  overrides: Partial<{articleId: string; promptId: string; answer: string | null; updatedAt: string | null}>,
) => {
  return {
    articleId: overrides.articleId ?? 'article-1',
    promptId: overrides.promptId ?? 'prompt-1',
    answer: overrides.answer ?? 'include',
    updatedAt: overrides.updatedAt ?? '2024-01-04T00:00:00.000Z',
  }
}

const duckdbRunnerMockRef = {current: createDuckdbRunnerMock([])}

void mock.module(duckdbRunnerModulePath, () => {
  return {
    getDuckdbSqlBoolean: (value: boolean) => {
      return value ? 'TRUE' : 'FALSE'
    },
    getDuckdbSqlString,
    getDuckdbSqlStringList: (values: string[]) => {
      return values.map((value) => {
        return getDuckdbSqlString(value)
      })
    },
    runDuckdbJsonQuery: <T>(query: string) => {
      return duckdbRunnerMockRef.current.runDuckdbJsonQuery<T>(query)
    },
  }
})

const loadDuckdbOlap = () => {
  return import('./duckdbOlap.ts')
}

test('queryArticlesReviewsFromDuckdb keeps reviewed rows when project modelId is null', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows(null),
    getScopeRouteRows(),
    [
      {
        id: 'article-1',
        articleTitle: 'Reviewed article',
        articleCreatedAt: '2024-01-01T00:00:00.000Z',
        articleUpdatedAt: '2024-01-02T00:00:00.000Z',
        originalData: {journal: 'Journal A'},
      },
    ],
    [
      {
        id: 'judgment-1',
        createdAt: '2024-01-03T00:00:00.000Z',
        articleId: 'article-1',
        articleTitle: 'Reviewed article',
        articleCreatedAt: '2024-01-01T00:00:00.000Z',
        articleUpdatedAt: '2024-01-02T00:00:00.000Z',
        articleImportRoute: null,
        promptId: 'prompt-1',
        modelId: 'model-any',
        answeredOriginal: 'yes',
        answeredOriginalAsArray: null,
        explanation: null,
        quotes: [],
      },
    ],
  ])

  const {queryArticlesReviewsFromDuckdb} = await loadDuckdbOlap()
  const result = await queryArticlesReviewsFromDuckdb({projectId: 'project-1', page: 1, limit: 10})

  expect(
    result.data.map((row) => {
      return row.id
    }),
  ).toEqual(['article-1'])
  expect(result.data[0]?.judgedPromptIds).toEqual(['prompt-1'])
  expect(result.totalCount).toBeNull()
  expect(duckdbRunnerMockRef.current.queries[3]).not.toContain('j.model_id =')
  expect(duckdbRunnerMockRef.current.queries[4]).not.toContain('j.model_id =')
})

test('queryArticlesReviewsFromDuckdb emits nextCursor on candidate/display serving path', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [{projectId: 'project-1'}],
    [
      {
        articleId: 'article-1',
        articleExternalId: 'external-1',
        articleTitle: 'Article 1',
        articleCreatedAt: '2024-01-02T00:00:00.000Z',
        articleUpdatedAt: '2024-01-03T00:00:00.000Z',
        fullTextConversionStatus: null,
        fullTextFetchedAt: null,
        fullTextPDF: null,
        journalTitle: 'Journal 1',
        url: null,
      },
      {
        articleId: 'article-2',
        articleExternalId: 'external-2',
        articleTitle: 'Article 2',
        articleCreatedAt: '2024-01-01T00:00:00.000Z',
        articleUpdatedAt: '2024-01-02T00:00:00.000Z',
        fullTextConversionStatus: null,
        fullTextFetchedAt: null,
        fullTextPDF: null,
        journalTitle: 'Journal 2',
        url: null,
      },
    ],
    [{projectId: 'project-1'}],
    [getDuckdbJudgmentRow({articleId: 'article-1', promptId: 'prompt-1'})],
  ])

  const {queryArticlesReviewsFromDuckdb} = await loadDuckdbOlap()
  const firstPage = await queryArticlesReviewsFromDuckdb({projectId: 'project-1', page: 1, limit: 1})

  expect(
    firstPage.data.map((row) => {
      return row.id
    }),
  ).toEqual(['article-1'])
  expect(typeof firstPage.nextCursor).toBe('string')
  expect(duckdbRunnerMockRef.current.queries[4]).toContain('FROM mart.review_article_candidate c')
  expect(duckdbRunnerMockRef.current.queries[4]).toContain(
    'INNER JOIN app.article article ON article.id = page_ids.articleId',
  )
})

test('queryArticlesReviewsFromDuckdb emits nextCursor on rollup fallback path', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [],
    [{projectId: 'project-1'}],
    [
      {
        id: 'article-1',
        articleTitle: 'Article 1',
        articleCreatedAt: '2024-01-02T00:00:00.000Z',
        articleUpdatedAt: '2024-01-03T00:00:00.000Z',
        sourceMetadata: {
          journalTitle: 'Journal 1',
          preprintSource: null,
          preprintHostLabel: null,
          isPreprint: false,
          fullTextLinks: [],
        },
      },
      {
        id: 'article-2',
        articleTitle: 'Article 2',
        articleCreatedAt: '2024-01-01T00:00:00.000Z',
        articleUpdatedAt: '2024-01-02T00:00:00.000Z',
        sourceMetadata: {
          journalTitle: 'Journal 2',
          preprintSource: null,
          preprintHostLabel: null,
          isPreprint: false,
          fullTextLinks: [],
        },
      },
    ],
    [getDuckdbJudgmentRow({articleId: 'article-1', promptId: 'prompt-1'})],
  ])

  const {queryArticlesReviewsFromDuckdb} = await loadDuckdbOlap()
  const firstPage = await queryArticlesReviewsFromDuckdb({projectId: 'project-1', page: 1, limit: 1})

  expect(
    firstPage.data.map((row) => {
      return row.id
    }),
  ).toEqual(['article-1'])
  expect(typeof firstPage.nextCursor).toBe('string')
  expect(duckdbRunnerMockRef.current.queries[5]).toContain('FROM mart.review_article_rollup r')
  expect(duckdbRunnerMockRef.current.queries[5]).toContain('LIMIT 2')
})

test('queryArticlesReviewsFromDuckdb falls back to app judgments when review rollup rows are missing', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [],
    [],
    [
      {
        id: 'article-1',
        articleTitle: 'Article 1',
        articleCreatedAt: '2024-01-02T00:00:00.000Z',
        articleUpdatedAt: '2024-01-03T00:00:00.000Z',
        sourceMetadata: {
          journalTitle: 'Journal 1',
          preprintSource: null,
          preprintHostLabel: null,
          isPreprint: false,
          fullTextLinks: [],
        },
      },
      {
        id: 'article-2',
        articleTitle: 'Article 2',
        articleCreatedAt: '2024-01-01T00:00:00.000Z',
        articleUpdatedAt: '2024-01-02T00:00:00.000Z',
        sourceMetadata: {
          journalTitle: 'Journal 2',
          preprintSource: null,
          preprintHostLabel: null,
          isPreprint: false,
          fullTextLinks: [],
        },
      },
    ],
    [
      getDuckdbJudgmentRow({articleId: 'article-1', promptId: 'prompt-1'}),
      getDuckdbJudgmentRow({id: 'judgment-2', articleId: 'article-2', promptId: 'prompt-1'}),
    ],
  ])

  const {queryArticlesReviewsFromDuckdb} = await loadDuckdbOlap()
  const firstPage = await queryArticlesReviewsFromDuckdb({projectId: 'project-1', page: 1, limit: 1})

  expect(
    firstPage.data.map((row) => {
      return row.id
    }),
  ).toEqual(['article-1'])
  expect(typeof firstPage.nextCursor).toBe('string')
  expect(duckdbRunnerMockRef.current.queries[5]).toContain('FROM app.judgment j')
  expect(duckdbRunnerMockRef.current.queries[5]).not.toContain('FROM mart.review_article_rollup r')
})

test('queryArticlesReviewsFromDuckdb uses candidate/display serving marts when they exist', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [{projectId: 'project-1'}],
    [
      {
        articleId: 'article-1',
        articleExternalId: 'external-1',
        articleTitle: 'Article 1',
        articleCreatedAt: '2024-01-02T00:00:00.000Z',
        articleUpdatedAt: '2024-01-03T00:00:00.000Z',
        fullTextConversionStatus: null,
        fullTextFetchedAt: null,
        fullTextPDF: null,
        id: 'article-1',
        journalTitle: 'Journal 1',
        sourceMetadata: {
          journalTitle: null,
          preprintSource: 'ppr',
          preprintHostLabel: 'Research Square',
          isPreprint: true,
        },
        url: 'https://example.com/1',
      },
    ],
    [{projectId: 'project-1'}],
    [
      {
        id: 'judgment-1',
        createdAt: '2024-01-01T00:00:00.000Z',
        articleId: 'article-1',
        articleTitle: 'Article 1',
        articleCreatedAt: '2024-01-02T00:00:00.000Z',
        articleUpdatedAt: '2024-01-03T00:00:00.000Z',
        articleImportRoute: null,
        promptId: 'prompt-1',
        modelId: 'model-1',
        answeredOriginal: 'yes',
        answeredOriginalAsArray: ['yes'],
      },
    ],
  ])

  const {queryArticlesReviewsFromDuckdb} = await loadDuckdbOlap()
  const result = await queryArticlesReviewsFromDuckdb({projectId: 'project-1', page: 1, limit: 10})

  expect(
    result.data.map((row) => {
      return row.id
    }),
  ).toEqual(['article-1'])
  expect(duckdbRunnerMockRef.current.queries[4]).toContain('FROM mart.review_article_candidate c')
  expect(duckdbRunnerMockRef.current.queries[4]).toContain(
    'INNER JOIN app.article article ON article.id = page_ids.articleId',
  )
  expect(duckdbRunnerMockRef.current.queries[6]).toContain('FROM mart.review_article_judgment_detail j')
  expect(result.data[0]?.sourceMetadata).toEqual({
    journalTitle: null,
    preprintSource: 'ppr',
    preprintHostLabel: 'Research Square',
    isPreprint: true,
    fullTextLinks: [],
  })
})

test('queryArticlesReviewsFromDuckdb uses filter posting mart when available', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [{projectId: 'project-1'}],
    [{projectId: 'project-1'}],
    [
      {
        articleId: 'article-1',
        articleExternalId: 'external-1',
        articleTitle: 'Article 1',
        articleCreatedAt: '2024-01-02T00:00:00.000Z',
        articleUpdatedAt: '2024-01-03T00:00:00.000Z',
        fullTextConversionStatus: null,
        fullTextFetchedAt: null,
        fullTextPDF: null,
        id: 'article-1',
        journalTitle: 'Journal 1',
        url: 'https://example.com/1',
      },
    ],
    [{projectId: 'project-1'}],
    [
      {
        id: 'judgment-1',
        createdAt: '2024-01-01T00:00:00.000Z',
        articleId: 'article-1',
        articleTitle: 'Article 1',
        articleCreatedAt: '2024-01-02T00:00:00.000Z',
        articleUpdatedAt: '2024-01-03T00:00:00.000Z',
        articleImportRoute: null,
        promptId: 'prompt-1',
        modelId: 'model-1',
        answeredOriginal: 'yes',
        answeredOriginalAsArray: ['yes'],
      },
    ],
  ])

  const {queryArticlesReviewsFromDuckdb} = await loadDuckdbOlap()
  await queryArticlesReviewsFromDuckdb({projectId: 'project-1', page: 1, limit: 10, prompts: {'prompt-1': ['yes']}})

  expect(duckdbRunnerMockRef.current.queries[5]).toContain('FROM app.review_answer_dictionary d')
  expect(duckdbRunnerMockRef.current.queries[5]).toContain('mart.review_article_filter_posting posting')
  expect(duckdbRunnerMockRef.current.queries[5]).toContain('FROM mart.review_article_candidate c')
})

test('countArticlesReviewsFromDuckdb counts rows when project modelId is null', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows(null),
    getScopeRouteRows(),
    [{totalCount: 2}],
  ])

  const {countArticlesReviewsFromDuckdb} = await loadDuckdbOlap()
  const result = await countArticlesReviewsFromDuckdb({projectId: 'project-1', limit: 10})

  expect(result).toEqual({totalCount: 2, totalPages: 1})
  expect(duckdbRunnerMockRef.current.queries[3]).not.toContain('j.model_id =')
})

test('countArticlesReviewsFromDuckdb falls back to app judgments when review rollup rows are missing', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [],
    [],
    [{totalCount: 2}],
  ])

  const {countArticlesReviewsFromDuckdb} = await loadDuckdbOlap()
  const result = await countArticlesReviewsFromDuckdb({projectId: 'project-1', limit: 10})

  expect(result).toEqual({totalCount: 2, totalPages: 1})
  expect(duckdbRunnerMockRef.current.queries[5]).toContain('FROM app.judgment j')
  expect(duckdbRunnerMockRef.current.queries[5]).not.toContain('FROM mart.review_article_rollup r')
})

test('getUnassessedCountFromDuckdb uses a count-only rollup query', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [{projectId: 'project-1'}],
    [{totalCount: 3}],
  ])

  const {getUnassessedCountFromDuckdb} = await loadDuckdbOlap()
  const result = await getUnassessedCountFromDuckdb({
    projectId: 'project-1',
    projectModelId: 'model-1',
    projectDateFrom: null,
    projectDateTo: null,
    importRouteIds: ['route-1'],
    useTitle: true,
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
  })

  expect(result).toBe(3)
  expect(duckdbRunnerMockRef.current.queries).toHaveLength(5)
  expect(duckdbRunnerMockRef.current.queries[4]).toContain('SELECT COUNT(*) AS totalCount')
  expect(duckdbRunnerMockRef.current.queries[4]).toContain('FROM mart.review_article_rollup r')
  expect(duckdbRunnerMockRef.current.queries[4]).not.toContain('TO_JSON(r.llm_judged_prompt_ids)')
})

test('getUnassessedArticlesFromDuckdb falls back to app judgments when review rollup rows are missing', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [],
    [getDuckdbScopedArticleRow({id: 'article-1'}), getDuckdbScopedArticleRow({id: 'article-2'})],
    [getDuckdbJudgmentRow({articleId: 'article-1', promptId: 'prompt-1'})],
  ])

  const {getUnassessedArticlesFromDuckdb} = await loadDuckdbOlap()
  const result = await getUnassessedArticlesFromDuckdb({
    projectId: 'project-1',
    projectModelId: 'model-1',
    projectDateFrom: null,
    projectDateTo: null,
    importRouteIds: ['route-1'],
    useTitle: true,
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    limit: 10,
    offset: 0,
  })

  expect(result.totalCount).toBe(1)
  expect(
    result.articles.map((article) => {
      return article.id
    }),
  ).toEqual(['article-2'])
  expect(duckdbRunnerMockRef.current.queries[4]).toContain('FROM app.article a')
  expect(duckdbRunnerMockRef.current.queries[5]).toContain('FROM app.judgment j')
})

test('getUnassessedPairsFromDuckdb falls back to app judgments when review rollup rows are missing', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [],
    [getDuckdbScopedArticleRow({id: 'article-1'})],
    [],
  ])

  const {getUnassessedPairsFromDuckdb} = await loadDuckdbOlap()
  const result = await getUnassessedPairsFromDuckdb({
    projectId: 'project-1',
    jobId: 'job-1',
    numberOfPromptsToGet: 10,
    cursor: null,
  })

  expect(result.promptEntries).toEqual([{articleId: 'article-1', promptId: 'prompt-1'}])
  expect(result.nextCursor?.lastArticleId).toBe('article-1')
  expect(duckdbRunnerMockRef.current.queries[4]).toContain('FROM app.article a')
  expect(duckdbRunnerMockRef.current.queries[5]).toContain('FROM app.judgment j')
})

test('getDatabaseBasedFiltersFromDuckdb returns values when project modelId is null', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows(null),
    getScopeRouteRows(),
    [getDuckdbScopedArticleRow({id: 'article-1'})],
    [
      getDuckdbJudgmentRow({
        articleId: 'article-1',
        promptId: 'prompt-1',
        answeredOriginal: 'zeta',
        answeredOriginalAsArray: [],
      }),
      getDuckdbJudgmentRow({
        articleId: 'article-1',
        promptId: 'prompt-1',
        answeredOriginal: 'beta',
        answeredOriginalAsArray: [],
      }),
      getDuckdbJudgmentRow({
        articleId: 'article-1',
        promptId: 'prompt-1',
        answeredOriginal: 'alpha',
        answeredOriginalAsArray: [],
      }),
      getDuckdbJudgmentRow({
        articleId: 'article-1',
        promptId: 'prompt-1',
        answeredOriginal: 'alpha',
        answeredOriginalAsArray: [],
      }),
    ],
  ])

  const {getDatabaseBasedFiltersFromDuckdb} = await loadDuckdbOlap()
  const result = await getDatabaseBasedFiltersFromDuckdb({
    projectId: 'project-1',
    prompts: [getPromptFilter({strategy: 'database'})],
    fromDate: null,
    toDate: null,
    searchTitle: '',
  })

  expect(result).toEqual([
    {promptId: 'prompt-1', promptName: 'Prompt 1', answeredOriginalValues: ['alpha', 'beta', 'zeta']},
  ])
})

test('getDatabaseBasedFiltersFromDuckdb returns empty values on query error', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    new Error('db exploded'),
  ])

  const {getDatabaseBasedFiltersFromDuckdb} = await loadDuckdbOlap()
  const result = await getDatabaseBasedFiltersFromDuckdb({
    projectId: 'project-1',
    prompts: [getPromptFilter({strategy: 'database'})],
    fromDate: null,
    toDate: null,
    searchTitle: '',
  })

  expect(result).toEqual([{promptId: 'prompt-1', promptName: 'Prompt 1', answeredOriginalValues: []}])
})

test('getNumericFiltersFromDuckdb ignores non-integer values', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    [{id: 'prompt-1', order: 0, promptHeading: 'Prompt 1', originalText: 'Prompt 1', type: 'string.integer'}],
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [
      {promptId: 'prompt-1', answerValue: '10'},
      {promptId: 'prompt-1', answerValue: '10.5'},
      {promptId: 'prompt-1', answerValue: '10x'},
      {promptId: 'prompt-1', answerValue: '-3'},
    ],
  ])

  const {getNumericFiltersFromDuckdb} = await loadDuckdbOlap()
  const result = await getNumericFiltersFromDuckdb({
    projectId: 'project-1',
    prompts: [getPromptFilter({strategy: 'numeric', type: 'string.integer'})],
    fromDate: null,
    toDate: null,
    searchTitle: '',
  })

  expect(
    result[0]?.bins.map((bin) => {
      return bin.label
    }),
  ).toEqual(['-3', '10'])
})

test('getNumericFiltersFromDuckdb returns empty bins on query error', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    [{id: 'prompt-1', order: 0, promptHeading: 'Prompt 1', originalText: 'Prompt 1', type: 'string.integer'}],
    getProjectRows('model-1'),
    getScopeRouteRows(),
    new Error('db exploded'),
  ])

  const {getNumericFiltersFromDuckdb} = await loadDuckdbOlap()
  const result = await getNumericFiltersFromDuckdb({
    projectId: 'project-1',
    prompts: [getPromptFilter({strategy: 'numeric', type: 'string.integer'})],
    fromDate: null,
    toDate: null,
    searchTitle: '',
  })

  expect(result[0]?.bins).toEqual([])
})

test('queryArticlesReviewsFromDuckdb breaks prompt-order ties by newest judgment first', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRowsWithTie(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [{projectId: 'project-1'}],
    [
      {
        articleId: 'article-1',
        articleExternalId: 'external-1',
        articleTitle: 'Article 1',
        articleCreatedAt: '2024-01-01T00:00:00.000Z',
        articleUpdatedAt: '2024-01-01T00:00:00.000Z',
        fullTextConversionStatus: null,
        fullTextFetchedAt: null,
        fullTextPDF: null,
        journalTitle: 'Journal 1',
        url: null,
      },
    ],
    [],
    [
      getDuckdbJudgmentRow({
        id: 'judgment-old',
        createdAt: '2024-01-02T00:00:00.000Z',
        promptId: 'prompt-1',
        answeredOriginal: 'older',
        answeredOriginalAsArray: [],
      }),
      getDuckdbJudgmentRow({
        id: 'judgment-new',
        createdAt: '2024-01-03T00:00:00.000Z',
        promptId: 'prompt-2',
        answeredOriginal: 'newer',
        answeredOriginalAsArray: [],
      }),
    ],
  ])

  const {queryArticlesReviewsFromDuckdb} = await loadDuckdbOlap()
  const result = await queryArticlesReviewsFromDuckdb({projectId: 'project-1', page: 1, limit: 10})

  expect(
    result.data[0]?.judgments.map((row) => {
      return row.id
    }),
  ).toEqual(['judgment-new', 'judgment-old'])
  expect(duckdbRunnerMockRef.current.queries[6]).toContain('FROM mart.judgment_fact j')
})

test('queryArticlesReviewsBothFromDuckdb echoes requested page when it is out of range', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [{totalCount: 1}],
    [],
  ])

  const {queryArticlesReviewsBothFromDuckdb} = await loadDuckdbOlap()
  const result = await queryArticlesReviewsBothFromDuckdb({projectId: 'project-1', page: 3, limit: 1})

  expect(result.page).toBe(3)
  expect(result.totalCount).toBe(1)
  expect(result.totalPages).toBe(1)
  expect(result.data).toEqual([])
})

test('queryArticlesReviewsBothFromDuckdb keeps null articleCreatedAt rows last', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [{totalCount: 2}],
    [
      getDuckdbScopedArticleRow({
        id: 'article-dated',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        articleId: 'external-dated',
        articleTitle: 'Dated article',
        articleCreatedAt: '2023-12-31T00:00:00.000Z',
        articleUpdatedAt: null,
      }),
      getDuckdbScopedArticleRow({
        id: 'article-null',
        createdAt: '2024-01-03T00:00:00.000Z',
        updatedAt: '2024-01-03T00:00:00.000Z',
        articleId: 'external-null',
        articleTitle: 'Null created',
        articleCreatedAt: null,
        articleUpdatedAt: null,
      }),
    ],
    [
      getDuckdbJudgmentRow({
        id: 'judgment-1',
        articleId: 'article-null',
        articleTitle: 'Null created',
        articleCreatedAt: null,
        articleUpdatedAt: null,
        answeredOriginalAsArray: [],
      }),
      getDuckdbJudgmentRow({
        id: 'judgment-2',
        createdAt: '2024-01-02T00:00:00.000Z',
        articleId: 'article-dated',
        articleTitle: 'Dated article',
        articleCreatedAt: '2023-12-31T00:00:00.000Z',
        articleUpdatedAt: null,
        answeredOriginalAsArray: [],
      }),
    ],
    [getDuckdbHumanAnswerRow({articleId: 'article-null'}), getDuckdbHumanAnswerRow({articleId: 'article-dated'})],
  ])

  const {queryArticlesReviewsBothFromDuckdb} = await loadDuckdbOlap()
  const result = await queryArticlesReviewsBothFromDuckdb({projectId: 'project-1', page: 1, limit: 10})

  expect(
    result.data.map((row) => {
      return row.id
    }),
  ).toEqual(['article-dated', 'article-null'])
})

test('getUnassessedPairsFromDuckdb returns empty when project modelId is missing', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([getPromptRows(), getProjectRows(null), getScopeRouteRows()])

  const {getUnassessedPairsFromDuckdb} = await loadDuckdbOlap()
  const result = await getUnassessedPairsFromDuckdb({
    projectId: 'project-1',
    jobId: 'job-1',
    numberOfPromptsToGet: 10,
    cursor: null,
  })

  expect(result).toEqual({promptEntries: [], nextCursor: null})
})

test('selectArticleIdsByFilterDuckdb human ignores prompt filters like legacy olap', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [{articleId: 'article-1'}],
  ])

  const {selectArticleIdsByFilterDuckdb} = await loadDuckdbOlap()
  const result = await selectArticleIdsByFilterDuckdb('project-1', 'human', {['prompt-1']: ['yes']})

  expect(result).toEqual(['article-1'])
})

test('selectArticleIdsByFilterDuckdb both applies prompt filters only to llm rows', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [{articleId: 'article-1'}],
  ])

  const {selectArticleIdsByFilterDuckdb} = await loadDuckdbOlap()
  const result = await selectArticleIdsByFilterDuckdb('project-1', 'both', {['prompt-1']: ['yes']})

  expect(result).toEqual(['article-1'])
})

test('selectArticleIdsByFilterDuckdb keeps llm selection working when project modelId is null', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows(null),
    getScopeRouteRows(),
    [
      {
        id: 'article-1',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-02T00:00:00.000Z',
        articleId: 'external-1',
        articleTitle: 'Article 1',
        articleCreatedAt: '2024-01-01T00:00:00.000Z',
        articleUpdatedAt: '2024-01-02T00:00:00.000Z',
        importRoute: null,
        url: null,
        fullTextPDF: null,
        fullTextFetchedAt: null,
        fullTextConversionStatus: null,
        originalData: null,
      },
    ],
    [
      {
        id: 'judgment-1',
        createdAt: '2024-01-03T00:00:00.000Z',
        articleId: 'article-1',
        articleTitle: 'Article 1',
        articleCreatedAt: '2024-01-01T00:00:00.000Z',
        articleUpdatedAt: '2024-01-02T00:00:00.000Z',
        articleImportRoute: null,
        promptId: 'prompt-1',
        modelId: 'model-any',
        answeredOriginal: 'yes',
        answeredOriginalAsArray: null,
        explanation: null,
        quotes: [],
      },
    ],
  ])

  const {selectArticleIdsByFilterDuckdb} = await loadDuckdbOlap()
  const result = await selectArticleIdsByFilterDuckdb('project-1', 'llm')

  expect(result).toEqual(['article-1'])
  expect(duckdbRunnerMockRef.current.queries[4]).not.toContain('j.model_id =')
})
