import {getAppDatabaseService} from '../../../services/appDatabaseService.ts'
import * as appQueryHelpers from '../../../services/appQueryHelpers.ts'
import {hasMatchingJudgmentAnswer} from '../../../utils/judgmentAnswers.ts'
import type {ProjectBound, PromptFilter} from './subprojectTypes.ts'

export const queryArticlesWithPromptFilters = async (
  promptFilters: PromptFilter[],
  allSelectedPromptIds: string[],
  projectBounds: ProjectBound[],
  combinedWhereClause: string | null,
) => {
  const appDatabaseService = getAppDatabaseService()
  const judgmentConfigCondition = appQueryHelpers.getJudgmentConfigClause({
    judgmentAlias: 'j',
    configs: projectBounds.map((project) => {
      return {
        modelId: project.modelId,
        useTitle: project.useTitle,
        useAbstract: project.useAbstract,
        useFulltext: project.useFulltext,
        useFulltextNoImages: project.useFulltextNoImages,
        useMetadata: project.useMetadata,
        systemPromptVariant: project.systemPromptVariant,
        fullTextStrategyId: project.fullTextStrategyId,
      }
    }),
  })
  const judgmentRows = await appDatabaseService.queryJson<{
    id: string
    promptId: string
    answeredOriginal: string | null
    answeredOriginalAsArray: unknown
  }>(`
    SELECT
      a.id AS id,
      j.prompt_id AS promptId,
      j.answered_original AS answeredOriginal,
      TO_JSON(j.answered_original_as_array) AS answeredOriginalAsArray
    FROM app.article a
    INNER JOIN app.judgment j ON ${appQueryHelpers.getAndClause([
      'j.article_id = a.id',
      `j.prompt_id IN (${appQueryHelpers.getQuotedStringList(allSelectedPromptIds).join(', ')})`,
      'j.deleted_at IS NULL',
      judgmentConfigCondition,
    ])}
    ${combinedWhereClause ? `WHERE ${combinedWhereClause}` : ''}
  `)
  const normalizedRows = judgmentRows.map((row) => {
    const parsedArray = appQueryHelpers.getJsonValue(row.answeredOriginalAsArray)

    return {
      ...row,
      answeredOriginalAsArray: Array.isArray(parsedArray)
        ? parsedArray.filter((value): value is string => {
            return typeof value === 'string'
          })
        : null,
    }
  })
  const rowsByArticleId = normalizedRows.reduce<Map<string, typeof normalizedRows>>((rowMap, row) => {
    const currentRows = rowMap.get(row.id) ?? []
    currentRows.push(row)
    rowMap.set(row.id, currentRows)
    return rowMap
  }, new Map<string, typeof normalizedRows>())

  return Array.from(rowsByArticleId.entries())
    .filter(([, rows]) => {
      return promptFilters.every((filter) => {
        return rows.some((row) => {
          return row.promptId === filter.promptId && hasMatchingJudgmentAnswer(row, filter.types)
        })
      })
    })
    .map(([articleId]) => {
      return {id: articleId}
    })
}
