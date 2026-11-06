import {getAppDatabaseService} from './appDatabaseService.ts'
import {getSqlLiteral} from './appQueryHelpers.ts'
import {getProjectVisibleJudgmentPromptSql} from './projectVisibleJudgmentRule.ts'

export type ArticleProviderRefusal = {
  failureCode: string
  modelName: string
  promptId: string
  providerKind: string | null
  reason: string
  refusedAt: string
}

type QueryWorkloadContext = Parameters<ReturnType<typeof getAppDatabaseService>['queryJson']>[1]

export const getProjectArticleProviderRefusals = async ({
  articleId,
  projectId,
  workloadContext,
}: {
  articleId: string
  projectId: string
  workloadContext: QueryWorkloadContext
}): Promise<ArticleProviderRefusal[]> => {
  return getAppDatabaseService().queryJson<ArticleProviderRefusal>(
    `
    SELECT
      refusal.prompt_id AS promptId,
      refusal.failure_code AS failureCode,
      refusal.model_name AS modelName,
      refusal.provider_kind AS providerKind,
      refusal.reason,
      strftime(refusal.refused_at AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%S.%gZ') AS refusedAt
    FROM app.judgment_refusal refusal
    INNER JOIN app.project project
      ON project.id = ${getSqlLiteral(projectId)}
    INNER JOIN app.project_prompt project_prompt
      ON ${getProjectVisibleJudgmentPromptSql({
        judgmentAlias: 'refusal',
        projectAlias: 'project',
        projectPromptAlias: 'project_prompt',
      })}
    WHERE refusal.article_id = ${getSqlLiteral(articleId)}
    ORDER BY refusal.prompt_id
  `,
    workloadContext,
  )
}
