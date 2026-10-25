import {getDateValue, getSqlLiteral} from '../../../services/appQueryHelpers.ts'
import {normalizeSummaryAnswerValue} from '../../../utils/judgmentAnswers.ts'
import type {ComparisonProjectJudgmentHumanRow} from '../comparisonProjectJudgmentRows/comparisonProjectJudgmentRowsTypes.ts'
import {summaryPromptId} from '../comparisonProjectRouteConstants.ts'
import {appDatabaseService} from '../comparisonProjectRouteServices.ts'
import type {AppQueryRunner} from '../comparisonProjectRouteTypes.ts'
import type {ComparisonProjectScope} from '../comparisonProjectScopeTypes.ts'
import {getInClause} from '../comparisonProjectSqlClauses.ts'
import {isDefined} from '../comparisonProjectValueHelpers.ts'
import {getIsSummaryMode} from '../getIsSummaryMode.ts'

type ComparisonProjectHumanRow = ComparisonProjectJudgmentHumanRow

const judgmentHumanTable = 'app.judgment_human'
const judgmentHumanSummaryTable = 'app.judgment_human_summary'

const getTrimmedTextExistsClause = (column: string) => {
  return `NULLIF(TRIM(COALESCE(${column}, '')), '') IS NOT NULL`
}

const getComparisonProjectPromptHumanRows = async (
  scope: ComparisonProjectScope,
  articleIds: string[],
  queryRunner: AppQueryRunner = appDatabaseService,
) => {
  const promptIds = scope.prompts.map((prompt) => {
    return prompt.id
  })

  if (articleIds.length === 0 || promptIds.length === 0 || !scope.compareWithHumans) {
    return []
  }

  const rows = await queryRunner.queryJson<{
    articleId: string
    promptId: string
    answer: string | null
    updatedAt: unknown
  }>(`
    SELECT
      article_id AS articleId,
      prompt_id AS promptId,
      answer AS answer,
      updated_at AS updatedAt
    FROM ${judgmentHumanTable}
    WHERE article_id IN (${getInClause(articleIds)})
      AND prompt_id IN (${getInClause(promptIds)})
      AND is_answered = TRUE
      AND ${getTrimmedTextExistsClause('answer')}
  `)

  return rows.map((row) => {
    return {...row, updatedAt: getDateValue(row.updatedAt)}
  })
}

const getComparisonProjectSummaryHumanRows = async (
  scope: ComparisonProjectScope,
  articleIds: string[],
  queryRunner: AppQueryRunner = appDatabaseService,
) => {
  if (articleIds.length === 0 || !scope.compareWithHumans || !scope.summarySourceProjectId) {
    return []
  }

  const rows = await queryRunner.queryJson<{articleId: string; answer: string | null; updatedAt: unknown}>(`
    SELECT
      article_id AS articleId,
      answer AS answer,
      updated_at AS updatedAt
    FROM ${judgmentHumanSummaryTable}
    WHERE project_id = ${getSqlLiteral(scope.summarySourceProjectId)}
      AND article_id IN (${getInClause(articleIds)})
      AND ${getTrimmedTextExistsClause('answer')}
  `)

  return rows
    .map<ComparisonProjectHumanRow | null>((row) => {
      const normalizedAnswer = normalizeSummaryAnswerValue(row.answer)

      return normalizedAnswer
        ? {
            articleId: row.articleId,
            promptId: summaryPromptId,
            answer: normalizedAnswer,
            updatedAt: getDateValue(row.updatedAt),
          }
        : null
    })
    .filter(isDefined)
}

export const getComparisonProjectHumanRows = async (
  scope: ComparisonProjectScope,
  articleIds: string[],
  queryRunner: AppQueryRunner = appDatabaseService,
) => {
  return getIsSummaryMode(scope)
    ? getComparisonProjectSummaryHumanRows(scope, articleIds, queryRunner)
    : getComparisonProjectPromptHumanRows(scope, articleIds, queryRunner)
}
