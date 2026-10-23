import {getSqlLiteral} from '../../../services/appQueryHelpers.ts'
import {getInClause} from './comparisonProjectJudgmentRowsUtils.ts'

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
