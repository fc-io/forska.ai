import {getJudgmentDisplayAnswer} from '../../../../utils/judgmentAnswers.ts'
import type {
  ComparisonProjectJudgmentHumanRow,
  ComparisonProjectJudgmentLlmRow,
} from '../comparisonProjectJudgmentRowsTypes.ts'
import {getComparisonProjectColumnId} from '../getComparisonProjectColumnId.ts'
import {getComparisonProjectContentKey} from '../getComparisonProjectContentKey.ts'

type ComparisonProjectBatchCellsByArticle = {
  humanCellsByArticle: Record<string, Record<string, string | null>>
  llmCellsByArticle: Record<string, Record<string, string | null>>
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
