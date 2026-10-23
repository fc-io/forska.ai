import {getSystemPromptVariant} from '../../../agent/judge/systemPromptVariant.ts'
import {getEffectiveFullTextStrategyId} from '../../fullText/fullTextStrategy.ts'
import {hasAnyJudgmentAnswer} from '../../utils/judgmentAnswers.ts'
import {judgmentTable} from './comparisonProjectRouteConstants.ts'
import {appDatabaseService} from './comparisonProjectRouteServices.ts'
import type {AppQueryRunner, ComparisonProjectLlmRow} from './comparisonProjectRouteTypes.ts'
import type {ComparisonProjectScope} from './comparisonProjectScopeTypes.ts'
import {getComparisonProjectContentClause, getInClause, getWhereClause} from './comparisonProjectSqlClauses.ts'
import {getRequiredDateValue, getStringArrayRowValue, getUniqueStringValues} from './comparisonProjectValueHelpers.ts'
import {getIsSummaryMode} from './getIsSummaryMode.ts'

export const getComparisonProjectLlmRows = async (
  scope: ComparisonProjectScope,
  articleIds: string[],
  queryRunner: AppQueryRunner = appDatabaseService,
) => {
  const summarySourcePromptIds = getIsSummaryMode(scope)
    ? scope.sourceProjectSummaryPrompts.map((prompt) => {
        return prompt.id
      })
    : []
  const fallbackPromptIds = scope.prompts.map((prompt) => {
    return prompt.id
  })
  const promptIds = getUniqueStringValues(
    summarySourcePromptIds.length > 0 ? summarySourcePromptIds : fallbackPromptIds,
  )
  const modelIds = scope.models.map((model) => {
    return model.id
  })

  if (articleIds.length === 0 || promptIds.length === 0 || modelIds.length === 0) {
    return []
  }

  const contentCondition = getComparisonProjectContentClause('j', scope.contentVariants)

  if (!contentCondition) {
    return []
  }

  const rows = await queryRunner.queryJson<{
    createdAt: unknown
    articleId: string
    promptId: string
    modelId: string
    answeredOriginal: string | null
    answeredOriginalAsArray: unknown
    explanation: string | null
    quotes: unknown
    systemPromptVariant?: string | null
    fullTextStrategyId?: string | null
    useTitle: boolean
    useAbstract: boolean
    useFulltext: boolean
    useFulltextNoImages: boolean
    useMetadata?: boolean | null
  }>(`
    SELECT
      created_at AS createdAt,
      article_id AS articleId,
      prompt_id AS promptId,
      model_id AS modelId,
      answered_original AS answeredOriginal,
      answered_original_as_array AS answeredOriginalAsArray,
      explanation,
      TO_JSON(quotes) AS quotes,
      system_prompt_variant AS systemPromptVariant,
      full_text_strategy_id AS fullTextStrategyId,
      use_title AS useTitle,
      use_abstract AS useAbstract,
      use_fulltext AS useFulltext,
      use_fulltext_no_images AS useFulltextNoImages,
      use_metadata AS useMetadata
    FROM ${judgmentTable} j
    ${getWhereClause([
      `j.article_id IN (${getInClause(articleIds)})`,
      `j.prompt_id IN (${getInClause(promptIds)})`,
      `j.model_id IN (${getInClause(modelIds)})`,
      'j.deleted_at IS NULL',
      contentCondition,
    ])}
  `)

  return rows
    .map<ComparisonProjectLlmRow>((row) => {
      return {
        ...row,
        createdAt: getRequiredDateValue(row.createdAt),
        sourceProjectId: null,
        answeredOriginalAsArray: getStringArrayRowValue(row, 'answeredOriginalAsArray'),
        systemPromptVariant: getSystemPromptVariant(row.systemPromptVariant),
        fullTextStrategyId: getEffectiveFullTextStrategyId(row.fullTextStrategyId),
        useMetadata: row.useMetadata === true,
      }
    })
    .filter((row) => {
      return hasAnyJudgmentAnswer(row)
    })
}
