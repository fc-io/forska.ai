import {FULL_TEXT_STRATEGY_NONE} from '../../../fullText/fullTextStrategy.ts'
import {getSqlLiteral} from '../../../services/appQueryHelpers.ts'
import {comparisonSystemPromptVariantServingTable} from '../../../services/comparisonProjectServingGenerationConfig.ts'
import type {ComparisonProjectServingStatusRow} from '../../../services/comparisonProjectServingRebuildService.ts'
import {
  type ComparisonProjectContentDimensionRow,
  getComparisonProjectContentDimensions,
} from '../comparisonProjectContentDimensions.ts'
import type {AppQueryRunner} from '../comparisonProjectRouteTypes.ts'
import type {ComparisonProjectContentDimension} from '../comparisonProjectScopeTypes.ts'

export const getServedComparisonProjectContentDimensionRows = async (
  comparisonProjectId: string,
  servingStatus: Pick<ComparisonProjectServingStatusRow, 'activeGeneration'> | null,
  queryRunner: AppQueryRunner,
) => {
  const activeGeneration = servingStatus?.activeGeneration ?? null

  return activeGeneration !== null && Number.isSafeInteger(activeGeneration) && activeGeneration > 0
    ? queryRunner.queryJson<ComparisonProjectContentDimensionRow>(`
        SELECT DISTINCT
          system_prompt_variant AS systemPromptVariant,
          COALESCE(use_metadata, FALSE) AS useMetadata,
          COALESCE(full_text_strategy_id, ${getSqlLiteral(FULL_TEXT_STRATEGY_NONE)}) AS fullTextStrategyId
        FROM ${comparisonSystemPromptVariantServingTable}
        WHERE comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
          AND generation = ${getSqlLiteral(activeGeneration)}
      `)
    : []
}

export const getServedComparisonProjectContentDimensions = (
  servedContentDimensionRows: ReadonlyArray<ComparisonProjectContentDimensionRow>,
  sourceProjects: ReadonlyArray<ComparisonProjectContentDimension>,
) => {
  return getComparisonProjectContentDimensions(
    servedContentDimensionRows.length > 0 ? servedContentDimensionRows : sourceProjects,
  )
}
