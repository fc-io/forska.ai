import {promptTable} from './comparisonProjectRouteConstants.ts'
import type {AppQueryRunner, PromptSelection} from './comparisonProjectRouteTypes.ts'
import type {ComparisonProjectPromptConfig} from './comparisonProjectScopeTypes.ts'
import {getInClause} from './comparisonProjectSqlClauses.ts'
import {getPromptLabel, getUniquePromptSelections} from './comparisonProjectValueHelpers.ts'

export const getComparisonProjectPromptConfigsForSelections = async (
  db: AppQueryRunner,
  promptSelections: PromptSelection[],
) => {
  const uniquePromptSelections = getUniquePromptSelections(promptSelections)

  if (uniquePromptSelections.length === 0) {
    return []
  }

  const rows = await db.queryJson<{
    id: string
    originalText: string
    promptHeading: string | null
    transformedText: string | null
    type: string | null
  }>(`
    SELECT
      id,
      original_text AS originalText,
      prompt_heading AS promptHeading,
      transformed_text AS transformedText,
      type
    FROM ${promptTable}
    WHERE id IN (${getInClause(
      uniquePromptSelections.map((promptSelection) => {
        return promptSelection.promptId
      }),
    )})
  `)
  const rowsById = rows.reduce<Map<string, (typeof rows)[number]>>((rowMap, row) => {
    rowMap.set(row.id, row)
    return rowMap
  }, new Map<string, (typeof rows)[number]>())

  if (rowsById.size !== uniquePromptSelections.length) {
    throw new Error('One or more selected prompts are invalid')
  }

  return uniquePromptSelections.map<ComparisonProjectPromptConfig>((promptSelection, index) => {
    const row = rowsById.get(promptSelection.promptId)
    const order = promptSelection.order ?? index

    if (!row) {
      throw new Error('One or more selected prompts are invalid')
    }

    return {
      id: row.id,
      originalText: row.originalText,
      promptHeading: row.promptHeading,
      promptLabel: getPromptLabel(row.promptHeading, order),
      transformedText: row.transformedText,
      type: row.type,
      order,
      criteriaDisposition: promptSelection.criteriaDisposition ?? null,
      criteriaSectionKey: promptSelection.criteriaSectionKey ?? null,
      criteriaSectionLabel: promptSelection.criteriaSectionLabel ?? null,
    }
  })
}
