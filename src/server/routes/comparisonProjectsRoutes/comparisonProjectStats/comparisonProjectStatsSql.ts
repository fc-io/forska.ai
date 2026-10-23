import {getQuotedStringList} from '../../../services/appQueryHelpers.ts'

export const comparisonProjectConflictResolutionTable = 'app.comparison_project_conflict_resolution'

export const getInClause = (values: readonly string[]) => {
  return getQuotedStringList([...values]).join(', ')
}

export const getComparisonProjectStatsArticleCategorySql = (expression: string) => {
  return `CASE WHEN ${expression} = 'chinese' THEN 'chinese' ELSE 'non_chinese' END`
}
