import type {HumanJudgmentMode} from '../../../db/schemaTypes.ts'
import {getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {
  comparisonProjectPromptTable,
  comparisonProjectSourceProjectTable,
  comparisonProjectTable,
  modelTable,
  projectPromptTable,
  promptTable,
} from './comparisonProjectRouteConstants.ts'
import {appDatabaseService} from './comparisonProjectRouteServices.ts'
import {getInClause} from './comparisonProjectSqlClauses.ts'
import {getRequiredDateValue, getStringArrayRowValue} from './comparisonProjectValueHelpers.ts'
import {getComparisonProjectSourceProjects} from './getComparisonProjectSourceProjects.ts'
import {getSummarySourceProject} from './getSummarySourceProject.ts'

type ComparisonProjectEditPrompt = {
  id: string
  originalText: string
  promptHeading: string | null
  type: string | null
  createdAt: Date
  archived: boolean
}

const getModelSelectionId = (modelRow: {
  id: string
  provider: string | null
  modelName: string | null
  version: string | null
}) => {
  const provider = modelRow.provider?.trim().toLowerCase() ?? ''
  const modelName = modelRow.modelName?.trim() ?? ''
  const version = modelRow.version?.trim() ?? ''

  return provider === 'codex' && modelName
    ? version
      ? `codex:${modelName}:${version}`
      : `codex:${modelName}`
    : modelRow.id
}

export const getComparisonProjectEditFormData = async (comparisonProjectId: string) => {
  const [comparisonProjectRow] = await appDatabaseService.queryJson<{
    id: string
    name: string
    description: string | null
    compareWithHumans: boolean
    humanJudgmentMode: HumanJudgmentMode | null
    summarySourceProjectId: string | null
    updatedAt: unknown
    modelIds: unknown
    useTitle: boolean
    useAbstract: boolean
    useFulltext: boolean
    useFulltextNoImages: boolean
  }>(`
    SELECT
      id,
      name,
      description,
      compare_with_humans AS compareWithHumans,
      COALESCE(allow_conflict_resolution, FALSE) AS allowConflictResolution,
      human_judgment_mode AS humanJudgmentMode,
      summary_source_project_id AS summarySourceProjectId,
      updated_at AS updatedAt,
      model_ids AS modelIds,
      use_title AS useTitle,
      use_abstract AS useAbstract,
      use_fulltext AS useFulltext,
      use_fulltext_no_images AS useFulltextNoImages
    FROM ${comparisonProjectTable}
    WHERE id = ${getSqlLiteral(comparisonProjectId)}
    LIMIT 1
  `)

  if (!comparisonProjectRow) {
    return null
  }

  const normalizedComparisonProjectRow = {
    ...comparisonProjectRow,
    updatedAt: getRequiredDateValue(comparisonProjectRow.updatedAt),
    modelIds: getStringArrayRowValue(comparisonProjectRow, 'modelIds'),
    humanJudgmentMode: comparisonProjectRow.humanJudgmentMode ?? 'prompt',
  }
  const configuredModelIds = normalizedComparisonProjectRow.modelIds ?? []
  const configuredModelRows =
    configuredModelIds.length > 0
      ? await appDatabaseService.queryJson<{
          id: string
          provider: string | null
          modelName: string | null
          version: string | null
        }>(`
          SELECT
            m.id AS id,
            pc.provider_kind AS provider,
            m.remote_model_id AS modelName,
            m.variant AS version
          FROM ${modelTable} m
          LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
          WHERE m.id IN (${getInClause(configuredModelIds)})
        `)
      : []
  const modelRowsById = configuredModelRows.reduce<Map<string, (typeof configuredModelRows)[number]>>(
    (rowMap, modelRow) => {
      rowMap.set(modelRow.id, modelRow)
      return rowMap
    },
    new Map<string, (typeof configuredModelRows)[number]>(),
  )
  const availablePromptsQuery =
    normalizedComparisonProjectRow.humanJudgmentMode === 'summary'
    && normalizedComparisonProjectRow.summarySourceProjectId
      ? `
      SELECT
        p.id AS id,
        p.original_text AS originalText,
        p.prompt_heading AS promptHeading,
        p.type,
        p.created_at AS createdAt,
        p.archived AS archived
      FROM ${projectPromptTable} pp
      INNER JOIN ${promptTable} p ON p.id = pp.prompt_id
      WHERE pp.project_id = ${getSqlLiteral(normalizedComparisonProjectRow.summarySourceProjectId)}
        AND pp.enabled = TRUE
        AND p.archived = FALSE
      ORDER BY pp.prompt_order ASC, p.created_at ASC
    `
      : `
      SELECT
        id,
        original_text AS originalText,
        prompt_heading AS promptHeading,
        type,
        created_at AS createdAt,
        archived
      FROM ${promptTable}
      WHERE archived = FALSE
      ORDER BY created_at DESC
    `

  const [selectedPromptRows, availablePromptRows, sourceProjectLinkRows] = await Promise.all([
    appDatabaseService.queryJson<{
      id: string
      originalText: string
      promptHeading: string | null
      type: string | null
      createdAt: unknown
      archived: boolean
      order: number | null
    }>(`
      SELECT
        p.id AS id,
        p.original_text AS originalText,
        p.prompt_heading AS promptHeading,
        p.type AS type,
        p.created_at AS createdAt,
        p.archived AS archived,
        cpp.prompt_order AS "order"
      FROM ${comparisonProjectPromptTable} cpp
      INNER JOIN ${promptTable} p ON p.id = cpp.prompt_id
      WHERE cpp.comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
      ORDER BY cpp.prompt_order ASC, p.created_at ASC
    `),
    appDatabaseService.queryJson<{
      id: string
      originalText: string
      promptHeading: string | null
      type: string | null
      createdAt: unknown
      archived: boolean
    }>(availablePromptsQuery),
    appDatabaseService.queryJson<{sourceProjectId: string}>(`
      SELECT source_project_id AS sourceProjectId
      FROM ${comparisonProjectSourceProjectTable}
      WHERE comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
    `),
  ])
  const sourceProjectIds = sourceProjectLinkRows.map((sourceProjectLinkRow) => {
    return sourceProjectLinkRow.sourceProjectId
  })
  const normalizedSelectedPromptRows = selectedPromptRows.map((promptRow) => {
    return {...promptRow, createdAt: getRequiredDateValue(promptRow.createdAt)}
  })
  const normalizedAvailablePromptRows = availablePromptRows.map((promptRow) => {
    return {...promptRow, createdAt: getRequiredDateValue(promptRow.createdAt)}
  })
  const selectedPromptIds = new Set(
    normalizedSelectedPromptRows.map((promptRow) => {
      return promptRow.id
    }),
  )
  const availablePrompts = [
    ...normalizedSelectedPromptRows.map<ComparisonProjectEditPrompt>((promptRow) => {
      return {
        id: promptRow.id,
        originalText: promptRow.originalText,
        promptHeading: promptRow.promptHeading,
        type: promptRow.type,
        createdAt: promptRow.createdAt,
        archived: promptRow.archived,
      }
    }),
    ...normalizedAvailablePromptRows
      .filter((promptRow) => {
        return !selectedPromptIds.has(promptRow.id)
      })
      .map<ComparisonProjectEditPrompt>((promptRow) => {
        return {
          id: promptRow.id,
          originalText: promptRow.originalText,
          promptHeading: promptRow.promptHeading,
          type: promptRow.type,
          createdAt: promptRow.createdAt,
          archived: promptRow.archived,
        }
      }),
  ]
  const [summarySourceProject, sourceProjects] = await Promise.all([
    getSummarySourceProject(normalizedComparisonProjectRow.summarySourceProjectId),
    getComparisonProjectSourceProjects(sourceProjectIds),
  ])

  return {
    ...normalizedComparisonProjectRow,
    summarySourceProject,
    sourceProjectIds,
    sourceProjects,
    selectedModelIds: configuredModelIds
      .map((modelId) => {
        const modelRow = modelRowsById.get(modelId)
        return modelRow ? getModelSelectionId(modelRow) : modelId
      })
      .filter(Boolean),
    promptSelections: normalizedSelectedPromptRows.map((promptRow, index) => {
      return {promptId: promptRow.id, order: promptRow.order ?? index}
    }),
    availablePrompts,
  }
}
