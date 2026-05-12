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
import {getDateValue, getQuotedStringList, getSqlLiteral} from '../../services/appQueryHelpers.ts'
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

type ComparisonProjectServingMemberRow = {articleId: string; generation: unknown; ordinal: unknown}

type ComparisonProjectServingArticleRow = {
  articleCreatedAt: unknown
  articleId: string
  articleSummary: string | null
  articleTitle: string | null
  hasConflict: boolean
}

type ComparisonProjectServingCellRow = {articleId: string; columnId: string; displayAnswer: string | null}

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

type ComparisonProjectServingJudgmentRowsParams = {
  comparisonProjectId: string
  cursor?: string | null
  differenceFilter: ComparisonProjectDifferenceFilter
  limit: number
  queryRunner: ComparisonProjectScopedArticleQueryRunner
  rowFilter: ComparisonProjectRowFilter
}

type ForEachComparisonProjectServingJudgmentRowBatchParams = ComparisonProjectServingJudgmentRowsParams & {
  onRows: (rows: ComparisonProjectJudgmentRow[]) => Promise<void> | void
}

type ComparisonProjectServingJudgmentCountParams = {
  comparisonProjectId: string
  differenceFilter: ComparisonProjectDifferenceFilter
  limit: number
  queryRunner: ComparisonProjectScopedArticleQueryRunner
  rowFilter: ComparisonProjectRowFilter
}

export type ComparisonProjectServingJudgmentRowsPage = {nextCursor: string | null; rows: ComparisonProjectJudgmentRow[]}
export type ComparisonProjectServingJudgmentCount = {totalCount: number; totalPages: number}

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

const getComparisonProjectServingCursorOrdinal = (cursor: string | null | undefined) => {
  const parsedCursor = Number.parseInt(cursor ?? '', 10)

  return Number.isSafeInteger(parsedCursor) && parsedCursor >= 0 ? parsedCursor : null
}

const getComparisonProjectServingOrdinal = (value: unknown) => {
  const parsedOrdinal = typeof value === 'bigint' ? Number(value) : Number(value)

  return Number.isSafeInteger(parsedOrdinal) && parsedOrdinal >= 0 ? parsedOrdinal : null
}

const getComparisonProjectServingGeneration = (value: unknown) => {
  const parsedGeneration = typeof value === 'bigint' ? Number(value) : Number(value)

  return Number.isSafeInteger(parsedGeneration) && parsedGeneration > 0 ? parsedGeneration : null
}

const getComparisonProjectServingCount = (value: unknown) => {
  const parsedCount = typeof value === 'bigint' ? Number(value) : Number(value)

  return Number.isSafeInteger(parsedCount) && parsedCount >= 0 ? parsedCount : 0
}

const getInClause = (values: string[]) => {
  return getQuotedStringList(values).join(', ')
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

export const getComparisonProjectServingMemberSql = (params: {
  comparisonProjectId: string
  cursor?: string | null
  differenceFilter: ComparisonProjectDifferenceFilter
  limit: number
  rowFilter: ComparisonProjectRowFilter
}) => {
  const cursorOrdinal = getComparisonProjectServingCursorOrdinal(params.cursor)
  const limit = getPositiveInteger(params.limit)

  return `
    WITH active_generation AS (
      SELECT active_generation AS generation
      FROM app.comparison_project_serving_generation
      WHERE comparison_project_id = ${getSqlLiteral(params.comparisonProjectId)}
        AND active_generation > 0
    )
    SELECT
      member.article_id AS articleId,
      member.generation AS generation,
      member.ordinal AS ordinal
    FROM mart.comparison_filter_member member
    INNER JOIN active_generation active ON active.generation = member.generation
    WHERE member.comparison_project_id = ${getSqlLiteral(params.comparisonProjectId)}
      AND member.row_filter = ${getSqlLiteral(params.rowFilter)}
      AND member.difference_filter = ${getSqlLiteral(params.differenceFilter)}
      ${cursorOrdinal === null ? '' : `AND member.ordinal > ${getSqlLiteral(cursorOrdinal)}`}
    ORDER BY member.ordinal ASC
    LIMIT ${limit + 1}
  `
}

export const getComparisonProjectServingArticlesSql = (params: {
  articleIds: string[]
  comparisonProjectId: string
  generation: number
}) => {
  return `
    SELECT
      article.article_id AS articleId,
      article.article_title AS articleTitle,
      article.article_summary AS articleSummary,
      article.article_created_at AS articleCreatedAt,
      article.has_conflict AS hasConflict
    FROM mart.comparison_article_serving article
    WHERE article.comparison_project_id = ${getSqlLiteral(params.comparisonProjectId)}
      AND article.generation = ${getSqlLiteral(params.generation)}
      AND article.article_id IN (${getInClause(params.articleIds)})
  `
}

export const getComparisonProjectServingCellsSql = (params: {
  articleIds: string[]
  comparisonProjectId: string
  generation: number
}) => {
  return `
    SELECT
      cell.article_id AS articleId,
      cell.column_id AS columnId,
      cell.display_answer AS displayAnswer
    FROM mart.comparison_cell_serving cell
    WHERE cell.comparison_project_id = ${getSqlLiteral(params.comparisonProjectId)}
      AND cell.generation = ${getSqlLiteral(params.generation)}
      AND cell.article_id IN (${getInClause(params.articleIds)})
    ORDER BY cell.article_id ASC, cell.column_order ASC, cell.column_id ASC
  `
}

export const getComparisonProjectServingJudgmentCountSql = (params: {
  comparisonProjectId: string
  differenceFilter: ComparisonProjectDifferenceFilter
  rowFilter: ComparisonProjectRowFilter
}) => {
  return `
    WITH active_generation AS (
      SELECT active_generation AS generation
      FROM app.comparison_project_serving_generation
      WHERE comparison_project_id = ${getSqlLiteral(params.comparisonProjectId)}
        AND active_generation > 0
    )
    SELECT stats.total_count AS totalCount
    FROM mart.comparison_filter_stats stats
    INNER JOIN active_generation active ON active.generation = stats.generation
    WHERE stats.comparison_project_id = ${getSqlLiteral(params.comparisonProjectId)}
      AND stats.row_filter = ${getSqlLiteral(params.rowFilter)}
      AND stats.difference_filter = ${getSqlLiteral(params.differenceFilter)}
    LIMIT 1
  `
}

const getComparisonProjectServingCellsByArticle = (cellRows: readonly ComparisonProjectServingCellRow[]) => {
  return cellRows.reduce<Record<string, Record<string, string | null>>>((articleMap, cellRow) => {
    const articleCells = articleMap[cellRow.articleId] ?? {}

    return {...articleMap, [cellRow.articleId]: {...articleCells, [cellRow.columnId]: cellRow.displayAnswer}}
  }, {})
}

const getComparisonProjectServingArticleRowsById = (articleRows: readonly ComparisonProjectServingArticleRow[]) => {
  return articleRows.reduce<Map<string, ComparisonProjectServingArticleRow>>((articleMap, articleRow) => {
    articleMap.set(articleRow.articleId, articleRow)
    return articleMap
  }, new Map<string, ComparisonProjectServingArticleRow>())
}

const getComparisonProjectServingJudgmentRows = (params: {
  articleRows: readonly ComparisonProjectServingArticleRow[]
  cellRows: readonly ComparisonProjectServingCellRow[]
  memberRows: readonly ComparisonProjectServingMemberRow[]
}) => {
  const articlesById = getComparisonProjectServingArticleRowsById(params.articleRows)
  const cellsByArticle = getComparisonProjectServingCellsByArticle(params.cellRows)

  return params.memberRows
    .map<ComparisonProjectJudgmentRow | null>((memberRow) => {
      const articleRow = articlesById.get(memberRow.articleId)

      return articleRow
        ? {
            articleCreatedAt: getDateValue(articleRow.articleCreatedAt),
            articleSummary: articleRow.articleSummary,
            articleTitle: articleRow.articleTitle,
            cells: cellsByArticle[memberRow.articleId] ?? {},
            hasConflict: articleRow.hasConflict,
            id: memberRow.articleId,
          }
        : null
    })
    .filter(isDefined)
}

export const getComparisonProjectServingJudgmentCount = async (
  params: ComparisonProjectServingJudgmentCountParams,
): Promise<ComparisonProjectServingJudgmentCount> => {
  const limit = getPositiveInteger(params.limit)
  const [row] = await params.queryRunner.queryJson<{totalCount: unknown}>(
    getComparisonProjectServingJudgmentCountSql(params),
  )
  const totalCount = getComparisonProjectServingCount(row?.totalCount)

  return {totalCount, totalPages: totalCount > 0 ? Math.ceil(totalCount / limit) : 0}
}

export const getComparisonProjectServingJudgmentRowsPage = async (
  params: ComparisonProjectServingJudgmentRowsParams,
): Promise<ComparisonProjectServingJudgmentRowsPage> => {
  const limit = getPositiveInteger(params.limit)
  const memberRows = await params.queryRunner.queryJson<ComparisonProjectServingMemberRow>(
    getComparisonProjectServingMemberSql({...params, limit}),
  )
  const hasMore = memberRows.length > limit
  const pageMemberRows = memberRows.slice(0, limit)
  const generation = getComparisonProjectServingGeneration(pageMemberRows[0]?.generation)
  const lastPageMemberRow = pageMemberRows[pageMemberRows.length - 1]
  const nextOrdinal = getComparisonProjectServingOrdinal(lastPageMemberRow?.ordinal)
  const articleIds = pageMemberRows.map((row) => {
    return row.articleId
  })

  if (articleIds.length === 0 || generation === null) {
    return {nextCursor: null, rows: []}
  }

  const [articleRows, cellRows] = await Promise.all([
    params.queryRunner.queryJson<ComparisonProjectServingArticleRow>(
      getComparisonProjectServingArticlesSql({articleIds, comparisonProjectId: params.comparisonProjectId, generation}),
    ),
    params.queryRunner.queryJson<ComparisonProjectServingCellRow>(
      getComparisonProjectServingCellsSql({articleIds, comparisonProjectId: params.comparisonProjectId, generation}),
    ),
  ])

  return {
    nextCursor: hasMore && nextOrdinal !== null ? String(nextOrdinal) : null,
    rows: getComparisonProjectServingJudgmentRows({articleRows, cellRows, memberRows: pageMemberRows}),
  }
}

export const forEachComparisonProjectServingJudgmentRowBatch = async (
  params: ForEachComparisonProjectServingJudgmentRowBatchParams,
  cursor: string | null = null,
): Promise<void> => {
  const pageResult = await getComparisonProjectServingJudgmentRowsPage({...params, cursor})
  const rowsResult = pageResult.rows.length > 0 ? params.onRows(pageResult.rows) : undefined

  await rowsResult

  return pageResult.nextCursor
    ? forEachComparisonProjectServingJudgmentRowBatch(params, pageResult.nextCursor)
    : undefined
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
