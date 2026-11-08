import {getAppDatabaseService} from './appDatabaseService.ts'
import {getSqlLiteral} from './appQueryHelpers.ts'
import {getProjectVisibleJudgmentPromptSql} from './projectVisibleJudgmentRule.ts'

export type ArticleProviderFailure = {
  attemptCount: number
  failureCode: string
  failureCount: number
  lastFailedAt: string
  modelName: string | null
  promptId: string
  providerKind: string | null
  reason: string
}

type QueryWorkloadContext = Parameters<ReturnType<typeof getAppDatabaseService>['queryJson']>[1]

// Failed closeouts recorded for this project's judgment identity. The caller shows one only where the prompt
// has neither a judgment nor a refusal.
export const getProjectArticleProviderFailures = async ({
  articleId,
  projectId,
  workloadContext,
}: {
  articleId: string
  projectId: string
  workloadContext: QueryWorkloadContext
}): Promise<ArticleProviderFailure[]> => {
  return getAppDatabaseService().queryJson<ArticleProviderFailure>(
    `
    SELECT
      failure.prompt_id AS promptId,
      failure.failure_code AS failureCode,
      failure.reason,
      failure.model_name AS modelName,
      failure.provider_kind AS providerKind,
      failure.attempt_count AS attemptCount,
      failure.failure_count AS failureCount,
      strftime(failure.last_failed_at AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%S.%gZ') AS lastFailedAt
    FROM app.judgment_prompt_failure failure
    INNER JOIN app.project project
      ON project.id = ${getSqlLiteral(projectId)}
    INNER JOIN app.project_prompt project_prompt
      ON ${getProjectVisibleJudgmentPromptSql({
        judgmentAlias: 'failure',
        projectAlias: 'project',
        projectPromptAlias: 'project_prompt',
      })}
    WHERE failure.article_id = ${getSqlLiteral(articleId)}
    ORDER BY failure.prompt_id
  `,
    workloadContext,
  )
}
