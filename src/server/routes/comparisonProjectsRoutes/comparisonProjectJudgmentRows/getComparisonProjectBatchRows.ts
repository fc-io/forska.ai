import {
  type ComparisonProjectDifferenceColumn,
  type ComparisonProjectDifferenceFilter,
  getComparisonProjectHasAnyConflict,
  getComparisonProjectHasDifferenceFilterMatch,
} from '../../../../utils/comparisonProjectDifferenceFilter.ts'
import {
  type ComparisonProjectRowFilter,
  getComparisonProjectPassesRowFilter,
} from '../../../../utils/comparisonProjectRowFilter.ts'
import {hasAnyJudgmentAnswer} from '../../../utils/judgmentAnswers.ts'
import type {
  ComparisonProjectJudgmentHumanRow,
  ComparisonProjectJudgmentLlmRow,
  ComparisonProjectJudgmentRow,
  ComparisonProjectScopedArticle,
} from './comparisonProjectJudgmentRowsTypes.ts'
import {isDefined} from './comparisonProjectJudgmentRowsUtils.ts'
import {getComparisonProjectBatchCellsByArticle} from './getComparisonProjectBatchRows/getComparisonProjectBatchCellsByArticle.ts'

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

const hasValue = (value: string | null | undefined) => {
  return (value?.trim() ?? '') !== ''
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

const getHasAllRequiredColumns = (
  cellMap: Record<string, string | null> | undefined,
  requiredColumnIds: ReadonlySet<string>,
) => {
  return Array.from(requiredColumnIds).every((columnId) => {
    return hasValue(cellMap?.[columnId])
  })
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
        cells: articleCells,
        columns: params.columns,
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
            articleExternalId: article.articleExternalId ?? null,
            articleTitle: article.articleTitle,
            articleSummary: article.articleSummary,
            articleCreatedAt: article.articleCreatedAt,
            canonicalArticleId: article.canonicalArticleId ?? article.id,
            cells: articleCells,
            hasConflict: getComparisonProjectHasAnyConflict(articleCells, params.columns),
            id: article.canonicalArticleId ?? article.id,
          }
        : null
    })
    .filter(isDefined)
}
