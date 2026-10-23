import type {ProjectPromptCriteriaDisposition} from '../../../../db/schemaTypes.ts'
import {projectPromptTable, promptTable} from '../comparisonProjectRouteConstants.ts'
import {appDatabaseService} from '../comparisonProjectRouteServices.ts'
import type {AppQueryRunner} from '../comparisonProjectRouteTypes.ts'
import type {ComparisonProjectSourceSummaryPromptConfig} from '../comparisonProjectScopeTypes.ts'
import {getInClause} from '../comparisonProjectSqlClauses.ts'
import {getPromptLabel} from '../comparisonProjectValueHelpers.ts'

export const getComparisonProjectSourceSummaryPromptConfigs = async (
  sourceProjectIds: string[],
  queryRunner: AppQueryRunner = appDatabaseService,
) => {
  if (sourceProjectIds.length === 0) {
    return []
  }

  const rows = await queryRunner.queryJson<{
    sourceProjectId: string
    id: string
    originalText: string
    promptHeading: string | null
    transformedText: string | null
    type: string | null
    order: number | null
    criteriaDisposition: ProjectPromptCriteriaDisposition | null
    criteriaSectionKey: string | null
    criteriaSectionLabel: string | null
  }>(`
    SELECT
      pp.project_id AS sourceProjectId,
      p.id AS id,
      p.original_text AS originalText,
      p.prompt_heading AS promptHeading,
      p.transformed_text AS transformedText,
      p.type AS type,
      pp.prompt_order AS "order",
      pp.criteria_disposition AS criteriaDisposition,
      pp.criteria_section_key AS criteriaSectionKey,
      pp.criteria_section_label AS criteriaSectionLabel
    FROM ${projectPromptTable} pp
    INNER JOIN ${promptTable} p ON p.id = pp.prompt_id
    WHERE pp.project_id IN (${getInClause(sourceProjectIds)})
      AND pp.enabled = TRUE
      AND pp.criteria_disposition IS NOT NULL
      AND pp.criteria_section_key IS NOT NULL
    ORDER BY pp.project_id ASC, pp.prompt_order ASC, p.created_at ASC
  `)
  const fallbackOrderByProjectId = new Map<string, number>()

  return rows.map<ComparisonProjectSourceSummaryPromptConfig>((row) => {
    const fallbackOrder = fallbackOrderByProjectId.get(row.sourceProjectId) ?? 0
    const order = row.order ?? fallbackOrder
    fallbackOrderByProjectId.set(row.sourceProjectId, fallbackOrder + 1)

    return {
      id: row.id,
      sourceProjectId: row.sourceProjectId,
      originalText: row.originalText,
      promptHeading: row.promptHeading,
      promptLabel: getPromptLabel(row.promptHeading, order),
      transformedText: row.transformedText,
      type: row.type,
      order,
      criteriaDisposition: row.criteriaDisposition,
      criteriaSectionKey: row.criteriaSectionKey,
      criteriaSectionLabel: row.criteriaSectionLabel,
    }
  })
}
