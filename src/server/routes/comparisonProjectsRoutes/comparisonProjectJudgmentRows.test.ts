import {expect, test} from 'bun:test'

import type {ComparisonProjectDifferenceColumn} from '../../../utils/comparisonProjectDifferenceFilter.ts'
import {
  type ComparisonProjectJudgmentLlmRow,
  type ComparisonProjectScopedArticle,
  forEachComparisonProjectJudgmentRowBatch,
  forEachComparisonProjectServingJudgmentRowBatch,
  getComparisonProjectBatchCellsByArticle,
  getComparisonProjectBatchRows,
  getComparisonProjectScopedArticleBatchSql,
  getComparisonProjectServingArticlesSql,
  getComparisonProjectServingCellsSql,
  getComparisonProjectServingJudgmentCount,
  getComparisonProjectServingJudgmentCountSql,
  getComparisonProjectServingJudgmentRowsPage,
  getComparisonProjectServingMemberSql,
} from './comparisonProjectJudgmentRows.ts'

const columns = [
  {id: 'llm:model-1:1100:prompt-1', kind: 'llm', promptId: 'prompt-1'},
  {id: 'llm:model-1:1100:prompt-2', kind: 'llm', promptId: 'prompt-2'},
  {id: 'human:prompt-1', kind: 'human', promptId: 'prompt-1'},
] satisfies ComparisonProjectDifferenceColumn[]

const articles = [
  {
    articleCreatedAt: new Date('2026-04-01T00:00:00.000Z'),
    articleSummary: 'Article 1 summary',
    articleTitle: 'Article 1',
    id: 'article-1',
  },
  {
    articleCreatedAt: new Date('2026-04-02T00:00:00.000Z'),
    articleSummary: 'Article 2 summary',
    articleTitle: 'Article 2',
    id: 'article-2',
  },
  {
    articleCreatedAt: new Date('2026-04-03T00:00:00.000Z'),
    articleSummary: 'Article 3 summary',
    articleTitle: 'Article 3',
    id: 'article-3',
  },
] satisfies ComparisonProjectScopedArticle[]

const getLlmRow = (params: {
  answer: string | null
  articleId: string
  modelId?: string
  promptId: string
}): ComparisonProjectJudgmentLlmRow => {
  return {
    answeredOriginal: params.answer,
    answeredOriginalAsArray: null,
    articleId: params.articleId,
    createdAt: new Date('2026-04-04T00:00:00.000Z'),
    modelId: params.modelId ?? 'model-1',
    promptId: params.promptId,
    sourceProjectId: null,
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  }
}

const getEncodedServingCursor = (cursor: {articleId: string; createdAt: string | null; title: string}) => {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

const getDecodedServingCursor = (cursor: string | null) => {
  return cursor ? (JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown) : null
}

test('scoped article batch sql selects stable article context with limit and offset', () => {
  const sql = getComparisonProjectScopedArticleBatchSql({
    articleTable: 'app.article',
    limit: 25,
    offset: 50,
    whereClause: 'WHERE TRUE',
  })

  expect(sql).toContain('article_title AS articleTitle')
  expect(sql).toContain('article_summary AS articleSummary')
  expect(sql).toContain('article_created_at AS articleCreatedAt')
  expect(sql).toContain('ORDER BY a.article_created_at DESC, a.article_title ASC, a.id ASC')
  expect(sql).toContain('LIMIT 25')
  expect(sql).toContain('OFFSET 50')
})

test('batch cell assembly preserves shared row shape and row-filter semantics', () => {
  const rows = getComparisonProjectBatchRows({
    articles,
    columns,
    differenceFilter: 'all',
    humanRows: [
      {answer: 'yes', articleId: 'article-1', promptId: 'prompt-1', updatedAt: new Date('2026-04-05T00:00:00.000Z')},
    ],
    isSummaryMode: false,
    llmRows: [
      getLlmRow({answer: 'yes', articleId: 'article-1', promptId: 'prompt-1'}),
      getLlmRow({answer: 'no', articleId: 'article-1', promptId: 'prompt-2'}),
      getLlmRow({answer: 'yes', articleId: 'article-2', promptId: 'prompt-1'}),
    ],
    requiredHumanColumnIds: new Set(['human:prompt-1']),
    requiredLlmColumnIds: new Set(['llm:model-1:1100:prompt-1', 'llm:model-1:1100:prompt-2']),
    rowFilter: 'multiple-answers',
  })

  expect(rows).toEqual([
    {
      articleCreatedAt: new Date('2026-04-01T00:00:00.000Z'),
      articleExternalId: null,
      articleSummary: 'Article 1 summary',
      articleTitle: 'Article 1',
      canonicalArticleId: 'article-1',
      cells: {'human:prompt-1': 'yes', 'llm:model-1:1100:prompt-1': 'yes', 'llm:model-1:1100:prompt-2': 'no'},
      hasConflict: false,
      id: 'article-1',
    },
  ])
})

test('batch cell assembly uses latest human answer and normalized llm array values', () => {
  const cellsByArticle = getComparisonProjectBatchCellsByArticle({
    humanRows: [
      {answer: 'yes', articleId: 'article-1', promptId: 'prompt-1', updatedAt: new Date('2026-04-05T00:00:00.000Z')},
      {answer: 'no', articleId: 'article-1', promptId: 'prompt-1', updatedAt: new Date('2026-04-06T00:00:00.000Z')},
    ],
    llmRows: [
      {
        ...getLlmRow({answer: null, articleId: 'article-1', promptId: 'prompt-1'}),
        answeredOriginalAsArray: [' beta ', 'alpha'],
      },
    ],
  })

  expect(cellsByArticle.humanCellsByArticle['article-1']?.['human:prompt-1']).toBe('no')
  expect(cellsByArticle.llmCellsByArticle['article-1']?.['llm:model-1:1100:prompt-1']).toBe('beta\nalpha')
})

test('row batch iterator yields filtered rows by scoped article batch', async () => {
  const articleBatches = new Map<number, ComparisonProjectScopedArticle[]>([
    [0, articles.slice(0, 2)],
    [2, articles.slice(2)],
  ])
  const offsets: number[] = []
  const yieldedRowIds: string[][] = []

  await forEachComparisonProjectJudgmentRowBatch({
    articleBatchSize: 2,
    columns,
    differenceFilter: 'all',
    isSummaryMode: false,
    loadHumanRows: async () => {
      return []
    },
    loadLlmRows: async (articleIds) => {
      return articleIds.flatMap((articleId) => {
        return articleId === 'article-2'
          ? [getLlmRow({answer: 'yes', articleId, promptId: 'prompt-1'})]
          : [
              getLlmRow({answer: 'yes', articleId, promptId: 'prompt-1'}),
              getLlmRow({answer: 'no', articleId, promptId: 'prompt-2'}),
            ]
      })
    },
    loadScopedArticles: async ({limit, offset}) => {
      offsets.push(offset)
      expect(limit).toBe(2)
      return articleBatches.get(offset) ?? []
    },
    onRows: (rows) => {
      yieldedRowIds.push(
        rows.map((row) => {
          return row.id
        }),
      )
    },
    rowFilter: 'multiple-answers',
  })

  expect(offsets).toEqual([0, 2])
  expect(yieldedRowIds).toEqual([['article-1'], ['article-3']])
})

test('serving member sql resolves active generation and pages by keyset cursor', () => {
  const cursor = getEncodedServingCursor({
    articleId: 'article-4',
    createdAt: '2026-04-04T00:00:00.000Z',
    title: 'Article 4',
  })
  const sql = getComparisonProjectServingMemberSql({
    comparisonProjectId: 'comparison-project-1',
    cursor,
    differenceFilter: 'llm-vs-llm',
    limit: 25,
    rowFilter: 'fully-answered',
  })

  expect(sql).toContain('FROM app.comparison_project_serving_generation')
  expect(sql).toContain('FROM mart.comparison_article_serving article')
  expect(sql).toContain("comparison_project_id = 'comparison-project-1'")
  expect(sql).toContain('article.passes_row_filter_fully_answered')
  expect(sql).toContain('article.passes_difference_filter_llm_vs_llm')
  expect(sql).toContain("article.row_sort_created_at < TIMESTAMPTZ '2026-04-04T00:00:00.000Z'")
  expect(sql).toContain("article.row_sort_title > 'Article 4'")
  expect(sql).toContain('ORDER BY article.row_sort_created_at DESC NULLS LAST, article.row_sort_title ASC')
  expect(sql).toContain('LIMIT 26')
})

test('serving hydration sql scopes articles and cells to returned article ids', () => {
  const articleSql = getComparisonProjectServingArticlesSql({
    articleIds: ['article-1', 'article-2'],
    comparisonProjectId: 'comparison-project-1',
    generation: 3,
  })
  const cellSql = getComparisonProjectServingCellsSql({
    articleIds: ['article-1', 'article-2'],
    comparisonProjectId: 'comparison-project-1',
    generation: 3,
  })

  expect(articleSql).toContain('FROM mart.comparison_article_serving article')
  expect(articleSql).toContain('article.article_id AS canonicalArticleId')
  expect(articleSql).toContain('article.article_external_id AS articleExternalId')
  expect(articleSql).toContain("article.article_id IN ('article-1', 'article-2')")
  expect(cellSql).toContain('FROM mart.comparison_cell_serving cell')
  expect(cellSql).toContain("cell.article_id IN ('article-1', 'article-2')")
})

test('serving judgment count sql reads active generation filter stats only', () => {
  const sql = getComparisonProjectServingJudgmentCountSql({
    comparisonProjectId: 'comparison-project-1',
    differenceFilter: 'human-vs-llm',
    rowFilter: 'multiple-answers',
  })

  expect(sql).toContain('FROM app.comparison_project_serving_generation')
  expect(sql).toContain('FROM mart.comparison_filter_stats stats')
  expect(sql).toContain('stats.total_count')
  expect(sql).toContain("stats.row_filter = 'multiple-answers'")
  expect(sql).toContain("stats.difference_filter = 'human-vs-llm'")
  expect(sql).not.toContain('comparison_filter_member')
  expect(sql).not.toContain('comparison_cell_serving')
  expect(sql).not.toContain('comparison_article_serving')
})

test('serving judgment count returns pages from stats and zero for missing stats', async () => {
  const statements: string[] = []
  const count = await getComparisonProjectServingJudgmentCount({
    comparisonProjectId: 'comparison-project-1',
    differenceFilter: 'all',
    limit: 25,
    queryRunner: {
      queryJson: async <T>(statement: string): Promise<T[]> => {
        statements.push(statement)

        return [{totalCount: 51}] as T[]
      },
    },
    rowFilter: 'all',
  })
  const missingCount = await getComparisonProjectServingJudgmentCount({
    comparisonProjectId: 'comparison-project-1',
    differenceFilter: 'all',
    limit: 25,
    queryRunner: {
      queryJson: async <T>(): Promise<T[]> => {
        return []
      },
    },
    rowFilter: 'all',
  })

  expect(count).toEqual({totalCount: 51, totalPages: 3})
  expect(missingCount).toEqual({totalCount: 0, totalPages: 0})
  expect(statements[0]).toContain('FROM mart.comparison_filter_stats stats')
})

test('serving judgment rows return next cursor and hydrate page rows only', async () => {
  const statements: string[] = []
  const page = await getComparisonProjectServingJudgmentRowsPage({
    comparisonProjectId: 'comparison-project-1',
    cursor: null,
    differenceFilter: 'all',
    limit: 2,
    queryRunner: {
      queryJson: async <T>(statement: string): Promise<T[]> => {
        statements.push(statement)

        return statement.includes('article.row_sort_created_at AS rowSortCreatedAt')
          ? ([
              {
                articleId: 'article-1',
                generation: 1,
                rowSortArticleId: 'article-1',
                rowSortCreatedAt: new Date('2026-04-03T00:00:00.000Z'),
                rowSortTitle: 'Article 1',
              },
              {
                articleId: 'article-2',
                generation: 1,
                rowSortArticleId: 'article-2',
                rowSortCreatedAt: new Date('2026-04-02T00:00:00.000Z'),
                rowSortTitle: 'Article 2',
              },
              {
                articleId: 'article-3',
                generation: 1,
                rowSortArticleId: 'article-3',
                rowSortCreatedAt: new Date('2026-04-01T00:00:00.000Z'),
                rowSortTitle: 'Article 3',
              },
            ] as T[])
          : statement.includes('FROM mart.comparison_article_serving')
            ? ([
                {
                  articleCreatedAt: new Date('2026-04-01T00:00:00.000Z'),
                  articleExternalId: 'external-1',
                  articleId: 'article-1',
                  articleSummary: 'Article 1 summary',
                  articleTitle: 'Article 1',
                  canonicalArticleId: 'article-1',
                  hasConflict: true,
                },
                {
                  articleCreatedAt: new Date('2026-04-02T00:00:00.000Z'),
                  articleExternalId: 'external-2',
                  articleId: 'article-2',
                  articleSummary: 'Article 2 summary',
                  articleTitle: 'Article 2',
                  canonicalArticleId: 'article-2',
                  hasConflict: false,
                },
              ] as T[])
            : ([
                {articleId: 'article-1', columnId: 'llm:model-1:1100:prompt-1', displayAnswer: 'yes'},
                {articleId: 'article-2', columnId: 'llm:model-1:1100:prompt-1', displayAnswer: 'no'},
              ] as T[])
      },
    },
    rowFilter: 'all',
  })

  expect(getDecodedServingCursor(page.nextCursor)).toEqual({
    articleId: 'article-2',
    createdAt: '2026-04-02T00:00:00.000Z',
    title: 'Article 2',
  })
  expect(page.rows).toEqual([
    {
      articleCreatedAt: new Date('2026-04-01T00:00:00.000Z'),
      articleExternalId: 'external-1',
      articleSummary: 'Article 1 summary',
      articleTitle: 'Article 1',
      canonicalArticleId: 'article-1',
      cells: {'llm:model-1:1100:prompt-1': 'yes'},
      hasConflict: true,
      id: 'article-1',
    },
    {
      articleCreatedAt: new Date('2026-04-02T00:00:00.000Z'),
      articleExternalId: 'external-2',
      articleSummary: 'Article 2 summary',
      articleTitle: 'Article 2',
      canonicalArticleId: 'article-2',
      cells: {'llm:model-1:1100:prompt-1': 'no'},
      hasConflict: false,
      id: 'article-2',
    },
  ])
  expect(statements[1]).toContain("article.article_id IN ('article-1', 'article-2')")
  expect(statements[2]).toContain("cell.article_id IN ('article-1', 'article-2')")
})

test('serving row batch iterator walks article-serving rows by keyset cursor', async () => {
  const statements: string[] = []
  const yieldedRowIds: string[][] = []

  await forEachComparisonProjectServingJudgmentRowBatch({
    comparisonProjectId: 'comparison-project-1',
    differenceFilter: 'llm-vs-llm',
    limit: 2,
    onRows: (rows) => {
      yieldedRowIds.push(
        rows.map((row) => {
          return row.id
        }),
      )
    },
    queryRunner: {
      queryJson: async <T>(statement: string): Promise<T[]> => {
        statements.push(statement)

        return statement.includes('article.row_sort_created_at AS rowSortCreatedAt')
          && !statement.includes("article.row_sort_created_at < TIMESTAMPTZ '2026-04-02T00:00:00.000Z'")
          ? ([
              {
                articleId: 'article-1',
                generation: 1,
                rowSortArticleId: 'article-1',
                rowSortCreatedAt: new Date('2026-04-03T00:00:00.000Z'),
                rowSortTitle: 'article-1',
              },
              {
                articleId: 'article-2',
                generation: 1,
                rowSortArticleId: 'article-2',
                rowSortCreatedAt: new Date('2026-04-02T00:00:00.000Z'),
                rowSortTitle: 'article-2',
              },
              {
                articleId: 'article-3',
                generation: 1,
                rowSortArticleId: 'article-3',
                rowSortCreatedAt: new Date('2026-04-01T00:00:00.000Z'),
                rowSortTitle: 'article-3',
              },
            ] as T[])
          : statement.includes('article.row_sort_created_at AS rowSortCreatedAt')
            ? ([
                {
                  articleId: 'article-3',
                  generation: 1,
                  rowSortArticleId: 'article-3',
                  rowSortCreatedAt: new Date('2026-04-01T00:00:00.000Z'),
                  rowSortTitle: 'article-3',
                },
              ] as T[])
            : statement.includes('FROM mart.comparison_article_serving')
              ? (['article-1', 'article-2', 'article-3']
                  .filter((articleId) => {
                    return statement.includes(`'${articleId}'`)
                  })
                  .map((articleId) => {
                    return {
                      articleCreatedAt: new Date('2026-04-01T00:00:00.000Z'),
                      articleExternalId: `external-${articleId}`,
                      articleId,
                      articleSummary: `${articleId} summary`,
                      articleTitle: articleId,
                      canonicalArticleId: articleId,
                      hasConflict: false,
                    }
                  }) as T[])
              : (['article-1', 'article-2', 'article-3']
                  .filter((articleId) => {
                    return statement.includes(`'${articleId}'`)
                  })
                  .map((articleId) => {
                    return {articleId, columnId: 'llm:model-1:1100:prompt-1', displayAnswer: 'yes'}
                  }) as T[])
      },
    },
    rowFilter: 'fully-answered',
  })

  expect(yieldedRowIds).toEqual([['article-1', 'article-2'], ['article-3']])
  expect(
    statements.some((statement) => {
      return (
        statement.includes('FROM mart.comparison_article_serving article')
        && statement.includes('article.passes_row_filter_fully_answered')
        && statement.includes('article.passes_difference_filter_llm_vs_llm')
      )
    }),
  ).toBe(true)
  expect(
    statements.some((statement) => {
      return (
        statement.includes('FROM mart.comparison_article_serving article')
        && statement.includes("article.row_sort_created_at < TIMESTAMPTZ '2026-04-02T00:00:00.000Z'")
      )
    }),
  ).toBe(true)
  expect(
    statements.some((statement) => {
      return (
        statement.includes('FROM mart.comparison_article_serving article')
        && statement.includes("article.article_id IN ('article-1', 'article-2')")
      )
    }),
  ).toBe(true)
  expect(
    statements.some((statement) => {
      return (
        statement.includes('FROM mart.comparison_cell_serving cell')
        && statement.includes("cell.article_id IN ('article-3')")
      )
    }),
  ).toBe(true)
})

test('serving judgment rows return empty page when active generation is missing', async () => {
  const statements: string[] = []
  const page = await getComparisonProjectServingJudgmentRowsPage({
    comparisonProjectId: 'comparison-project-1',
    cursor: null,
    differenceFilter: 'all',
    limit: 50,
    queryRunner: {
      queryJson: async <T>(statement: string): Promise<T[]> => {
        statements.push(statement)

        return []
      },
    },
    rowFilter: 'all',
  })

  expect(page).toEqual({nextCursor: null, rows: []})
  expect(statements).toHaveLength(1)
  expect(statements[0]).toContain('FROM mart.comparison_article_serving article')
  expect(statements[0]).not.toContain('FROM app.article')
  expect(statements[0]).not.toContain('FROM app.judgment')
})
