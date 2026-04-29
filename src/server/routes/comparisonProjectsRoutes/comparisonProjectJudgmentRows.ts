import {
  type ComparisonProjectDifferenceColumn,
  type ComparisonProjectDifferenceFilter,
  getComparisonProjectHasAnyConflict,
  getComparisonProjectHasDifferenceFilterMatch,
} from '../../../utils/comparisonProjectDifferenceFilter.ts'
import {
  type ComparisonProjectRowFilter,
  getComparisonProjectPassesRowFilter,
} from '../../../utils/comparisonProjectRowFilter.ts'
import {getDateValue} from '../../services/appQueryHelpers.ts'
import {getJudgmentDisplayAnswer, hasAnyJudgmentAnswer} from '../../utils/judgmentAnswers.ts'

export type ComparisonProjectScopedArticle = {
  id: string
  articleTitle: string | null
  articleSummary: string | null
  articleCreatedAt: Date | null
}

export type ComparisonProjectJudgmentLlmRow = {
  articleId: string
  createdAt: Date
  promptId: string
  modelId: string
  sourceProjectId: string | null
  answeredOriginal: string | null
  answeredOriginalAsArray: string[] | null
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
}

export type ComparisonProjectJudgmentHumanRow = {
  articleId: string
  promptId: string
  answer: string | null
  updatedAt: Date | null
}

export type ComparisonProjectJudgmentRow = {
  id: string
  articleTitle: string | null
  articleSummary: string | null
  articleCreatedAt: Date | null
  cells: Record<string, string | null>
  hasConflict: boolean
}

export type ComparisonProjectScopedArticleBatchRequest = {limit: number; offset: number}

type ComparisonProjectScopedArticleRow = Omit<ComparisonProjectScopedArticle, 'articleCreatedAt'> & {
  articleCreatedAt: unknown
}

type ComparisonProjectScopedArticleQueryRunner = {queryJson: <T>(statement: string) => Promise<T[]>}

type ComparisonProjectBatchCellsByArticle = {
  humanCellsByArticle: Record<string, Record<string, string | null>>
  llmCellsByArticle: Record<string, Record<string, string | null>>
}

type ComparisonProjectBatchRowsParams = {
  articles: readonly ComparisonProjectScopedArticle[]
  columns: readonly ComparisonProjectDifferenceColumn[]
  differenceFilter: ComparisonProjectDifferenceFilter
  humanRows: readonly ComparisonProjectJudgmentHumanRow[]
  isSummaryMode: boolean
  llmRows: readonly ComparisonProjectJudgmentLlmRow[]
  requiredHumanColumnIds: ReadonlySet<string>
  requiredLlmColumnIds: ReadonlySet<string>
  rowFilter: ComparisonProjectRowFilter
}

type ForEachComparisonProjectJudgmentRowBatchParams = {
  articleBatchSize: number
  columns: readonly ComparisonProjectDifferenceColumn[]
  differenceFilter: ComparisonProjectDifferenceFilter
  isSummaryMode: boolean
  loadHumanRows: (articleIds: string[]) => Promise<readonly ComparisonProjectJudgmentHumanRow[]>
  loadLlmRows: (articleIds: string[]) => Promise<readonly ComparisonProjectJudgmentLlmRow[]>
  loadScopedArticles: (
    request: ComparisonProjectScopedArticleBatchRequest,
  ) => Promise<readonly ComparisonProjectScopedArticle[]>
  onRows: (rows: ComparisonProjectJudgmentRow[]) => Promise<void> | void
  rowFilter: ComparisonProjectRowFilter
}

export const getComparisonProjectContentKey = (settings: {
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
}) => {
  return [settings.useTitle, settings.useAbstract, settings.useFulltext, settings.useFulltextNoImages]
    .map((value) => {
      return (value ? 1 : 0).toString()
    })
    .join('')
}

export const getComparisonProjectColumnId = (
  kind: 'llm' | 'human',
  promptId: string,
  modelId?: string | null,
  contentKey?: string | null,
  sourceProjectId?: string | null,
) => {
  return kind === 'human'
    ? `human:${promptId}`
    : sourceProjectId
      ? `llm:${sourceProjectId}:${modelId}:${contentKey ?? 'default'}:${promptId}`
      : `llm:${modelId}:${contentKey ?? 'default'}:${promptId}`
}

const isDefined = <T>(value: T | null | undefined): value is T => {
  return value !== null && value !== undefined
}

const hasValue = (value: string | null | undefined) => {
  return (value?.trim() ?? '') !== ''
}

const getPositiveInteger = (value: number) => {
  const integerValue = Number.isFinite(value) ? Math.floor(value) : 1
  return Math.max(integerValue, 1)
}

const getNonNegativeInteger = (value: number) => {
  const integerValue = Number.isFinite(value) ? Math.floor(value) : 0
  return Math.max(integerValue, 0)
}

const getRowsByArticleId = <T extends {articleId: string}>(rows: readonly T[]) => {
  return rows.reduce<Map<string, T[]>>((rowMap, row) => {
    const currentRows = rowMap.get(row.articleId) ?? []
    currentRows.push(row)
    rowMap.set(row.articleId, currentRows)
    return rowMap
  }, new Map<string, T[]>())
}

const getComparisonProjectAnsweredPromptIds = (
  llmRows: readonly ComparisonProjectJudgmentLlmRow[],
  humanRows: readonly ComparisonProjectJudgmentHumanRow[],
) => {
  const llmPromptIds = llmRows
    .filter((row) => {
      return hasAnyJudgmentAnswer(row)
    })
    .map((row) => {
      return row.promptId
    })
  const humanPromptIds = humanRows
    .filter((row) => {
      return hasValue(row.answer)
    })
    .map((row) => {
      return row.promptId
    })

  return new Set([...llmPromptIds, ...humanPromptIds])
}

const getComparisonProjectAnsweredColumnCount = (
  llmCells: Record<string, string | null> | undefined,
  humanCells: Record<string, string | null> | undefined,
  columnIds: ReadonlySet<string>,
) => {
  return Array.from(columnIds).filter((columnId) => {
    return hasValue(llmCells?.[columnId]) || hasValue(humanCells?.[columnId])
  }).length
}

export const getComparisonProjectRequiredColumnIds = (
  columns: readonly ComparisonProjectDifferenceColumn[],
  kind: ComparisonProjectDifferenceColumn['kind'],
) => {
  return new Set(
    columns
      .filter((column) => {
        return column.kind === kind
      })
      .map((column) => {
        return column.id
      }),
  )
}

const getHasAllRequiredColumns = (
  cellMap: Record<string, string | null> | undefined,
  requiredColumnIds: ReadonlySet<string>,
) => {
  return Array.from(requiredColumnIds).every((columnId) => {
    return hasValue(cellMap?.[columnId])
  })
}

export const getComparisonProjectScopedArticleBatchSql = (params: {
  articleTable: string
  limit: number
  offset: number
  whereClause: string
}) => {
  const limit = getPositiveInteger(params.limit)
  const offset = getNonNegativeInteger(params.offset)

  return `
      SELECT
        id,
        article_title AS articleTitle,
        article_summary AS articleSummary,
        article_created_at AS articleCreatedAt
      FROM ${params.articleTable} a
      ${params.whereClause}
      ORDER BY a.article_created_at DESC, a.article_title ASC, a.id ASC
      LIMIT ${limit}
      OFFSET ${offset}
    `
}

export const getComparisonProjectScopedArticleBatch = async (params: {
  articleTable: string
  limit: number
  offset: number
  queryRunner: ComparisonProjectScopedArticleQueryRunner
  whereClause: string
}) => {
  const rows = await params.queryRunner.queryJson<ComparisonProjectScopedArticleRow>(
    getComparisonProjectScopedArticleBatchSql(params),
  )

  return rows.map((row) => {
    return {...row, articleCreatedAt: getDateValue(row.articleCreatedAt)}
  })
}

export const getComparisonProjectLlmCells = (rows: readonly ComparisonProjectJudgmentLlmRow[]) => {
  return rows.reduce<Record<string, Record<string, string | null>>>((articleMap, row) => {
    const articleCells = articleMap[row.articleId] ?? {}
    const columnId = getComparisonProjectColumnId(
      'llm',
      row.promptId,
      row.modelId,
      getComparisonProjectContentKey(row),
      row.sourceProjectId,
    )

    return {...articleMap, [row.articleId]: {...articleCells, [columnId]: getJudgmentDisplayAnswer(row)}}
  }, {})
}

export const getComparisonProjectHumanCells = (rows: readonly ComparisonProjectJudgmentHumanRow[]) => {
  const latestRows = rows.reduce<Map<string, ComparisonProjectJudgmentHumanRow>>((rowMap, row) => {
    const key = `${row.articleId}:${row.promptId}`
    const existingRow = rowMap.get(key)

    if (!existingRow || (row.updatedAt?.getTime() ?? 0) > (existingRow.updatedAt?.getTime() ?? 0)) {
      rowMap.set(key, row)
    }

    return rowMap
  }, new Map<string, ComparisonProjectJudgmentHumanRow>())
  const groupedAnswers = Array.from(latestRows.values()).reduce<Record<string, Record<string, string[]>>>(
    (articleMap, row) => {
      const articleCells = articleMap[row.articleId] ?? {}
      const columnId = getComparisonProjectColumnId('human', row.promptId)
      const existingAnswers = articleCells[columnId] ?? []

      return row.answer
        ? {...articleMap, [row.articleId]: {...articleCells, [columnId]: [...existingAnswers, row.answer.trim()]}}
        : articleMap
    },
    {},
  )

  return Object.entries(groupedAnswers).reduce<Record<string, Record<string, string | null>>>(
    (articleMap, [articleId, articleCells]) => {
      const normalizedCells = Object.entries(articleCells).reduce<Record<string, string | null>>(
        (cellMap, [columnId, answers]) => {
          const uniqueAnswers = Array.from(
            new Set(
              answers.filter((answer) => {
                return answer !== ''
              }),
            ),
          ).sort((left, right) => {
            return left.localeCompare(right)
          })

          return {...cellMap, [columnId]: uniqueAnswers.length > 0 ? uniqueAnswers.join('\n') : null}
        },
        {},
      )

      return {...articleMap, [articleId]: normalizedCells}
    },
    {},
  )
}

export const getComparisonProjectBatchCellsByArticle = (params: {
  humanRows: readonly ComparisonProjectJudgmentHumanRow[]
  llmRows: readonly ComparisonProjectJudgmentLlmRow[]
}): ComparisonProjectBatchCellsByArticle => {
  return {
    humanCellsByArticle: getComparisonProjectHumanCells(params.humanRows),
    llmCellsByArticle: getComparisonProjectLlmCells(params.llmRows),
  }
}

export const getComparisonProjectBatchRows = (params: ComparisonProjectBatchRowsParams) => {
  const llmRowsByArticle = getRowsByArticleId(params.llmRows)
  const humanRowsByArticle = getRowsByArticleId(params.humanRows)
  const {llmCellsByArticle, humanCellsByArticle} = getComparisonProjectBatchCellsByArticle(params)
  const requiredColumnIds = new Set([...params.requiredLlmColumnIds, ...params.requiredHumanColumnIds])

  return params.articles
    .map<ComparisonProjectJudgmentRow | null>((article) => {
      const articleLlmRows = llmRowsByArticle.get(article.id) ?? []
      const articleHumanRows = humanRowsByArticle.get(article.id) ?? []
      const articleCells = {...(llmCellsByArticle[article.id] ?? {}), ...(humanCellsByArticle[article.id] ?? {})}
      const hasArticleData = articleLlmRows.length > 0 || articleHumanRows.length > 0
      const answeredPromptIds = getComparisonProjectAnsweredPromptIds(articleLlmRows, articleHumanRows)
      const answeredColumnCount = getComparisonProjectAnsweredColumnCount(
        llmCellsByArticle[article.id],
        humanCellsByArticle[article.id],
        requiredColumnIds,
      )
      const hasAllLlmColumns = getHasAllRequiredColumns(llmCellsByArticle[article.id], params.requiredLlmColumnIds)
      const hasAllHumanColumns = getHasAllRequiredColumns(
        humanCellsByArticle[article.id],
        params.requiredHumanColumnIds,
      )
      const passesRowFilter = getComparisonProjectPassesRowFilter({
        answeredColumnCount,
        answeredPromptCount: answeredPromptIds.size,
        hasAllHumanColumns,
        hasAllLlmColumns,
        isSummaryMode: params.isSummaryMode,
        rowFilter: params.rowFilter,
      })
      const passesDifferenceFilter = getComparisonProjectHasDifferenceFilterMatch(
        articleCells,
        params.columns,
        params.differenceFilter,
      )

      return hasArticleData && passesRowFilter && passesDifferenceFilter
        ? {
            id: article.id,
            articleTitle: article.articleTitle,
            articleSummary: article.articleSummary,
            articleCreatedAt: article.articleCreatedAt,
            cells: articleCells,
            hasConflict: getComparisonProjectHasAnyConflict(articleCells, params.columns),
          }
        : null
    })
    .filter(isDefined)
}

export const forEachComparisonProjectJudgmentRowBatch = async (
  params: ForEachComparisonProjectJudgmentRowBatchParams,
  offset = 0,
): Promise<void> => {
  const limit = getPositiveInteger(params.articleBatchSize)
  const articles = await params.loadScopedArticles({limit, offset})

  if (articles.length === 0) {
    return
  }

  const articleIds = articles.map((article) => {
    return article.id
  })
  const [llmRows, humanRows] = await Promise.all([params.loadLlmRows(articleIds), params.loadHumanRows(articleIds)])
  const rows = getComparisonProjectBatchRows({
    articles,
    columns: params.columns,
    differenceFilter: params.differenceFilter,
    humanRows,
    isSummaryMode: params.isSummaryMode,
    llmRows,
    requiredHumanColumnIds: getComparisonProjectRequiredColumnIds(params.columns, 'human'),
    requiredLlmColumnIds: getComparisonProjectRequiredColumnIds(params.columns, 'llm'),
    rowFilter: params.rowFilter,
  })

  await params.onRows(rows)

  if (articles.length < limit) {
    return
  }

  return forEachComparisonProjectJudgmentRowBatch(params, offset + limit)
}
