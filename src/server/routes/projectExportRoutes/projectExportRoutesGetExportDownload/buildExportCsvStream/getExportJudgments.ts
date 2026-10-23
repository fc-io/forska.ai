import {getAppDatabaseService} from '../../../../services/appDatabaseService.ts'
import {getSqlLiteral} from '../../../../services/appQueryHelpers.ts'
import {getProjectExportWorkloadContext} from '../../getProjectExportWorkloadContext.ts'
import type {ExportJudgmentRow, ExportServingSnapshotScope} from '../projectExportDownloadTypes.ts'

export const getExportJudgments = async (input: {
  articleIds: string[]
  promptIds: string[]
  projectId: string
  snapshotScopes: ExportServingSnapshotScope[]
}) => {
  if (input.promptIds.length === 0 || input.articleIds.length === 0 || input.snapshotScopes.length === 0) {
    return []
  }

  const scopeRows = input.snapshotScopes
    .map((scope, index) => {
      return `(${getSqlLiteral(scope.projectId)}, ${getSqlLiteral(scope.reviewConfigHash)}, ${getSqlLiteral(scope.snapshotId)}, ${index})`
    })
    .join(', ')
  const articleRows = input.articleIds
    .map((articleId) => {
      return `(${getSqlLiteral(articleId)})`
    })
    .join(', ')
  const promptRows = input.promptIds
    .map((promptId) => {
      return `(${getSqlLiteral(promptId)})`
    })
    .join(', ')
  const maxResultRows = input.articleIds.length * input.promptIds.length * Math.max(input.snapshotScopes.length, 1)
  const rows = await getAppDatabaseService().queryJson<ExportJudgmentRow & {sourceProjectOrder: number}>(
    `
    WITH
      export_scope(project_id, review_config_hash, snapshot_id, source_project_order) AS (VALUES ${scopeRows}),
      export_article(article_id) AS (VALUES ${articleRows}),
      export_prompt(prompt_id) AS (VALUES ${promptRows}),
      ranked_export_judgment AS (
        SELECT
          detail.article_id AS articleId,
          detail.prompt_id AS promptId,
          detail.answered_original AS answeredOriginal,
          TO_JSON(detail.answered_original_as_array) AS answeredOriginalAsArray,
          judgment.explanation AS explanation,
          judgment.full_text_strategy_id AS fullTextStrategyId,
          judgment.quotes AS quotes,
          judgment.use_fulltext_no_images AS useFulltextNoImages,
          export_scope.source_project_order AS sourceProjectOrder,
          ROW_NUMBER() OVER (
            PARTITION BY detail.article_id, detail.prompt_id
            ORDER BY export_scope.source_project_order ASC
          ) AS exportJudgmentRank
        FROM export_scope
        INNER JOIN mart.review_article_judgment_detail_serving_v4 detail
         ON detail.project_id = export_scope.project_id
         AND detail.review_config_hash IS NOT DISTINCT FROM export_scope.review_config_hash
         AND detail.snapshot_id = export_scope.snapshot_id
         AND detail.payload_kind = 'llm'
        INNER JOIN export_article
          ON export_article.article_id = detail.article_id
        INNER JOIN export_prompt
          ON export_prompt.prompt_id = detail.prompt_id
        LEFT JOIN app."judgment" judgment
          ON judgment.id = detail.judgment_id
         AND judgment.article_id = detail.article_id
         AND judgment.prompt_id = detail.prompt_id
         AND judgment.deleted_at IS NULL
      )
    SELECT * EXCLUDE (exportJudgmentRank)
    FROM ranked_export_judgment
    WHERE exportJudgmentRank = 1
    ORDER BY articleId ASC, promptId ASC, sourceProjectOrder ASC
    LIMIT ${getSqlLiteral(maxResultRows)}
  `,
    getProjectExportWorkloadContext({maxResultRows, operation: 'servingJudgments', projectId: input.projectId}),
  )

  return rows.reduce<ExportJudgmentRow[]>((judgments, row) => {
    return judgments.some((judgment) => {
      return judgment.articleId === row.articleId && judgment.promptId === row.promptId
    })
      ? judgments
      : [...judgments, row]
  }, [])
}
