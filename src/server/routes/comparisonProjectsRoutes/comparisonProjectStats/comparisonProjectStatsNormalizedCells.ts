import {getJsonValue} from '../../../services/appQueryHelpers.ts'
import type {
  ComparisonProjectStatsCellRow,
  ComparisonProjectStatsConflictResolutionRow,
  ComparisonProjectStatsNormalizedCell,
} from './comparisonProjectStatsTypes.ts'

const getTrimmedLowercaseValue = (value: string) => {
  return value.trim().toLowerCase()
}

const getUniqueNormalizedAnswers = (answers: readonly string[]) => {
  return Array.from(
    new Set(
      answers.map(getTrimmedLowercaseValue).filter((answer) => {
        return answer !== ''
      }),
    ),
  )
}

const getNormalizedAnswerValues = (value: unknown) => {
  const jsonValue = getJsonValue(value)

  return Array.isArray(jsonValue)
    ? getUniqueNormalizedAnswers(
        jsonValue.filter((entry): entry is string => {
          return typeof entry === 'string'
        }),
      )
    : []
}

const getComparisonProjectStatsNormalizedCells = (rows: readonly ComparisonProjectStatsCellRow[]) => {
  return rows
    .map<ComparisonProjectStatsNormalizedCell>((row) => {
      return {...row, normalizedAnswers: getNormalizedAnswerValues(row.normalizedAnswers)}
    })
    .filter((row) => {
      return row.normalizedAnswers.length > 0
    })
}

export const getComparisonProjectStatsCellsByColumn = (rows: readonly ComparisonProjectStatsCellRow[]) => {
  return getComparisonProjectStatsNormalizedCells(rows).reduce<
    Map<string, Map<string, ComparisonProjectStatsNormalizedCell>>
  >((columnMap, row) => {
    const articleMap = columnMap.get(row.columnId) ?? new Map<string, ComparisonProjectStatsNormalizedCell>()

    articleMap.set(row.articleId, row)
    columnMap.set(row.columnId, articleMap)
    return columnMap
  }, new Map<string, Map<string, ComparisonProjectStatsNormalizedCell>>())
}

export const getComparisonProjectStatsConflictResolutionAnswersByArticleId = (
  rows: readonly ComparisonProjectStatsConflictResolutionRow[],
) => {
  return rows.reduce<Map<string, string[]>>((answerMap, row) => {
    const normalizedAnswers =
      typeof row.answerValue === 'string'
        ? getUniqueNormalizedAnswers([row.answerValue])
        : getNormalizedAnswerValues(row.answerValue)

    if (normalizedAnswers.length > 0) {
      answerMap.set(row.articleId, normalizedAnswers)
    }

    return answerMap
  }, new Map<string, string[]>())
}
