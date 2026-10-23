import {articleTable, judgmentTable, modelTable} from '../comparisonProjectRouteConstants.ts'
import {appDatabaseService} from '../comparisonProjectRouteServices.ts'
import type {AppQueryRunner} from '../comparisonProjectRouteTypes.ts'
import type {ComparisonProjectContentVariant, ComparisonProjectModelConfig} from '../comparisonProjectScopeTypes.ts'
import {getComparisonProjectContentClause, getInClause, getWhereClause} from '../comparisonProjectSqlClauses.ts'
import {getArticleScopeConditions} from '../getArticleScopeConditions.ts'

export const getComparisonProjectModels = async (
  comparisonProjectRow: {
    modelIds: string[] | null
    sourceProjectIds: string[]
    useImportRoutesForScope: boolean
    contentVariants: ComparisonProjectContentVariant[]
  },
  promptIds: string[],
  importRouteIds: string[],
  queryRunner: AppQueryRunner = appDatabaseService,
) => {
  const selectedModelIds = comparisonProjectRow.modelIds ?? []

  if (selectedModelIds.length > 0) {
    const modelRows = await queryRunner.queryJson<ComparisonProjectModelConfig>(`
      SELECT m.id AS id, m.name AS name, TO_JSON(m.metadata_json) AS metadataJson, pc.provider_kind AS provider, m.variant AS version
      FROM ${modelTable} m
      LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
      WHERE m.id IN (${getInClause(selectedModelIds)})
    `)
    const modelRowsById = modelRows.reduce<Map<string, ComparisonProjectModelConfig>>((rowMap, modelRow) => {
      rowMap.set(modelRow.id, modelRow)
      return rowMap
    }, new Map<string, ComparisonProjectModelConfig>())

    return selectedModelIds.map((modelId) => {
      return modelRowsById.get(modelId) ?? {id: modelId, metadataJson: {}, name: modelId, provider: null, version: null}
    })
  }

  if (promptIds.length === 0) {
    return []
  }

  const contentCondition = getComparisonProjectContentClause('j', comparisonProjectRow.contentVariants)

  if (!contentCondition) {
    return []
  }

  const articleScopeConditions = getArticleScopeConditions(
    importRouteIds,
    comparisonProjectRow.sourceProjectIds,
    comparisonProjectRow.useImportRoutesForScope,
  )
  return queryRunner.queryJson<ComparisonProjectModelConfig>(`
    SELECT m.id AS id, m.name AS name, TO_JSON(m.metadata_json) AS metadataJson, pc.provider_kind AS provider, m.variant AS version
    FROM ${judgmentTable} j
    INNER JOIN ${modelTable} m ON m.id = j.model_id
    LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
    INNER JOIN ${articleTable} a ON a.id = j.article_id
    ${getWhereClause([
      `j.prompt_id IN (${getInClause(promptIds)})`,
      'j.deleted_at IS NULL',
      contentCondition,
      ...articleScopeConditions,
    ])}
    GROUP BY m.id, m.name, m.metadata_json, pc.provider_kind, m.variant
    ORDER BY m.name ASC
  `)
}
