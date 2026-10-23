import type {ProjectPromptRow} from './articleReviewDetailTypes.ts'

export const upsertPromptRow = (promptRowsById: Map<string, ProjectPromptRow>, promptRow: ProjectPromptRow) => {
  return promptRow.id.length === 0 || promptRow.id === 'summary'
    ? promptRowsById
    : promptRowsById.set(promptRow.id, promptRow)
}
