import type {HumanJudgmentMode, ProjectPromptCriteriaDisposition} from '../../../db/schemaTypes.ts'
import {getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {getComparisonProjectFullTextStrategyLabels} from './comparisonProjectContentDimensions.ts'
import {
  comparisonProjectImportRouteTable,
  comparisonProjectPromptTable,
  comparisonProjectSourceProjectTable,
  comparisonProjectTable,
  promptTable,
} from './comparisonProjectRouteConstants.ts'
import {appDatabaseService, comparisonProjectServingRebuildService} from './comparisonProjectRouteServices.ts'
import type {AppQueryRunner} from './comparisonProjectRouteTypes.ts'
import type {ComparisonProjectPromptConfig, ComparisonProjectScope} from './comparisonProjectScopeTypes.ts'
import {getPromptLabel, getRequiredDateValue, getStringArrayRowValue} from './comparisonProjectValueHelpers.ts'
import {getComparisonProjectColumns} from './getComparisonProjectColumns.ts'
import {getComparisonProjectContentVariants} from './getComparisonProjectContentVariants.ts'
import {
  getArchivedComparisonProjectServingMetadata,
  getComparisonProjectServingMetadata,
} from './getComparisonProjectScope/comparisonProjectServingMetadata.ts'
import {getComparisonProjectModels} from './getComparisonProjectScope/getComparisonProjectModels.ts'
import {getComparisonProjectSourceSummaryPromptConfigs} from './getComparisonProjectScope/getComparisonProjectSourceSummaryPromptConfigs.ts'
import {getInferredSourceProjectId} from './getComparisonProjectScope/getInferredSourceProjectId.ts'
import {
  getServedComparisonProjectContentDimensionRows,
  getServedComparisonProjectContentDimensions,
} from './getComparisonProjectScope/getServedComparisonProjectContentDimensions.ts'
import {getComparisonProjectSourceProjects} from './getComparisonProjectSourceProjects.ts'
import {getIsSummaryMode} from './getIsSummaryMode.ts'
import {getSummarySourceProject} from './getSummarySourceProject.ts'

export const getComparisonProjectScope = async (
  comparisonProjectId: string,
  queryRunner: AppQueryRunner = appDatabaseService,
): Promise<ComparisonProjectScope | null> => {
  const [comparisonProjectRow] = await queryRunner.queryJson<{
    id: string
    name: string
    description: string | null
    compareWithHumans: boolean
    allowConflictResolution: boolean
    humanJudgmentMode: HumanJudgmentMode | null
    summarySourceProjectId: string | null
    useTitle: boolean
    useAbstract: boolean
    useFulltext: boolean
    useFulltextNoImages: boolean
    archived: boolean
    createdAt: unknown
    modelIds: unknown
  }>(`
    SELECT
      id,
      name,
      description,
      compare_with_humans AS compareWithHumans,
      COALESCE(allow_conflict_resolution, FALSE) AS allowConflictResolution,
      human_judgment_mode AS humanJudgmentMode,
      summary_source_project_id AS summarySourceProjectId,
      use_title AS useTitle,
      use_abstract AS useAbstract,
      use_fulltext AS useFulltext,
      use_fulltext_no_images AS useFulltextNoImages,
      archived,
      created_at AS createdAt,
      model_ids AS modelIds
    FROM ${comparisonProjectTable}
    WHERE id = ${getSqlLiteral(comparisonProjectId)}
    LIMIT 1
  `)

  if (!comparisonProjectRow) {
    return null
  }

  const normalizedComparisonProjectRow = {
    ...comparisonProjectRow,
    createdAt: getRequiredDateValue(comparisonProjectRow.createdAt),
    modelIds: getStringArrayRowValue(comparisonProjectRow, 'modelIds'),
    humanJudgmentMode: comparisonProjectRow.humanJudgmentMode ?? 'prompt',
  }
  const promptRows = await queryRunner.queryJson<{
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
        p.id AS id,
        p.original_text AS originalText,
        p.prompt_heading AS promptHeading,
        p.transformed_text AS transformedText,
        p.type AS type,
        cpp.prompt_order AS "order",
        cpp.criteria_disposition AS criteriaDisposition,
        cpp.criteria_section_key AS criteriaSectionKey,
        cpp.criteria_section_label AS criteriaSectionLabel
      FROM ${comparisonProjectPromptTable} cpp
      INNER JOIN ${promptTable} p ON p.id = cpp.prompt_id
      WHERE cpp.comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
      ORDER BY cpp.prompt_order ASC, p.created_at ASC
    `)
  const routeRows = await queryRunner.queryJson<{importRouteId: string}>(`
      SELECT import_route_id AS importRouteId
      FROM ${comparisonProjectImportRouteTable}
      WHERE comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
    `)
  const sourceProjectLinkRows = await queryRunner.queryJson<{sourceProjectId: string}>(`
      SELECT source_project_id AS sourceProjectId
      FROM ${comparisonProjectSourceProjectTable}
      WHERE comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
    `)
  const servingStatus = normalizedComparisonProjectRow.archived
    ? null
    : await comparisonProjectServingRebuildService.getComparisonProjectServingStatus(comparisonProjectId, {
        database: queryRunner,
      })
  const servingMetadata =
    servingStatus === null
      ? getArchivedComparisonProjectServingMetadata()
      : getComparisonProjectServingMetadata(servingStatus)

  const promptConfigs = promptRows.map<ComparisonProjectPromptConfig>((promptRow, index) => {
    const order = promptRow.order ?? index

    return {
      id: promptRow.id,
      originalText: promptRow.originalText,
      promptHeading: promptRow.promptHeading,
      promptLabel: getPromptLabel(promptRow.promptHeading, order),
      transformedText: promptRow.transformedText,
      type: promptRow.type,
      order,
      criteriaDisposition: promptRow.criteriaDisposition,
      criteriaSectionKey: promptRow.criteriaSectionKey,
      criteriaSectionLabel: promptRow.criteriaSectionLabel,
    }
  })
  const importRouteIds = routeRows.map((routeRow) => {
    return routeRow.importRouteId
  })
  const linkedSourceProjectIds = sourceProjectLinkRows.map((sourceProjectLinkRow) => {
    return sourceProjectLinkRow.sourceProjectId
  })
  const fallbackSourceProjectId =
    linkedSourceProjectIds.length > 0
      ? null
      : (normalizedComparisonProjectRow.summarySourceProjectId
        ?? (await getInferredSourceProjectId(
          normalizedComparisonProjectRow,
          promptConfigs,
          importRouteIds,
          queryRunner,
        )))
  const sourceProjectIds =
    linkedSourceProjectIds.length > 0
      ? linkedSourceProjectIds
      : fallbackSourceProjectId
        ? [fallbackSourceProjectId]
        : []
  const useImportRoutesForScope = linkedSourceProjectIds.length === 0
  const useSourceProjectLlmColumns = getIsSummaryMode(normalizedComparisonProjectRow) && !useImportRoutesForScope
  const sourceProjectSummaryPrompts = getIsSummaryMode(normalizedComparisonProjectRow)
    ? await getComparisonProjectSourceSummaryPromptConfigs(sourceProjectIds, queryRunner)
    : []
  const modelPromptConfigs = sourceProjectSummaryPrompts.length > 0 ? sourceProjectSummaryPrompts : promptConfigs
  const summarySourceProject = await getSummarySourceProject(
    normalizedComparisonProjectRow.summarySourceProjectId,
    queryRunner,
  )
  const sourceProjects = await getComparisonProjectSourceProjects(sourceProjectIds, queryRunner)
  const servedContentDimensionRows = await getServedComparisonProjectContentDimensionRows(
    comparisonProjectId,
    servingStatus,
    queryRunner,
  )
  const contentDimensions = getServedComparisonProjectContentDimensions(
    servedContentDimensionRows,
    useImportRoutesForScope ? [] : sourceProjects,
  )
  const contentVariants = getComparisonProjectContentVariants(
    normalizedComparisonProjectRow,
    contentDimensions,
    await getComparisonProjectFullTextStrategyLabels(queryRunner, contentDimensions),
  )
  const modelRows = await getComparisonProjectModels(
    {...normalizedComparisonProjectRow, sourceProjectIds, useImportRoutesForScope, contentVariants},
    modelPromptConfigs.map((prompt) => {
      return prompt.id
    }),
    importRouteIds,
    queryRunner,
  )
  const columns = getComparisonProjectColumns(
    promptConfigs,
    modelRows,
    contentVariants,
    normalizedComparisonProjectRow.compareWithHumans,
    normalizedComparisonProjectRow.humanJudgmentMode,
    normalizedComparisonProjectRow.summarySourceProjectId,
    summarySourceProject,
    sourceProjects,
    useSourceProjectLlmColumns,
  )

  return {
    ...normalizedComparisonProjectRow,
    ...servingMetadata,
    sourceProjectIds,
    useImportRoutesForScope,
    summarySourceProject,
    sourceProjects,
    contentVariants,
    prompts: promptConfigs,
    sourceProjectSummaryPrompts,
    models: modelRows,
    importRouteIds,
    columns,
  }
}
