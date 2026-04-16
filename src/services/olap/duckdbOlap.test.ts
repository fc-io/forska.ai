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

const getJudgmentProjectClause = (projectId = 'project-1') => {
  return `COALESCE(j.project_id, j.snapshot_project_id) = ${getDuckdbSqlString(projectId)}`
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
  return [
    {
      id: 'prompt-1',
      order: 0,
      promptHeading: 'Prompt 1',
      originalText: 'Prompt 1',
      type: 'string',
      criteriaDisposition: 'include',
    },
  ]
}

const getPromptRowsWithTie = () => {
  return [
    {
      id: 'prompt-1',
      order: 0,
      promptHeading: 'Prompt 1',
      originalText: 'Prompt 1',
      type: 'string',
      criteriaDisposition: 'include',
    },
    {
      id: 'prompt-2',
      order: 0,
      promptHeading: 'Prompt 2',
      originalText: 'Prompt 2',
      type: 'string',
      criteriaDisposition: 'exclude',
    },
  ]
}

const getPromptRowsWithTwoPrompts = () => {
  return [
    {
      id: 'prompt-1',
      order: 0,
      promptHeading: 'Prompt 1',
      originalText: 'Prompt 1',
      type: 'string',
      criteriaDisposition: 'include',
    },
    {
      id: 'prompt-2',
      order: 1,
      promptHeading: 'Prompt 2',
      originalText: 'Prompt 2',
      type: 'string',
      criteriaDisposition: 'exclude',
    },
  ]
}

const getProjectRows = (modelId: string | null, humanJudgmentMode: 'prompt' | 'summary' = 'prompt') => {
  return [
    {
      id: 'project-1',
      dateFrom: null,
      dateTo: null,
      humanJudgmentMode,
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
    projectId: string | null
    snapshotProjectId: string | null
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
    projectId: 'projectId' in overrides ? overrides.projectId : 'project-1',
    snapshotProjectId: 'snapshotProjectId' in overrides ? overrides.snapshotProjectId : 'project-1',
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

const getNormalizedReviewRows = (
  rows: Array<{id: string; articleTitle: string | null; judgedPromptIds: string[]; isFullyJudged: boolean}>,
) => {
  return rows.map((row) => {
    return {
      id: row.id,
      articleTitle: row.articleTitle,
      judgedPromptIds: row.judgedPromptIds,
      isFullyJudged: row.isFullyJudged,
    }
  })
}

const getNormalizedUnassessedRows = (rows: Array<{id: string; articleTitle: string | null}>) => {
  return rows.map((row) => {
    return {id: row.id, articleTitle: row.articleTitle}
  })
}

const getServingReviewArticleRow = (overrides?: Partial<{articleId: string; articleTitle: string}>) => {
  return {
    articleId: overrides?.articleId ?? 'article-1',
    articleExternalId: `external-${overrides?.articleId ?? 'article-1'}`,
    articleTitle: overrides?.articleTitle ?? 'Article 1',
    articleCreatedAt: '2024-01-02T00:00:00.000Z',
    articleUpdatedAt: '2024-01-03T00:00:00.000Z',
    fullTextConversionStatus: null,
    fullTextFetchedAt: null,
    fullTextPDF: null,
    journalTitle: 'Journal 1',
    url: null,
  }
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

test('queryArticlesReviewsFromDuckdb uses new serving mart when rows exist', async () => {
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
        sourceMetadata: {
          journalTitle: 'Journal 1',
          preprintSource: null,
          preprintHostLabel: null,
          isPreprint: false,
          fullTextLinks: [],
        },
        url: null,
      },
    ],
    [],
    [getDuckdbJudgmentRow({articleId: 'article-1', promptId: 'prompt-1'})],
  ])

  const {queryArticlesReviewsFromDuckdb} = await loadDuckdbOlap()
  const result = await queryArticlesReviewsFromDuckdb({projectId: 'project-1', page: 1, limit: 10})

  expect(result.data[0]?.id).toBe('article-1')
  expect(duckdbRunnerMockRef.current.queries[4]).toContain('FROM mart.review_article_serving s')
  expect(duckdbRunnerMockRef.current.queries[6]).toContain(getJudgmentProjectClause())
})

test('queryArticlesReviewsFromDuckdb emits nextCursor on review article serving path', async () => {
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
    [],
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
  expect(duckdbRunnerMockRef.current.queries[4]).toContain('FROM mart.review_article_serving s')
})

test('queryArticlesReviewsFromDuckdb emits nextCursor on raw fallback path', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
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
  expect(duckdbRunnerMockRef.current.queries[4]).toContain('FROM app.article a')
  expect(duckdbRunnerMockRef.current.queries[4]).toContain('LIMIT 2')
})

test('queryArticlesReviewsFromDuckdb falls back to raw judgments when serving rows are missing', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
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
  expect(duckdbRunnerMockRef.current.queries[5]).toContain(getJudgmentProjectClause())
  expect(duckdbRunnerMockRef.current.queries[5]).not.toContain('FROM mart.review_article_rollup r')
})

test('queryArticlesReviewsFromDuckdb uses review article serving details when they exist', async () => {
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
  expect(duckdbRunnerMockRef.current.queries[4]).toContain('FROM mart.review_article_serving s')
  expect(duckdbRunnerMockRef.current.queries[6]).toContain('FROM mart.review_article_serving_detail j')
  expect(result.data[0]?.sourceMetadata).toEqual({
    journalTitle: null,
    preprintSource: 'ppr',
    preprintHostLabel: 'Research Square',
    isPreprint: true,
    fullTextLinks: [],
    covidence: null,
  })
})

test('queryArticlesReviewsFromDuckdb uses filter member mart when available', async () => {
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
  expect(duckdbRunnerMockRef.current.queries[5]).toContain('FROM mart.review_article_filter_member member')
  expect(duckdbRunnerMockRef.current.queries[5]).toContain('FROM mart.review_article_serving s')
  expect(duckdbRunnerMockRef.current.queries[7]).toContain('FROM mart.review_article_serving_detail j')
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

test('countArticlesReviewsFromDuckdb falls back to raw judgments when serving rows are missing', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [],
    [{totalCount: 2}],
  ])

  const {countArticlesReviewsFromDuckdb} = await loadDuckdbOlap()
  const result = await countArticlesReviewsFromDuckdb({projectId: 'project-1', limit: 10})

  expect(result).toEqual({totalCount: 2, totalPages: 1})
  expect(duckdbRunnerMockRef.current.queries[4]).toContain('FROM app.judgment j')
  expect(duckdbRunnerMockRef.current.queries[4]).toContain(getJudgmentProjectClause())
  expect(duckdbRunnerMockRef.current.queries[4]).not.toContain('FROM mart.review_article_rollup r')
})

test('countArticlesReviewsFromDuckdb falls back to raw judgments when serving ledger freshness is stale', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [],
    [{totalCount: 2}],
  ])

  const {countArticlesReviewsFromDuckdb} = await loadDuckdbOlap()
  const result = await countArticlesReviewsFromDuckdb({projectId: 'project-1', limit: 10})

  expect(result).toEqual({totalCount: 2, totalPages: 1})
  expect(duckdbRunnerMockRef.current.queries[3]).toContain('LEFT JOIN app.project_mart_refresh_state refresh_state')
  expect(duckdbRunnerMockRef.current.queries[4]).toContain('FROM app.judgment j')
})

test('countArticlesReviewsFromDuckdb uses new serving filter members when rows exist', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [{projectId: 'project-1'}],
    [{projectId: 'project-1'}],
    [{totalCount: 2}],
  ])

  const {countArticlesReviewsFromDuckdb} = await loadDuckdbOlap()
  const result = await countArticlesReviewsFromDuckdb({
    projectId: 'project-1',
    limit: 10,
    prompts: {'prompt-1': ['yes']},
  })

  expect(result).toEqual({totalCount: 2, totalPages: 1})
  expect(duckdbRunnerMockRef.current.queries[5]).toContain('FROM mart.review_article_filter_member member')
  expect(duckdbRunnerMockRef.current.queries[5]).toContain('FROM mart.review_article_serving s')
})

test('getUnassessedCountFromDuckdb uses raw article and judgment rows when serving rows are missing', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [],
    [
      getDuckdbScopedArticleRow({id: 'article-1'}),
      getDuckdbScopedArticleRow({id: 'article-2'}),
      getDuckdbScopedArticleRow({id: 'article-3'}),
    ],
    [getDuckdbJudgmentRow({articleId: 'article-1', promptId: 'prompt-1'})],
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

  expect(result).toBe(2)
  expect(duckdbRunnerMockRef.current.queries).toHaveLength(6)
  expect(duckdbRunnerMockRef.current.queries[4]).toContain('FROM app.article a')
  expect(duckdbRunnerMockRef.current.queries[5]).toContain('FROM app.judgment j')
})

test('getUnassessedCountFromDuckdb falls back to raw rows when serving coverage is incomplete', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [],
    [
      getDuckdbScopedArticleRow({id: 'article-1'}),
      getDuckdbScopedArticleRow({id: 'article-2'}),
      getDuckdbScopedArticleRow({id: 'article-3'}),
    ],
    [getDuckdbJudgmentRow({articleId: 'article-1', promptId: 'prompt-1'})],
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

  expect(result).toBe(2)
  expect(duckdbRunnerMockRef.current.queries).toHaveLength(6)
  expect(duckdbRunnerMockRef.current.queries[3]).toContain('scopeRowCount')
  expect(duckdbRunnerMockRef.current.queries[3]).toContain('servingRowCount')
  expect(duckdbRunnerMockRef.current.queries[3]).toContain('FROM mart.review_article_serving s')
  expect(duckdbRunnerMockRef.current.queries[3]).toContain('FROM app.article a')
  expect(duckdbRunnerMockRef.current.queries[4]).toContain('FROM app.article a')
  expect(duckdbRunnerMockRef.current.queries[5]).toContain('FROM app.judgment j')
})

test('getUnassessedArticlesFromDuckdb falls back to raw judgments when serving rows are missing', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [],
    [
      getDuckdbScopedArticleRow({id: 'article-1'}),
      getDuckdbScopedArticleRow({id: 'article-2', articleId: 'external-2'}),
    ],
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

test('getUnassessedPairsFromDuckdb falls back to raw judgments when serving rows are missing', async () => {
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
  expect(duckdbRunnerMockRef.current.queries[4]).toContain('LIMIT 1001')
  expect(duckdbRunnerMockRef.current.queries[5]).toContain('FROM app.judgment j')
  expect(duckdbRunnerMockRef.current.queries[5]).not.toContain('TO_JSON')
  expect(duckdbRunnerMockRef.current.queries[5]).not.toContain('explanation')
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

test('getDatabaseBasedFiltersFromDuckdb uses prompt answer fact for model projects', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [],
    [{promptId: 'prompt-1', answerValue: 'alpha'}],
  ])

  const {getDatabaseBasedFiltersFromDuckdb} = await loadDuckdbOlap()
  const result = await getDatabaseBasedFiltersFromDuckdb({
    projectId: 'project-1',
    prompts: [getPromptFilter({strategy: 'database'})],
    fromDate: null,
    toDate: null,
    searchTitle: '',
  })

  expect(result).toEqual([{promptId: 'prompt-1', promptName: 'Prompt 1', answeredOriginalValues: ['alpha']}])
  expect(duckdbRunnerMockRef.current.queries[4]).toContain('FROM mart.prompt_answer_fact paf')
})

test('getDatabaseBasedFiltersFromDuckdb returns empty values on query error', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [],
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
    [],
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

test('getNumericFiltersFromDuckdb uses prompt answer fact for model projects', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    [{id: 'prompt-1', order: 0, promptHeading: 'Prompt 1', originalText: 'Prompt 1', type: 'string.integer'}],
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [],
    [{promptId: 'prompt-1', answerValue: '10'}],
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
  ).toEqual(['10'])
  expect(duckdbRunnerMockRef.current.queries[4]).toContain('FROM mart.prompt_answer_fact paf')
})

test('getNumericFiltersFromDuckdb returns empty bins on query error', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    [{id: 'prompt-1', order: 0, promptHeading: 'Prompt 1', originalText: 'Prompt 1', type: 'string.integer'}],
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [],
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
    [],
    [getDuckdbScopedArticleRow({id: 'article-1'})],
    [getDuckdbJudgmentRow({articleId: 'article-1', promptId: 'prompt-1'})],
    [getDuckdbHumanAnswerRow({articleId: 'article-1', promptId: 'prompt-1'})],
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
    [],
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

test('queryArticlesReviewsBothFromDuckdb uses raw rows for model projects when serving rows are missing', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [],
    [getDuckdbScopedArticleRow({id: 'article-1', articleTitle: 'Article 1'})],
    [getDuckdbJudgmentRow({articleId: 'article-1', promptId: 'prompt-1'})],
    [getDuckdbHumanAnswerRow({articleId: 'article-1', promptId: 'prompt-1'})],
  ])

  const {queryArticlesReviewsBothFromDuckdb} = await loadDuckdbOlap()
  const result = await queryArticlesReviewsBothFromDuckdb({projectId: 'project-1', page: 1, limit: 10})

  expect(result.totalCount).toBe(1)
  expect(duckdbRunnerMockRef.current.queries[4]).toContain('FROM app.article a')
  expect(duckdbRunnerMockRef.current.queries[5]).toContain('FROM app.judgment j')
})

test('queryArticlesReviewsBothFromDuckdb uses review article serving when rows exist', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [{projectId: 'project-1'}],
    [{totalCount: 1}],
    [
      {
        articleCreatedAt: '2024-01-02T00:00:00.000Z',
        articleId: 'article-1',
        articleTitle: 'Article 1',
        articleUpdatedAt: '2024-01-03T00:00:00.000Z',
        sourceMetadata: {
          journalTitle: 'Journal 1',
          preprintSource: null,
          preprintHostLabel: null,
          isPreprint: false,
          fullTextLinks: [],
        },
      },
    ],
    [{projectId: 'project-1'}],
    [getDuckdbJudgmentRow({articleId: 'article-1', promptId: 'prompt-1'})],
    [getDuckdbHumanAnswerRow({articleId: 'article-1', promptId: 'prompt-1'})],
  ])

  const {queryArticlesReviewsBothFromDuckdb} = await loadDuckdbOlap()
  const result = await queryArticlesReviewsBothFromDuckdb({projectId: 'project-1', page: 1, limit: 10})

  expect(result.totalCount).toBe(1)
  expect(result.data[0]?.id).toBe('article-1')
  expect(duckdbRunnerMockRef.current.queries[4]).toContain('FROM mart.review_article_serving s')
  expect(duckdbRunnerMockRef.current.queries[5]).toContain('FROM mart.review_article_serving s')
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

test('selectArticleIdsByFilterDuckdb human uses raw rows when serving rows are missing', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [],
    [getDuckdbScopedArticleRow({id: 'article-1'})],
    [getDuckdbHumanAnswerRow({articleId: 'article-1', promptId: 'prompt-1'})],
  ])

  const {selectArticleIdsByFilterDuckdb} = await loadDuckdbOlap()
  const result = await selectArticleIdsByFilterDuckdb('project-1', 'human', undefined, {['prompt-1']: ['yes']})

  expect(result).toEqual(['article-1'])
  expect(duckdbRunnerMockRef.current.queries[4]).toContain('FROM app.article a')
})

test('selectArticleIdsByFilterDuckdb both uses raw rows when serving rows are missing', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [],
    [getDuckdbScopedArticleRow({id: 'article-1'})],
    [getDuckdbJudgmentRow({articleId: 'article-1', promptId: 'prompt-1'})],
    [getDuckdbScopedArticleRow({id: 'article-1'})],
    [getDuckdbHumanAnswerRow({articleId: 'article-1', promptId: 'prompt-1'})],
  ])

  const {selectArticleIdsByFilterDuckdb} = await loadDuckdbOlap()
  const result = await selectArticleIdsByFilterDuckdb('project-1', 'both', undefined, {['prompt-1']: ['yes']})

  expect(result).toEqual(['article-1'])
  expect(duckdbRunnerMockRef.current.queries[4]).toContain('FROM app.article a')
})

test('selectArticleIdsByFilterDuckdb both excludes partially judged llm rows when serving rows are missing', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRowsWithTwoPrompts(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [],
    [getDuckdbScopedArticleRow({id: 'article-1'})],
    [getDuckdbJudgmentRow({articleId: 'article-1', promptId: 'prompt-1'})],
    [getDuckdbScopedArticleRow({id: 'article-1'})],
    [
      getDuckdbHumanAnswerRow({articleId: 'article-1', promptId: 'prompt-1'}),
      getDuckdbHumanAnswerRow({articleId: 'article-1', promptId: 'prompt-2'}),
    ],
  ])

  const {selectArticleIdsByFilterDuckdb} = await loadDuckdbOlap()
  const result = await selectArticleIdsByFilterDuckdb('project-1', 'both', undefined, {['prompt-1']: ['yes']})

  expect(result).toEqual([])
})

test('selectArticleIdsByFilterDuckdb unassessed uses raw rows when serving rows are missing', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [],
    [
      {
        id: 'article-1',
        articleId: 'external-1',
        articleTitle: 'Article 1',
        articleCreatedAt: '2024-01-02T00:00:00.000Z',
        articleUpdatedAt: '2024-01-03T00:00:00.000Z',
        llmJudgedPromptIds: [],
      },
    ],
    [],
  ])

  const {selectArticleIdsByFilterDuckdb} = await loadDuckdbOlap()
  const result = await selectArticleIdsByFilterDuckdb('project-1', 'unassessed')

  expect(result).toEqual(['article-1'])
  expect(duckdbRunnerMockRef.current.queries[4]).toContain('FROM app.article a')
})

test('selectArticleIdsByFilterDuckdb llm uses raw rows when serving rows are missing', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRowsWithTwoPrompts(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [],
    [getDuckdbScopedArticleRow({id: 'article-1'})],
    [getDuckdbJudgmentRow({articleId: 'article-1', promptId: 'prompt-1'})],
  ])

  const {selectArticleIdsByFilterDuckdb} = await loadDuckdbOlap()
  const result = await selectArticleIdsByFilterDuckdb('project-1', 'llm')

  expect(result).toEqual(['article-1'])
  expect(duckdbRunnerMockRef.current.queries[4]).toContain('FROM app.article a')
  expect(duckdbRunnerMockRef.current.queries[5]).toContain(getJudgmentProjectClause())
})

test('selectArticleIdsByFilterDuckdb llm uses review article serving when rows exist', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRowsWithTwoPrompts(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [{projectId: 'project-1'}],
    [{articleId: 'article-1'}],
  ])

  const {selectArticleIdsByFilterDuckdb} = await loadDuckdbOlap()
  const result = await selectArticleIdsByFilterDuckdb('project-1', 'llm')

  expect(result).toEqual(['article-1'])
  expect(duckdbRunnerMockRef.current.queries[4]).toContain('FROM mart.review_article_serving s')
  expect(duckdbRunnerMockRef.current.queries[4]).toContain('COALESCE(s.llm_judged_prompt_count, 0) > 0')
})

test('selectArticleIdsByFilterDuckdb llm complete uses full-judgment serving filter', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRowsWithTwoPrompts(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [{projectId: 'project-1'}],
    [{articleId: 'article-1'}],
  ])

  const {selectArticleIdsByFilterDuckdb} = await loadDuckdbOlap()
  const result = await selectArticleIdsByFilterDuckdb('project-1', 'llm', 'complete')

  expect(result).toEqual(['article-1'])
  expect(duckdbRunnerMockRef.current.queries[4]).toContain('s.has_all_llm_judgments = TRUE')
})

test('selectArticleIdsByFilterDuckdb llm partial uses incomplete serving filter', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRowsWithTwoPrompts(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [{projectId: 'project-1'}],
    [{articleId: 'article-1'}],
  ])

  const {selectArticleIdsByFilterDuckdb} = await loadDuckdbOlap()
  const result = await selectArticleIdsByFilterDuckdb('project-1', 'llm', 'partial')

  expect(result).toEqual(['article-1'])
  expect(duckdbRunnerMockRef.current.queries[4]).toContain('COALESCE(s.llm_judged_prompt_count, 0) > 0')
  expect(duckdbRunnerMockRef.current.queries[4]).toContain('s.has_all_llm_judgments = FALSE')
})

test('selectArticleIdsByFilterDuckdb both keeps complete llm requirement on serving path', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRowsWithTwoPrompts(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [{projectId: 'project-1'}],
    [{articleId: 'article-1'}],
  ])

  const {selectArticleIdsByFilterDuckdb} = await loadDuckdbOlap()
  const result = await selectArticleIdsByFilterDuckdb('project-1', 'both', undefined, {['prompt-1']: ['yes']})

  expect(result).toEqual(['article-1'])
  expect(duckdbRunnerMockRef.current.queries[4]).toContain('s.has_all_llm_judgments = TRUE')
  expect(duckdbRunnerMockRef.current.queries[4]).toContain('s.has_all_human_answers = TRUE')
})

test('queryArticlesReviewsBothFromDuckdb exposes summary answers for summary-mode serving rows', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRowsWithTwoPrompts(),
    getProjectRows('model-1', 'summary'),
    getScopeRouteRows(),
    [{projectId: 'project-1'}],
    [{totalCount: 1}],
    [
      {
        articleId: 'article-1',
        articleTitle: 'Article 1',
        articleCreatedAt: '2024-01-02T00:00:00.000Z',
        articleUpdatedAt: '2024-01-03T00:00:00.000Z',
        sourceMetadata: {journalTitle: 'Journal 1'},
      },
    ],
    [],
    [
      getDuckdbJudgmentRow({articleId: 'article-1', promptId: 'prompt-1', answeredOriginal: 'yes'}),
      getDuckdbJudgmentRow({id: 'judgment-2', articleId: 'article-1', promptId: 'prompt-2', answeredOriginal: 'no'}),
    ],
    [{articleId: 'article-1', answer: 'no', updatedAt: '2024-01-04T00:00:00.000Z'}],
  ])

  const {queryArticlesReviewsBothFromDuckdb} = await loadDuckdbOlap()
  const result = await queryArticlesReviewsBothFromDuckdb({projectId: 'project-1', page: 1, limit: 10})

  expect(result.data[0]).toMatchObject({
    id: 'article-1',
    humanJudgmentMode: 'summary',
    humanSummaryAnswer: 'no',
    llmSummaryAnswer: 'yes',
  })
  expect(result.data[0]?.humanAnswersByPrompt).toBeUndefined()
  expect(duckdbRunnerMockRef.current.queries[8]).toContain('FROM app.judgment_human_summary')
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
  expect(duckdbRunnerMockRef.current.queries[4]).toContain(getJudgmentProjectClause())
})

test('queryArticlesReviewsFromDuckdb keeps core row output aligned across serving and raw paths', async () => {
  const {queryArticlesReviewsFromDuckdb} = await loadDuckdbOlap()

  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRowsWithTwoPrompts(),
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
    ],
    [],
    [getDuckdbJudgmentRow({articleId: 'article-1', promptId: 'prompt-1'})],
  ])
  const servingResult = await queryArticlesReviewsFromDuckdb({projectId: 'project-1', page: 1, limit: 10})
  const servingReviewQuery = duckdbRunnerMockRef.current.queries[4]

  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRowsWithTwoPrompts(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
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
    ],
    [getDuckdbJudgmentRow({articleId: 'article-1', promptId: 'prompt-1'})],
  ])
  const rawResult = await queryArticlesReviewsFromDuckdb({projectId: 'project-1', page: 1, limit: 10})

  expect(getNormalizedReviewRows(servingResult.data)).toEqual(getNormalizedReviewRows(rawResult.data))
  expect(servingResult.data[0]?.isFullyJudged).toBe(false)
  expect(rawResult.data[0]?.isFullyJudged).toBe(false)
  expect(servingReviewQuery).toContain('COALESCE(s.llm_judged_prompt_count, 0) > 0')
  expect(duckdbRunnerMockRef.current.queries[4]).toContain('COUNT(DISTINCT j.prompt_id) > 0')
  expect(duckdbRunnerMockRef.current.queries[4]).not.toContain('COUNT(DISTINCT j.prompt_id) = 2')
})

test('queryArticlesReviewsFromDuckdb llmStatus modes stay aligned across serving and raw paths', async () => {
  const {queryArticlesReviewsFromDuckdb} = await loadDuckdbOlap()

  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRowsWithTwoPrompts(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [{projectId: 'project-1'}],
    [getServingReviewArticleRow()],
    [],
    [getDuckdbJudgmentRow({articleId: 'article-1', promptId: 'prompt-1'})],
  ])
  await queryArticlesReviewsFromDuckdb({projectId: 'project-1', page: 1, limit: 10, llmStatus: 'complete'})
  const completeServingQuery = duckdbRunnerMockRef.current.queries[4]

  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRowsWithTwoPrompts(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [{projectId: 'project-1'}],
    [getServingReviewArticleRow()],
    [],
    [getDuckdbJudgmentRow({articleId: 'article-1', promptId: 'prompt-1'})],
  ])
  await queryArticlesReviewsFromDuckdb({projectId: 'project-1', page: 1, limit: 10, llmStatus: 'both'})
  const bothServingQuery = duckdbRunnerMockRef.current.queries[4]

  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRowsWithTwoPrompts(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [{projectId: 'project-1'}],
    [getServingReviewArticleRow()],
    [],
    [getDuckdbJudgmentRow({articleId: 'article-1', promptId: 'prompt-1'})],
  ])
  await queryArticlesReviewsFromDuckdb({projectId: 'project-1', page: 1, limit: 10, llmStatus: 'partial'})
  const partialServingQuery = duckdbRunnerMockRef.current.queries[4]

  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRowsWithTwoPrompts(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [],
    [getDuckdbScopedArticleRow({id: 'article-1'})],
    [getDuckdbJudgmentRow({articleId: 'article-1', promptId: 'prompt-1'})],
  ])
  await queryArticlesReviewsFromDuckdb({projectId: 'project-1', page: 1, limit: 10, llmStatus: 'complete'})
  const completeRawQuery = duckdbRunnerMockRef.current.queries[4]

  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRowsWithTwoPrompts(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [],
    [getDuckdbScopedArticleRow({id: 'article-1'})],
    [getDuckdbJudgmentRow({articleId: 'article-1', promptId: 'prompt-1'})],
  ])
  await queryArticlesReviewsFromDuckdb({projectId: 'project-1', page: 1, limit: 10, llmStatus: 'both'})
  const bothRawQuery = duckdbRunnerMockRef.current.queries[4]

  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRowsWithTwoPrompts(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [],
    [getDuckdbScopedArticleRow({id: 'article-1'})],
    [getDuckdbJudgmentRow({articleId: 'article-1', promptId: 'prompt-1'})],
  ])
  await queryArticlesReviewsFromDuckdb({projectId: 'project-1', page: 1, limit: 10, llmStatus: 'partial'})
  const partialRawQuery = duckdbRunnerMockRef.current.queries[4]

  expect(completeServingQuery).toContain('s.has_all_llm_judgments = TRUE')
  expect(completeServingQuery).not.toContain('s.has_all_llm_judgments = FALSE')
  expect(completeServingQuery).not.toContain('COALESCE(s.llm_judged_prompt_count, 0) > 0')
  expect(bothServingQuery).toContain('COALESCE(s.llm_judged_prompt_count, 0) > 0')
  expect(bothServingQuery).not.toContain('s.has_all_llm_judgments = TRUE')
  expect(bothServingQuery).not.toContain('s.has_all_llm_judgments = FALSE')
  expect(partialServingQuery).toContain('COALESCE(s.llm_judged_prompt_count, 0) > 0')
  expect(partialServingQuery).toContain('s.has_all_llm_judgments = FALSE')

  expect(completeRawQuery).toContain('COUNT(DISTINCT j.prompt_id) = 2')
  expect(completeRawQuery).not.toContain('COUNT(DISTINCT j.prompt_id) < 2')
  expect(bothRawQuery).toContain('COUNT(DISTINCT j.prompt_id) > 0')
  expect(bothRawQuery).not.toContain('COUNT(DISTINCT j.prompt_id) < 2')
  expect(bothRawQuery).not.toContain('COUNT(DISTINCT j.prompt_id) = 2')
  expect(partialRawQuery).toContain('COUNT(DISTINCT j.prompt_id) > 0 AND COUNT(DISTINCT j.prompt_id) < 2')
  expect(partialRawQuery).not.toContain('COUNT(DISTINCT j.prompt_id) = 2')
})

test('countArticlesReviewsFromDuckdb keeps counts aligned across serving and raw paths', async () => {
  const {countArticlesReviewsFromDuckdb} = await loadDuckdbOlap()

  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRowsWithTwoPrompts(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [{projectId: 'project-1'}],
    [{totalCount: 1}],
  ])
  const servingResult = await countArticlesReviewsFromDuckdb({projectId: 'project-1', limit: 10})
  const servingCountQuery = duckdbRunnerMockRef.current.queries[4]

  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRowsWithTwoPrompts(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [],
    [{totalCount: 1}],
  ])
  const rawResult = await countArticlesReviewsFromDuckdb({projectId: 'project-1', limit: 10})

  expect(servingResult).toEqual({totalCount: 1, totalPages: 1})
  expect(rawResult).toEqual(servingResult)
  expect(servingCountQuery).toContain('COALESCE(s.llm_judged_prompt_count, 0) > 0')
  expect(duckdbRunnerMockRef.current.queries[4]).toContain('COUNT(DISTINCT j.prompt_id) > 0')
})

test('countArticlesReviewsFromDuckdb llmStatus modes stay aligned across serving and raw paths', async () => {
  const {countArticlesReviewsFromDuckdb} = await loadDuckdbOlap()

  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRowsWithTwoPrompts(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [{projectId: 'project-1'}],
    [{totalCount: 1}],
  ])
  await countArticlesReviewsFromDuckdb({projectId: 'project-1', limit: 10, llmStatus: 'complete'})
  const completeServingQuery = duckdbRunnerMockRef.current.queries[4]

  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRowsWithTwoPrompts(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [{projectId: 'project-1'}],
    [{totalCount: 1}],
  ])
  await countArticlesReviewsFromDuckdb({projectId: 'project-1', limit: 10, llmStatus: 'both'})
  const bothServingQuery = duckdbRunnerMockRef.current.queries[4]

  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRowsWithTwoPrompts(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [{projectId: 'project-1'}],
    [{totalCount: 1}],
  ])
  await countArticlesReviewsFromDuckdb({projectId: 'project-1', limit: 10, llmStatus: 'partial'})
  const partialServingQuery = duckdbRunnerMockRef.current.queries[4]

  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRowsWithTwoPrompts(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [],
    [{totalCount: 1}],
  ])
  await countArticlesReviewsFromDuckdb({projectId: 'project-1', limit: 10, llmStatus: 'complete'})
  const completeRawQuery = duckdbRunnerMockRef.current.queries[4]

  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRowsWithTwoPrompts(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [],
    [{totalCount: 1}],
  ])
  await countArticlesReviewsFromDuckdb({projectId: 'project-1', limit: 10, llmStatus: 'both'})
  const bothRawQuery = duckdbRunnerMockRef.current.queries[4]

  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRowsWithTwoPrompts(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [],
    [{totalCount: 1}],
  ])
  await countArticlesReviewsFromDuckdb({projectId: 'project-1', limit: 10, llmStatus: 'partial'})
  const partialRawQuery = duckdbRunnerMockRef.current.queries[4]

  expect(completeServingQuery).toContain('s.has_all_llm_judgments = TRUE')
  expect(completeServingQuery).not.toContain('COALESCE(s.llm_judged_prompt_count, 0) > 0')
  expect(bothServingQuery).toContain('COALESCE(s.llm_judged_prompt_count, 0) > 0')
  expect(bothServingQuery).not.toContain('s.has_all_llm_judgments = TRUE')
  expect(partialServingQuery).toContain('COALESCE(s.llm_judged_prompt_count, 0) > 0')
  expect(partialServingQuery).toContain('s.has_all_llm_judgments = FALSE')

  expect(completeRawQuery).toContain('COUNT(DISTINCT j.prompt_id) = 2')
  expect(bothRawQuery).toContain('COUNT(DISTINCT j.prompt_id) > 0')
  expect(bothRawQuery).not.toContain('COUNT(DISTINCT j.prompt_id) = 2')
  expect(partialRawQuery).toContain('COUNT(DISTINCT j.prompt_id) > 0 AND COUNT(DISTINCT j.prompt_id) < 2')
})

test('selectArticleIdsByFilterDuckdb llmStatus modes stay aligned across serving and raw paths', async () => {
  const {selectArticleIdsByFilterDuckdb} = await loadDuckdbOlap()

  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRowsWithTwoPrompts(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [{projectId: 'project-1'}],
    [{articleId: 'article-complete'}],
  ])
  const completeServingResult = await selectArticleIdsByFilterDuckdb('project-1', 'llm', 'complete')
  const completeServingQuery = duckdbRunnerMockRef.current.queries[4]

  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRowsWithTwoPrompts(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [{projectId: 'project-1'}],
    [{articleId: 'article-both'}],
  ])
  const bothServingResult = await selectArticleIdsByFilterDuckdb('project-1', 'llm', 'both')
  const bothServingQuery = duckdbRunnerMockRef.current.queries[4]

  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRowsWithTwoPrompts(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [{projectId: 'project-1'}],
    [{articleId: 'article-partial'}],
  ])
  const partialServingResult = await selectArticleIdsByFilterDuckdb('project-1', 'llm', 'partial')
  const partialServingQuery = duckdbRunnerMockRef.current.queries[4]

  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRowsWithTwoPrompts(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [],
    [
      getDuckdbScopedArticleRow({id: 'article-complete'}),
      getDuckdbScopedArticleRow({id: 'article-partial'}),
      getDuckdbScopedArticleRow({id: 'article-none'}),
    ],
    [
      getDuckdbJudgmentRow({articleId: 'article-complete', promptId: 'prompt-1'}),
      getDuckdbJudgmentRow({id: 'judgment-2', articleId: 'article-complete', promptId: 'prompt-2'}),
      getDuckdbJudgmentRow({id: 'judgment-3', articleId: 'article-partial', promptId: 'prompt-1'}),
    ],
  ])
  const completeRawResult = await selectArticleIdsByFilterDuckdb('project-1', 'llm', 'complete')

  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRowsWithTwoPrompts(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [],
    [
      getDuckdbScopedArticleRow({id: 'article-complete'}),
      getDuckdbScopedArticleRow({id: 'article-partial'}),
      getDuckdbScopedArticleRow({id: 'article-none'}),
    ],
    [
      getDuckdbJudgmentRow({articleId: 'article-complete', promptId: 'prompt-1'}),
      getDuckdbJudgmentRow({id: 'judgment-2', articleId: 'article-complete', promptId: 'prompt-2'}),
      getDuckdbJudgmentRow({id: 'judgment-3', articleId: 'article-partial', promptId: 'prompt-1'}),
    ],
  ])
  const bothRawResult = await selectArticleIdsByFilterDuckdb('project-1', 'llm', 'both')

  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRowsWithTwoPrompts(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [],
    [
      getDuckdbScopedArticleRow({id: 'article-complete'}),
      getDuckdbScopedArticleRow({id: 'article-partial'}),
      getDuckdbScopedArticleRow({id: 'article-none'}),
    ],
    [
      getDuckdbJudgmentRow({articleId: 'article-complete', promptId: 'prompt-1'}),
      getDuckdbJudgmentRow({id: 'judgment-2', articleId: 'article-complete', promptId: 'prompt-2'}),
      getDuckdbJudgmentRow({id: 'judgment-3', articleId: 'article-partial', promptId: 'prompt-1'}),
    ],
  ])
  const partialRawResult = await selectArticleIdsByFilterDuckdb('project-1', 'llm', 'partial')

  expect(completeServingResult).toEqual(['article-complete'])
  expect(bothServingResult).toEqual(['article-both'])
  expect(partialServingResult).toEqual(['article-partial'])
  expect(completeServingQuery).toContain('s.has_all_llm_judgments = TRUE')
  expect(bothServingQuery).toContain('COALESCE(s.llm_judged_prompt_count, 0) > 0')
  expect(bothServingQuery).not.toContain('s.has_all_llm_judgments = TRUE')
  expect(partialServingQuery).toContain('COALESCE(s.llm_judged_prompt_count, 0) > 0')
  expect(partialServingQuery).toContain('s.has_all_llm_judgments = FALSE')

  expect(completeRawResult).toEqual(['article-complete'])
  expect(bothRawResult).toEqual(['article-complete', 'article-partial'])
  expect(partialRawResult).toEqual(['article-partial'])
})

test('getUnassessedArticlesFromDuckdb keeps rows aligned across serving and raw paths', async () => {
  const {getUnassessedArticlesFromDuckdb} = await loadDuckdbOlap()

  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [{projectId: 'project-1'}],
    [{totalCount: 1}],
    [
      {
        id: 'article-2',
        articleId: 'external-2',
        articleTitle: 'Article 2',
        articleCreatedAt: '2024-01-01T00:00:00.000Z',
        articleUpdatedAt: '2024-01-02T00:00:00.000Z',
        llmJudgedPromptIds: [],
      },
    ],
  ])
  const servingResult = await getUnassessedArticlesFromDuckdb({
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

  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [],
    [
      getDuckdbScopedArticleRow({id: 'article-1'}),
      getDuckdbScopedArticleRow({id: 'article-2', articleId: 'external-2', articleTitle: 'Article 2'}),
    ],
    [getDuckdbJudgmentRow({articleId: 'article-1', promptId: 'prompt-1'})],
  ])
  const rawResult = await getUnassessedArticlesFromDuckdb({
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

  expect(servingResult.totalCount).toBe(1)
  expect(rawResult.totalCount).toBe(1)
  expect(getNormalizedUnassessedRows(servingResult.articles)).toEqual(
    getNormalizedUnassessedRows(
      rawResult.articles.map((article) => {
        return {...article, id: article.articleId ?? article.id}
      }),
    ),
  )
})

test('getUnassessedArticlesFromDuckdb uses review article serving when rows exist', async () => {
  const {getUnassessedArticlesFromDuckdb} = await loadDuckdbOlap()

  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [{projectId: 'project-1'}],
    [{totalCount: 1}],
    [
      {
        articleCreatedAt: '2024-01-01T00:00:00.000Z',
        articleId: 'external-2',
        articleTitle: 'Article 2',
        articleUpdatedAt: '2024-01-02T00:00:00.000Z',
        llmJudgedPromptIds: [],
      },
    ],
  ])

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
  expect(result.articles[0]?.id).toBe('external-2')
  expect(duckdbRunnerMockRef.current.queries[4]).toContain('FROM mart.review_article_serving s')
  expect(duckdbRunnerMockRef.current.queries[5]).toContain('FROM mart.review_article_serving s')
})

test('getUnassessedArticlesFromDuckdb falls back to raw rows when raw fallback is preferred', async () => {
  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [
      getDuckdbScopedArticleRow({id: 'article-1'}),
      getDuckdbScopedArticleRow({id: 'article-2', articleId: 'external-2', articleTitle: 'Article 2'}),
    ],
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
    preferRawFallback: true,
  })

  expect(result.totalCount).toBe(1)
  expect(result.articles[0]?.id).toBe('article-2')
  expect(duckdbRunnerMockRef.current.queries).toHaveLength(5)
  expect(duckdbRunnerMockRef.current.queries[3]).toContain('FROM app.article a')
  expect(duckdbRunnerMockRef.current.queries[4]).toContain('FROM app.judgment j')
})

test('getUnassessedPairsFromDuckdb keeps prompt entries aligned across serving and raw paths', async () => {
  const {getUnassessedPairsFromDuckdb} = await loadDuckdbOlap()

  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [{projectId: 'project-1'}],
    [
      {
        articleId: 'article-1',
        articleCreatedAt: '2024-01-01T00:00:00.000Z',
        articleUpdatedAt: '2024-01-02T00:00:00.000Z',
        llmJudgedPromptIds: [],
      },
    ],
  ])
  const servingResult = await getUnassessedPairsFromDuckdb({
    projectId: 'project-1',
    jobId: 'job-1',
    numberOfPromptsToGet: 10,
    cursor: null,
  })

  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [],
    [getDuckdbScopedArticleRow({id: 'article-1', articleUpdatedAt: '2024-01-02T00:00:00.000Z'})],
    [],
  ])
  const rawResult = await getUnassessedPairsFromDuckdb({
    projectId: 'project-1',
    jobId: 'job-1',
    numberOfPromptsToGet: 10,
    cursor: null,
  })

  expect(servingResult).toEqual(rawResult)
})

test('getUnassessedPairsFromDuckdb uses priority-aware cursor ordering for summary queue scans', async () => {
  const {getUnassessedPairsFromDuckdb} = await loadDuckdbOlap()
  const cursorDate = new Date('2024-01-03T00:00:00.000Z')

  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows('model-1', 'summary'),
    getScopeRouteRows(),
    [{projectId: 'project-1'}],
    [
      {
        articleId: 'article-1',
        articleCreatedAt: '2024-01-01T00:00:00.000Z',
        articleUpdatedAt: '2024-01-02T00:00:00.000Z',
        llmJudgedPromptIds: [],
        priorityBucket: 0,
      },
    ],
  ])

  const result = await getUnassessedPairsFromDuckdb({
    projectId: 'project-1',
    jobId: 'job-1',
    numberOfPromptsToGet: 10,
    cursor: {lastArticleId: 'article-2', lastDate: cursorDate} as never,
  })

  const servingQuery = duckdbRunnerMockRef.current.queries[4] ?? ''

  expect(result.nextCursor).toEqual({
    lastArticleId: 'article-1',
    lastDate: new Date('2024-01-02T00:00:00.000Z'),
    priorityBucket: 0,
  })
  expect(servingQuery).toContain('CASE WHEN human_summary_priority.article_id IS NULL THEN 0 ELSE 1 END < 0')
  expect(servingQuery).toContain(
    "ORDER BY CASE WHEN human_summary_priority.article_id IS NULL THEN 0 ELSE 1 END DESC, COALESCE(s.article_updated_at, s.article_created_at, TIMESTAMPTZ '1970-01-01T00:00:00.000Z') DESC, s.article_id DESC",
  )
})

test('getDatabaseBasedFiltersFromDuckdb keeps values aligned across prompt answer fact and raw fallback paths', async () => {
  const {getDatabaseBasedFiltersFromDuckdb} = await loadDuckdbOlap()

  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [{projectId: 'project-1'}],
    [
      {promptId: 'prompt-1', answerValue: 'alpha'},
      {promptId: 'prompt-1', answerValue: 'beta'},
    ],
  ])
  const martResult = await getDatabaseBasedFiltersFromDuckdb({
    projectId: 'project-1',
    prompts: [getPromptFilter({strategy: 'database'})],
    fromDate: null,
    toDate: null,
    searchTitle: '',
  })

  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows(null),
    getScopeRouteRows(),
    [getDuckdbScopedArticleRow({id: 'article-1'})],
    [
      getDuckdbJudgmentRow({articleId: 'article-1', promptId: 'prompt-1', answeredOriginal: 'alpha'}),
      getDuckdbJudgmentRow({id: 'judgment-2', articleId: 'article-1', promptId: 'prompt-1', answeredOriginal: 'beta'}),
    ],
  ])
  const rawResult = await getDatabaseBasedFiltersFromDuckdb({
    projectId: 'project-1',
    prompts: [getPromptFilter({strategy: 'database'})],
    fromDate: null,
    toDate: null,
    searchTitle: '',
  })

  expect(martResult).toEqual(rawResult)
})

test('getDatabaseBasedFiltersFromDuckdb uses review article filter members when rows exist', async () => {
  const {getDatabaseBasedFiltersFromDuckdb} = await loadDuckdbOlap()

  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    getPromptRows(),
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [{projectId: 'project-1'}],
    [{promptId: 'prompt-1', answerValue: 'alpha'}],
  ])

  const result = await getDatabaseBasedFiltersFromDuckdb({
    projectId: 'project-1',
    prompts: [getPromptFilter({strategy: 'database'})],
    fromDate: null,
    toDate: null,
    searchTitle: '',
  })

  expect(result).toEqual([{promptId: 'prompt-1', promptName: 'Prompt 1', answeredOriginalValues: ['alpha']}])
  expect(duckdbRunnerMockRef.current.queries[4]).toContain('FROM mart.review_article_filter_member member')
})

test('getNumericFiltersFromDuckdb keeps bins aligned across prompt answer fact and raw fallback paths', async () => {
  const numericPrompt = {
    id: 'prompt-1',
    order: 0,
    promptHeading: 'Prompt 1',
    originalText: 'Prompt 1',
    type: 'string.integer',
  }
  const {getNumericFiltersFromDuckdb} = await loadDuckdbOlap()

  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    [numericPrompt],
    getProjectRows('model-1'),
    getScopeRouteRows(),
    [{projectId: 'project-1'}],
    [
      {promptId: 'prompt-1', answerValue: '10'},
      {promptId: 'prompt-1', answerValue: '-3'},
    ],
  ])
  const martResult = await getNumericFiltersFromDuckdb({
    projectId: 'project-1',
    prompts: [getPromptFilter({strategy: 'numeric', type: 'string.integer'})],
    fromDate: null,
    toDate: null,
    searchTitle: '',
  })

  duckdbRunnerMockRef.current = createDuckdbRunnerMock([
    [numericPrompt],
    getProjectRows(null),
    getScopeRouteRows(),
    [getDuckdbScopedArticleRow({id: 'article-1'})],
    [
      getDuckdbJudgmentRow({articleId: 'article-1', promptId: 'prompt-1', answeredOriginal: '10'}),
      getDuckdbJudgmentRow({id: 'judgment-2', articleId: 'article-1', promptId: 'prompt-1', answeredOriginal: '-3'}),
    ],
  ])
  const rawResult = await getNumericFiltersFromDuckdb({
    projectId: 'project-1',
    prompts: [getPromptFilter({strategy: 'numeric', type: 'string.integer'})],
    fromDate: null,
    toDate: null,
    searchTitle: '',
  })

  expect(martResult).toEqual(rawResult)
})
