import type {ProjectPromptRow} from './articleReviewDetailTypes.ts'
import {upsertPromptRow} from './upsertPromptRow.ts'

export const mergePromptRows = (
  appPromptRows: readonly ProjectPromptRow[],
  servingPromptRows: readonly ProjectPromptRow[],
) => {
  const promptRowsById = servingPromptRows.reduce((promptMap, promptRow) => {
    return upsertPromptRow(promptMap, promptRow)
  }, new Map<string, ProjectPromptRow>())

  appPromptRows.forEach((promptRow) => {
    upsertPromptRow(promptRowsById, promptRow)
  })

  return [...promptRowsById.values()]
}
