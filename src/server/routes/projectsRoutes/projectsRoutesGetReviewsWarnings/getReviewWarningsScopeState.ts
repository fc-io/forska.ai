import {escapeSqlString} from '../../../services/appQueryHelpers.ts'
import {getApiReadOnlyAppDatabaseService} from '../../../services/appReadOnlyDatabaseService.ts'
import {
  getProjectScopeMartArticleCountSql,
  getProjectScopeTableArticleSql,
} from '../../../services/projectScopeArticleCount.ts'
import {getReviewWarningsWorkloadContext} from './getReviewWarningsWorkloadContext.ts'

export const getReviewWarningsScopeState = async (projectId: string) => {
  const [martScope] = await getApiReadOnlyAppDatabaseService().queryJson<{totalArticleCount: number}>(
    getProjectScopeMartArticleCountSql(projectId),
    getReviewWarningsWorkloadContext(projectId, 'scopeMartState'),
  )
  const martScopeArticleCount = Number(martScope?.totalArticleCount ?? 0)
  const [state] = await getApiReadOnlyAppDatabaseService().queryJson<{
    enabledPromptCount: number
    hasAnyArticlesInScope: boolean
    totalArticleCount?: number
  }>(
    martScopeArticleCount > 0
      ? `
    SELECT
      CAST((
        SELECT COUNT(*)
        FROM app.project_prompt project_prompt
        INNER JOIN app.prompt prompt
          ON prompt.id = project_prompt.prompt_id
        WHERE project_prompt.project_id = '${escapeSqlString(projectId)}'
          AND project_prompt.enabled = TRUE
          AND NOT project_prompt.archived
          AND COALESCE(prompt.archived, FALSE) = FALSE
      ) AS INTEGER) AS enabledPromptCount,
      TRUE AS hasAnyArticlesInScope
  `
      : `
    WITH enabled_prompt AS (
      SELECT COUNT(*) AS enabledPromptCount
      FROM app.project_prompt project_prompt
      INNER JOIN app.prompt prompt
        ON prompt.id = project_prompt.prompt_id
      WHERE project_prompt.project_id = '${escapeSqlString(projectId)}'
        AND project_prompt.enabled = TRUE
        AND NOT project_prompt.archived
        AND COALESCE(prompt.archived, FALSE) = FALSE
    ), scoped_article AS (
      ${getProjectScopeTableArticleSql(projectId)}
    )
    SELECT
      CAST((SELECT enabledPromptCount FROM enabled_prompt) AS INTEGER) AS enabledPromptCount,
      EXISTS (SELECT 1 FROM scoped_article) AS hasAnyArticlesInScope,
      CAST((SELECT COUNT(DISTINCT articleId) FROM scoped_article) AS INTEGER) AS totalArticleCount
  `,
    getReviewWarningsWorkloadContext(projectId, 'scopeState'),
  )

  return {
    enabledPromptCount: Number(state?.enabledPromptCount ?? 0),
    hasAnyArticlesInScope: state?.hasAnyArticlesInScope ?? false,
    totalArticleCount: martScopeArticleCount > 0 ? martScopeArticleCount : Number(state?.totalArticleCount ?? 0),
  }
}
