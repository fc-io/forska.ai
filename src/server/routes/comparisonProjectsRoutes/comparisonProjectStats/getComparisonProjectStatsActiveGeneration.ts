import {getSqlLiteral} from '../../../services/appQueryHelpers.ts'
import type {ComparisonProjectStatsQueryRunner} from './comparisonProjectStatsTypes.ts'

const getComparisonProjectStatsGenerationValue = (value: unknown) => {
  const parsedValue = typeof value === 'bigint' ? Number(value) : Number(value)

  return Number.isSafeInteger(parsedValue) && parsedValue > 0 ? parsedValue : null
}

export const getComparisonProjectStatsActiveGenerationSql = (comparisonProjectId: string) => {
  return `
    SELECT CAST(active_generation AS INTEGER) AS generation
    FROM app.comparison_project_serving_generation
    WHERE comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
      AND active_generation > 0
    LIMIT 1
  `
}

export const getComparisonProjectStatsActiveGeneration = async (params: {
  comparisonProjectId: string
  generation?: number | null
  queryRunner: ComparisonProjectStatsQueryRunner
}) => {
  if (params.generation !== undefined) {
    return getComparisonProjectStatsGenerationValue(params.generation)
  }

  const [generationRow] = await params.queryRunner.queryJson<{generation: unknown}>(
    getComparisonProjectStatsActiveGenerationSql(params.comparisonProjectId),
  )

  return getComparisonProjectStatsGenerationValue(generationRow?.generation)
}
