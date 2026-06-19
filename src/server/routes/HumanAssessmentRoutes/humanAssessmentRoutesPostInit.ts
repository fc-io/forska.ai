import type {Context} from 'elysia'

import {
  getActiveReviewServingSnapshotManifest,
  getLastKnownGoodReviewServingSnapshotManifest,
  type ReviewServingManifestRepositoryDatabase,
} from '../../reviewServing/reviewServingManifestRepository.ts'
import {readReviewServingRows, type ReviewServingReaderDatabase} from '../../reviewServing/reviewServingReader.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getDateValue} from '../../services/appQueryHelpers.ts'
import {getCurrentReviewConfigHash} from '../../services/reviewServingProjectConfigIdentity.ts'
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

type HumanAssessmentQueueRow = {article_id?: string; articleId?: string}
type ProjectDateBounds = {dateFrom: Date | null; dateTo: Date | null}

const summaryModeBlockedMessage = 'Summary-mode projects do not support prompt-based human assessment'

const getDateBoundFilters = (project: ProjectDateBounds) => {
  return {
    ...(project.dateFrom ? {articleCreatedAtFrom: project.dateFrom.toISOString()} : {}),
    ...(project.dateTo ? {articleCreatedAtTo: project.dateTo.toISOString()} : {}),
  }
}

const getNextHumanAssessmentArticleIdFromServing = async (projectId: string, project: ProjectDateBounds) => {
  const database = getAppDatabaseService() as ReviewServingManifestRepositoryDatabase & ReviewServingReaderDatabase
  const reviewConfigHash = await getCurrentReviewConfigHash(projectId)
  const manifest =
    (await getActiveReviewServingSnapshotManifest({projectId, reviewConfigHash}, database))
    ?? (await getLastKnownGoodReviewServingSnapshotManifest({projectId, reviewConfigHash}, database))

  if (!manifest) {
    return {articleId: null, error: 'Review serving snapshot is unavailable'}
  }

  const result = await readReviewServingRows<HumanAssessmentQueueRow>(
    {
      allowStale: false,
      contractKey: 'review.queue.unassessed',
      filters: {...getDateBoundFilters(project), queueKind: 'human-unreviewed'},
      limit: 1,
      listMode: 'unassessed',
      projectId,
      queueKind: 'human-unreviewed',
      reviewConfigHash: manifest.reviewConfigHash,
      searchMode: 'none',
      searchState: null,
      searchTokenPrefix: null,
      snapshotId: manifest.snapshotId,
    },
    {database, diagnosticsDatabase: database, manifestDatabase: database},
  )

  if (result.status === 'rejected') {
    return {articleId: null, error: `reviewServingReader rejected human assessment queue: ${result.reason}`}
  }

  const row = result.rows[0]

  return {articleId: row?.article_id ?? row?.articleId ?? null, error: null}
}

const getNextHumanAssessmentArticleIdFromScope = async (projectId: string) => {
  const [row] = await getAppDatabaseService().queryJson<{articleId: string}>(`
    SELECT scope_article.article_id AS articleId
    FROM mart.project_scope_article scope_article
    WHERE scope_article.project_id = '${escapeSqlString(projectId)}'
      AND EXISTS (
        SELECT 1
        FROM app.project project
        WHERE project.id = scope_article.project_id
          AND (project.date_from IS NULL OR scope_article.article_created_at >= project.date_from)
          AND (project.date_to IS NULL OR scope_article.article_created_at <= project.date_to)
      )
      AND NOT EXISTS (
        SELECT 1
        FROM app.judgment_human judgment
        WHERE judgment.project_id = scope_article.project_id
          AND judgment.article_id = scope_article.article_id
          AND judgment.is_answered = TRUE
      )
    ORDER BY scope_article.article_created_at ASC NULLS LAST, scope_article.article_id ASC
    LIMIT 1
  `)

  return row?.articleId ?? null
}

export const humanAssessmentRoutesPostInit = async ({body, set}: {body: {projectId: string}; set: Context['set']}) => {
  const [project] = await getAppDatabaseService().queryJson<{
    dateFrom: unknown
    dateTo: unknown
    humanJudgmentMode: 'prompt' | 'summary' | null
    id: string
    name: string
  }>(`
    SELECT id, name, date_from AS dateFrom, date_to AS dateTo, human_judgment_mode AS humanJudgmentMode
    FROM app.project
    WHERE id = '${escapeSqlString(body.projectId)}'
    LIMIT 1
  `)
  if (!project) {
    set.status = 404
    return {data: null, error: 'Project not found'}
  }
  const humanJudgmentMode = project.humanJudgmentMode ?? 'prompt'
  const projectDateBounds = {dateFrom: getDateValue(project.dateFrom), dateTo: getDateValue(project.dateTo)}

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
    const servingCandidate = await getNextHumanAssessmentArticleIdFromServing(body.projectId, projectDateBounds)

    if (servingCandidate.error) {
      set.status = 503
      return {data: null, error: servingCandidate.error}
    }

    const candidateArticleId =
      servingCandidate.articleId ?? (await getNextHumanAssessmentArticleIdFromScope(body.projectId))

    if (!candidateArticleId) {
      set.status = 404
      return {data: null, error: 'No articles left to judge'}
    }

    const [servingArticle] = await getAppDatabaseService().queryJson<{
      id: string
      articleTitle: string
      articleSummary: string | null
    }>(`
      SELECT id, article_title AS articleTitle, article_summary AS articleSummary
      FROM app.article
      WHERE id = '${escapeSqlString(candidateArticleId)}'
      LIMIT 1
    `)

    if (!servingArticle) {
      set.status = 404
      return {data: null, error: 'Queued article not found'}
    }

    const articleId = servingArticle.id

    const syncedPending = await syncPendingHumanJudgmentsForArticle({
      articleId,
      projectId: body.projectId,
      prompts: projectPromptRows,
    })

    const response: InitResponse = {
      project: {id: project.id, name: project.name},
      article: servingArticle,
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
