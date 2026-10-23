import {getSystemPromptVariant} from '../../../agent/judge/systemPromptVariant.ts'
import type {ProjectPromptCriteriaDisposition} from '../../../db/schemaTypes.ts'
import {
  appendProviderModelThinkingBadgeLabel,
  getProviderModelThinkingBadgeValue,
} from '../../../utils/providerModelLabel.ts'
import {getProjectFullTextStrategyIdSql} from '../../fullText/fullTextStrategy.ts'
import {getProviderModelMetadataOptions} from '../../providers/providerModelMetadata.ts'
import {getJsonValue} from '../../services/appQueryHelpers.ts'
import {
  importRouteTable,
  modelTable,
  projectImportRouteTable,
  projectPromptTable,
  projectTable,
  promptTable,
} from './comparisonProjectRouteConstants.ts'
import {appDatabaseService} from './comparisonProjectRouteServices.ts'
import type {
  ComparisonProjectSource,
  ComparisonProjectSourceImportRoute,
  ComparisonProjectSourcePrompt,
} from './comparisonProjectRouteTypes.ts'
import {
  type ComparisonProjectSourceRow,
  getComparisonProjectSourceFullTextStrategy,
} from './comparisonProjectSourceFullTextStrategy.ts'
import {getInClause} from './comparisonProjectSqlClauses.ts'
import {isDefined} from './comparisonProjectValueHelpers.ts'

export const getComparisonProjectSources = async (): Promise<ComparisonProjectSource[]> => {
  const projectRows = await appDatabaseService.queryJson<ComparisonProjectSourceRow>(`
    SELECT
      p.id AS id,
      p.name AS name,
      p.description AS description,
      p.model_id AS modelId,
      TO_JSON(m.metadata_json) AS modelMetadataJson,
      COALESCE(m.display_name, m.name, m.remote_model_id, p.model_id) AS modelName,
      pc.provider_kind AS modelProvider,
      m.variant AS modelVersion,
      p.human_judgment_mode AS humanJudgmentMode,
      p.system_prompt_variant AS systemPromptVariant,
      ${getProjectFullTextStrategyIdSql('p')} AS fullTextStrategyId,
      fts.label AS fullTextStrategyStoredLabel,
      CAST(fts.inputs AS VARCHAR) AS fullTextStrategyInputs,
      p.use_title AS useTitle,
      p.use_abstract AS useAbstract,
      p.use_fulltext AS useFulltext,
      p.use_fulltext_no_images AS useFulltextNoImages,
      COALESCE(p.use_metadata, FALSE) AS useMetadata
    FROM ${projectTable} p
    LEFT JOIN ${modelTable} m ON m.id = p.model_id
    LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
    LEFT JOIN app.full_text_strategy fts ON fts.id = p.full_text_strategy_id
    WHERE p.archived = FALSE
    ORDER BY p.name ASC
  `)

  if (projectRows.length === 0) {
    return []
  }

  const projectIds = projectRows.map((projectRow) => {
    return projectRow.id
  })
  const [promptRows, routeRows] = await Promise.all([
    appDatabaseService.queryJson<{
      projectId: string
      promptId: string
      originalText: string
      promptHeading: string | null
      transformedText: string | null
      order: number | null
      criteriaDisposition: ProjectPromptCriteriaDisposition | null
      criteriaSectionKey: string | null
      criteriaSectionLabel: string | null
    }>(`
      SELECT
        pp.project_id AS projectId,
        p.id AS promptId,
        p.original_text AS originalText,
        p.prompt_heading AS promptHeading,
        p.transformed_text AS transformedText,
        pp.prompt_order AS "order",
        pp.criteria_disposition AS criteriaDisposition,
        pp.criteria_section_key AS criteriaSectionKey,
        pp.criteria_section_label AS criteriaSectionLabel
      FROM ${projectPromptTable} pp
      INNER JOIN ${promptTable} p ON p.id = pp.prompt_id
      WHERE pp.project_id IN (${getInClause(projectIds)})
        AND pp.enabled = TRUE
      ORDER BY pp.project_id ASC, pp.prompt_order ASC, p.created_at ASC
    `),
    appDatabaseService.queryJson<{projectId: string; route: string; name: string | null}>(`
      SELECT
        pir.project_id AS projectId,
        ir.route AS route,
        ir.name AS name
      FROM ${projectImportRouteTable} pir
      INNER JOIN ${importRouteTable} ir ON ir.id = pir.import_route_id
      WHERE pir.project_id IN (${getInClause(projectIds)})
      ORDER BY pir.project_id ASC, ir.route ASC
    `),
  ])
  const promptRowsByProjectId = promptRows.reduce<Map<string, typeof promptRows>>((rowMap, promptRow) => {
    const currentRows = rowMap.get(promptRow.projectId) ?? []
    currentRows.push(promptRow)
    rowMap.set(promptRow.projectId, currentRows)
    return rowMap
  }, new Map<string, typeof promptRows>())
  const routeRowsByProjectId = routeRows.reduce<Map<string, typeof routeRows>>((rowMap, routeRow) => {
    const currentRows = rowMap.get(routeRow.projectId) ?? []
    currentRows.push(routeRow)
    rowMap.set(routeRow.projectId, currentRows)
    return rowMap
  }, new Map<string, typeof routeRows>())

  return projectRows
    .map<ComparisonProjectSource | null>((projectRow) => {
      const sourcePromptRows = promptRowsByProjectId.get(projectRow.id) ?? []
      const sourceImportRouteRows = routeRowsByProjectId.get(projectRow.id) ?? []

      if (sourcePromptRows.length === 0) {
        return null
      }

      const {
        fullTextStrategyInputs: _fullTextStrategyInputs,
        fullTextStrategyStoredLabel: _fullTextStrategyStoredLabel,
        modelMetadataJson: _modelMetadataJson,
        ...sourceProjectRow
      } = projectRow

      const humanJudgmentMode = projectRow.humanJudgmentMode ?? 'prompt'

      return {
        ...sourceProjectRow,
        modelName: appendProviderModelThinkingBadgeLabel({
          label: projectRow.modelName,
          thinking: getProviderModelThinkingBadgeValue({
            provider: projectRow.modelProvider,
            thinking: getProviderModelMetadataOptions(getJsonValue(projectRow.modelMetadataJson)).thinking,
            version: projectRow.modelVersion,
          }),
        }),
        humanJudgmentMode,
        isSummaryCapable: humanJudgmentMode === 'summary',
        summarySourceProjectId: humanJudgmentMode === 'summary' ? projectRow.id : null,
        systemPromptVariant: getSystemPromptVariant(projectRow.systemPromptVariant),
        ...getComparisonProjectSourceFullTextStrategy(projectRow),
        useMetadata: projectRow.useMetadata === true,
        prompts: sourcePromptRows.map<ComparisonProjectSourcePrompt>((promptRow, index) => {
          return {
            id: promptRow.promptId,
            originalText: promptRow.originalText,
            promptHeading: promptRow.promptHeading,
            transformedText: promptRow.transformedText,
            order: promptRow.order ?? index,
            criteriaDisposition: promptRow.criteriaDisposition,
            criteriaSectionKey: promptRow.criteriaSectionKey,
            criteriaSectionLabel: promptRow.criteriaSectionLabel,
          }
        }),
        importRoutes: sourceImportRouteRows.map<ComparisonProjectSourceImportRoute>((routeRow) => {
          return {route: routeRow.route, name: routeRow.name}
        }),
      }
    })
    .filter(isDefined)
}
