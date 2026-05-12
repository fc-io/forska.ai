import {expect, test} from 'bun:test'

import type {ComparisonProjectDifferenceColumn} from '../../../utils/comparisonProjectDifferenceFilter.ts'
import {
  type ComparisonProjectJudgmentLlmRow,
  type ComparisonProjectScopedArticle,
  forEachComparisonProjectJudgmentRowBatch,
  getComparisonProjectBatchCellsByArticle,
  getComparisonProjectBatchRows,
  getComparisonProjectScopedArticleBatchSql,
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
      articleSummary: 'Article 1 summary',
      articleTitle: 'Article 1',
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
