import {getDateValue} from '../../../services/appQueryHelpers.ts'
import type {
  ComparisonProjectJudgmentRow,
  ComparisonProjectServingArticleRow,
  ComparisonProjectServingCellRow,
  ComparisonProjectServingMemberRow,
} from './comparisonProjectJudgmentRowsTypes.ts'
import {isDefined} from './comparisonProjectJudgmentRowsUtils.ts'

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

export const getComparisonProjectServingJudgmentRows = (params: {
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
            articleExternalId: articleRow.articleExternalId,
            articleSummary: articleRow.articleSummary,
            articleTitle: articleRow.articleTitle,
            canonicalArticleId: articleRow.canonicalArticleId,
            cells: cellsByArticle[memberRow.articleId] ?? {},
            hasConflict: articleRow.hasConflict,
            id: articleRow.canonicalArticleId,
          }
        : null
    })
    .filter(isDefined)
}
