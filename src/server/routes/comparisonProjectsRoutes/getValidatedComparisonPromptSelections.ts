import type {HumanJudgmentMode, ProjectPromptCriteriaDisposition} from '../../../db/schemaTypes.ts'
import {getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {projectPromptTable, projectTable, promptTable} from './comparisonProjectRouteConstants.ts'
import type {AppQueryRunner, PromptSelection} from './comparisonProjectRouteTypes.ts'
import {getSummarySourceProjectId} from './comparisonProjectSelectionValidation.ts'
import {getInClause} from './comparisonProjectSqlClauses.ts'
import {getUniquePromptSelections} from './comparisonProjectValueHelpers.ts'

const getValidatedPromptSelections = async (db: AppQueryRunner, promptSelections: PromptSelection[]) => {
  const uniquePromptSelections = getUniquePromptSelections(promptSelections)

  if (uniquePromptSelections.length === 0) {
    return uniquePromptSelections
  }

  const promptRows = await db.queryJson<{id: string}>(`
    SELECT id
    FROM ${promptTable}
    WHERE id IN (${getInClause(
      uniquePromptSelections.map((promptSelection) => {
        return promptSelection.promptId
      }),
    )})
  `)

  if (promptRows.length !== uniquePromptSelections.length) {
    throw new Error('One or more selected prompts are invalid')
  }

  return uniquePromptSelections
}

const validateSummaryModeSourceProject = async (db: AppQueryRunner, summarySourceProjectId: string) => {
  const [summarySourceProject] = await db.queryJson<{id: string; humanJudgmentMode: HumanJudgmentMode | null}>(`
    SELECT id, human_judgment_mode AS humanJudgmentMode
    FROM ${projectTable}
    WHERE id = ${getSqlLiteral(summarySourceProjectId)}
      AND archived = FALSE
    LIMIT 1
  `)

  if (!summarySourceProject || summarySourceProject.humanJudgmentMode !== 'summary') {
    throw new Error('Summary source project must exist and be summary-capable')
  }
}

const getValidatedSummaryPromptSelections = async (
  db: AppQueryRunner,
  summarySourceProjectId: string,
  promptSelections: PromptSelection[],
) => {
  const uniquePromptSelections = getUniquePromptSelections(promptSelections)
  const selectedPromptIds = uniquePromptSelections.map((promptSelection) => {
    return promptSelection.promptId
  })

  const sourcePromptRows = await db.queryJson<{
    promptId: string
    order: number | null
    criteriaDisposition: ProjectPromptCriteriaDisposition | null
    criteriaSectionKey: string | null
    criteriaSectionLabel: string | null
  }>(`
    SELECT
      prompt_id AS promptId,
      prompt_order AS order,
      criteria_disposition AS criteriaDisposition,
      criteria_section_key AS criteriaSectionKey,
      criteria_section_label AS criteriaSectionLabel
    FROM ${projectPromptTable}
    WHERE project_id = ${getSqlLiteral(summarySourceProjectId)}
      AND enabled = TRUE
      AND criteria_disposition IS NOT NULL
      AND criteria_section_key IS NOT NULL
      ${selectedPromptIds.length > 0 ? `AND prompt_id IN (${getInClause(selectedPromptIds)})` : ''}
    ORDER BY prompt_order ASC, prompt_id ASC
  `)

  if (uniquePromptSelections.length === 0) {
    if (sourcePromptRows.length === 0) {
      throw new Error('Selected summary source project has no prompts with summary criteria metadata')
    }

    return sourcePromptRows.map<PromptSelection>((sourcePromptRow, index) => {
      return {
        promptId: sourcePromptRow.promptId,
        order: sourcePromptRow.order ?? index,
        criteriaDisposition: sourcePromptRow.criteriaDisposition,
        criteriaSectionKey: sourcePromptRow.criteriaSectionKey,
        criteriaSectionLabel: sourcePromptRow.criteriaSectionLabel,
      }
    })
  }

  const sourcePromptRowsByPromptId = sourcePromptRows.reduce<Map<string, (typeof sourcePromptRows)[number]>>(
    (rowMap, sourcePromptRow) => {
      rowMap.set(sourcePromptRow.promptId, sourcePromptRow)
      return rowMap
    },
    new Map<string, (typeof sourcePromptRows)[number]>(),
  )

  if (sourcePromptRowsByPromptId.size !== uniquePromptSelections.length) {
    throw new Error(
      'Summary mode selected prompts must exist on the summary source project and include summary criteria metadata',
    )
  }

  return uniquePromptSelections.map<PromptSelection>((promptSelection) => {
    const sourcePromptRow = sourcePromptRowsByPromptId.get(promptSelection.promptId)

    if (!sourcePromptRow) {
      throw new Error(
        'Summary mode selected prompts must exist on the summary source project and include summary criteria metadata',
      )
    }

    return {
      promptId: promptSelection.promptId,
      order: promptSelection.order,
      criteriaDisposition: sourcePromptRow.criteriaDisposition,
      criteriaSectionKey: sourcePromptRow.criteriaSectionKey,
      criteriaSectionLabel: sourcePromptRow.criteriaSectionLabel,
    }
  })
}

export const getValidatedComparisonPromptSelections = async (
  db: AppQueryRunner,
  params: {
    compareWithHumans: boolean
    humanJudgmentMode: HumanJudgmentMode
    promptSelections: PromptSelection[]
    summarySourceProjectId: string | null
  },
) => {
  if (params.humanJudgmentMode !== 'summary') {
    return getValidatedPromptSelections(db, params.promptSelections)
  }

  if (!params.compareWithHumans) {
    throw new Error('Summary mode requires compareWithHumans to be true')
  }

  const summarySourceProjectId = getSummarySourceProjectId(params.summarySourceProjectId)
  await validateSummaryModeSourceProject(db, summarySourceProjectId)

  return getValidatedSummaryPromptSelections(db, summarySourceProjectId, params.promptSelections)
}
