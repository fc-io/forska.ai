import type {Context} from 'elysia'

import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getProjectScopeClause, getTimestampLiteral} from '../../services/appQueryHelpers.ts'
import {getAppQueryService} from '../../services/getAppQueryService.ts'
import {syncPendingHumanJudgmentsForArticle} from './humanAssessmentPendingJudgments.ts'

type InitResponse = {
  project: {id: string; name: string}
  article: {id: string; articleTitle: string; articleSummary: string | null}
  prompts: Array<{
    id: string
    originalText: string
    promptHeading: string | null
    order: number | null
    type: string | null
  }>
  judgmentsHuman: Array<{id: string; promptId: string}>
}

const summaryModeBlockedMessage = 'Summary-mode projects do not support prompt-based human assessment'

export const humanAssessmentRoutesPostInit = async ({body, set}: {body: {projectId: string}; set: Context['set']}) => {
  const [project] = await getAppDatabaseService().queryJson<{
    humanJudgmentMode: 'prompt' | 'summary' | null
    id: string
    name: string
  }>(`
    SELECT id, name, human_judgment_mode AS humanJudgmentMode
    FROM app.project
    WHERE id = '${escapeSqlString(body.projectId)}'
    LIMIT 1
  `)
  if (!project) {
    set.status = 404
    return {data: null, error: 'Project not found'}
  }
  const humanJudgmentMode = project.humanJudgmentMode ?? 'prompt'

  if (humanJudgmentMode === 'summary') {
    set.status = 409
    return {data: null, error: summaryModeBlockedMessage}
  }

  const projectPromptRows = await getAppDatabaseService().queryJson<InitResponse['prompts'][number]>(`
    SELECT
      p.id AS id,
      p.original_text AS originalText,
      p.prompt_heading AS promptHeading,
      pp.prompt_order AS "order",
      p.type AS type
    FROM app.project_prompt pp
    INNER JOIN app.prompt p ON pp.prompt_id = p.id
    WHERE pp.project_id = '${escapeSqlString(body.projectId)}'
    ORDER BY pp.prompt_order ASC NULLS LAST, p.created_at ASC
  `)

  if (projectPromptRows.length === 0) {
    set.status = 400
    return {data: null, error: 'Project has no prompts configured'}
  }

  const existingUnanswered = await getAppDatabaseService().queryJson<{id: string; articleId: string}>(`
    SELECT id, article_id AS articleId
    FROM app.judgment_human
    WHERE project_id = '${escapeSqlString(body.projectId)}'
      AND is_answered = FALSE
    ORDER BY created_at DESC
    LIMIT 50
  `)
  let targetArticleId: string | null = null
  const firstUnanswered = existingUnanswered[0]
  if (firstUnanswered) {
    targetArticleId = firstUnanswered.articleId
  }

  if (!targetArticleId) {
    const projectConfig = await getAppQueryService().getProjectReviewConfig(body.projectId)
    const hasCuratedArticles = await getAppDatabaseService().queryJson<{articleId: string}>(`
      SELECT article_id AS articleId
      FROM app.project_article
      WHERE project_id = '${escapeSqlString(body.projectId)}'
      LIMIT 1
    `)
    const hasImportRoutes = (projectConfig?.importRouteIds.length ?? 0) > 0

    if (!hasImportRoutes && hasCuratedArticles.length === 0) {
      set.status = 404
      return {data: null, error: 'No import routes AND no curated articles'}
    }
    const whereParts = [
      getProjectScopeClause({
        articleAlias: 'a',
        importRouteIds: projectConfig?.importRouteIds ?? [],
        projectId: body.projectId,
      }),
      projectConfig?.dateFrom ? `a.article_created_at >= ${getTimestampLiteral(projectConfig.dateFrom)}` : null,
      projectConfig?.dateTo ? `a.article_created_at <= ${getTimestampLiteral(projectConfig.dateTo)}` : null,
      `NOT EXISTS (
        SELECT 1
        FROM app.judgment_human jh
        WHERE jh.project_id = '${escapeSqlString(body.projectId)}'
          AND jh.article_id = a.id
        LIMIT 1
      )`,
    ].filter((part): part is string => {
      return part !== null
    })

    const [randomArticle] = await getAppDatabaseService().queryJson<{
      id: string
      articleTitle: string
      articleSummary: string | null
    }>(`
      SELECT id, article_title AS articleTitle, article_summary AS articleSummary
      FROM app.article a
      WHERE ${whereParts.join(' AND ')}
      ORDER BY RANDOM()
      LIMIT 1
    `)

    if (!randomArticle) {
      set.status = 404
      return {data: null, error: 'No articles left to judge'}
    }

    const articleId = randomArticle.id

    const syncedPending = await syncPendingHumanJudgmentsForArticle({
      articleId,
      projectId: body.projectId,
      prompts: projectPromptRows,
    })

    const response: InitResponse = {
      project: {id: project.id, name: project.name},
      article: randomArticle,
      prompts: projectPromptRows,
      judgmentsHuman: syncedPending,
    }

    return {data: response}
  }

  const targetId = targetArticleId
  if (!targetId) {
    set.status = 404
    return {data: null, error: 'No pending human assessments found'}
  }
  const [articleRow] = await getAppDatabaseService().queryJson<{
    id: string
    articleTitle: string
    articleSummary: string | null
  }>(`
    SELECT id, article_title AS articleTitle, article_summary AS articleSummary
    FROM app.article
    WHERE id = '${escapeSqlString(targetId)}'
    LIMIT 1
  `)

  if (!articleRow) {
    set.status = 404
    return {data: null, error: 'Article not found'}
  }

  const pendingForArticle = await syncPendingHumanJudgmentsForArticle({
    articleId: targetId,
    projectId: body.projectId,
    prompts: projectPromptRows,
  })

  const response: InitResponse = {
    project: {id: project.id, name: project.name},
    article: articleRow,
    prompts: projectPromptRows,
    judgmentsHuman: pendingForArticle,
  }

  return {data: response}
}
