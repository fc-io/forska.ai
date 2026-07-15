import type {Context} from 'elysia'

import {
  getActiveReviewServingSnapshotManifest,
  getLastKnownGoodReviewServingSnapshotManifest,
  type ReviewServingManifestRepositoryDatabase,
} from '../../reviewServing/reviewServingManifestRepository.ts'
import {readReviewServingRows, type ReviewServingReaderDatabase} from '../../reviewServing/reviewServingReader.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString} from '../../services/appQueryHelpers.ts'
import {getCurrentReviewConfigHash} from '../../services/reviewServingProjectConfigIdentity.ts'
import {syncPendingHumanJudgmentsForArticle} from './humanAssessmentPendingJudgments.ts'
import {getHumanAssessmentWorkloadContext} from './humanAssessmentWorkloadContext.ts'

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

type HumanAssessmentArticleRow = {
  article_id?: string
  article_summary?: string | null
  article_title?: string | null
  articleId?: string
  articleSummary?: string | null
  articleTitle?: string | null
}
type HumanAssessmentQueueRow = {article_id?: string; articleId?: string}

const summaryModeBlockedMessage = 'Summary-mode projects do not support prompt-based human assessment'

const getNextHumanAssessmentArticleFromServing = async (projectId: string) => {
  const database = getAppDatabaseService() as ReviewServingManifestRepositoryDatabase & ReviewServingReaderDatabase
  const reviewConfigHash = await getCurrentReviewConfigHash(projectId)
  const activeManifest = await getActiveReviewServingSnapshotManifest({projectId, reviewConfigHash}, database)
  const manifest =
    activeManifest ?? (await getLastKnownGoodReviewServingSnapshotManifest({projectId, reviewConfigHash}, database))

  if (!manifest) {
    return null
  }

  const queueResult = await readReviewServingRows<HumanAssessmentQueueRow>(
    {
      allowStale: !activeManifest,
      contractKey: 'review.queue.unassessed',
      filters: {queueKind: 'human-unreviewed'},
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

  if (queueResult.status === 'rejected') {
    return null
  }

  const row = queueResult.rows[0]
  const articleId = row?.article_id ?? row?.articleId ?? null

  if (!articleId) {
    return null
  }

  const articleResult = await readReviewServingRows<HumanAssessmentArticleRow>(
    {
      allowStale: !activeManifest,
      articleIds: [articleId],
      contractKey: 'review.unassessed.rowsByArticleSet',
      filters: {articleId, queueKind: 'human-unreviewed'},
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

  if (articleResult.status === 'rejected') {
    return null
  }

  const article = articleResult.rows[0]
  const servingArticleId = article?.article_id ?? article?.articleId ?? null

  return servingArticleId
    ? {
        articleSummary: article?.article_summary ?? article?.articleSummary ?? null,
        articleTitle: article?.article_title ?? article?.articleTitle ?? '',
        id: servingArticleId,
      }
    : null
}

export const humanAssessmentRoutesPostInit = async ({body, set}: {body: {projectId: string}; set: Context['set']}) => {
  const [project] = await getAppDatabaseService().queryJson<{
    humanJudgmentMode: 'prompt' | 'summary' | null
    id: string
    name: string
  }>(
    `
    SELECT id, name, human_judgment_mode AS humanJudgmentMode
    FROM app.project
    WHERE id = '${escapeSqlString(body.projectId)}'
    LIMIT 1
  `,
    getHumanAssessmentWorkloadContext({maxResultRows: 1, operation: 'init.projectLookup', projectId: body.projectId}),
  )
  if (!project) {
    set.status = 404
    return {data: null, error: 'Project not found'}
  }
  const humanJudgmentMode = project.humanJudgmentMode ?? 'prompt'

  if (humanJudgmentMode === 'summary') {
    set.status = 409
    return {data: null, error: summaryModeBlockedMessage}
  }

  const projectPromptRows = await getAppDatabaseService().queryJson<InitResponse['prompts'][number]>(
    `
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
  `,
    getHumanAssessmentWorkloadContext({
      maxResultRows: 500,
      operation: 'init.projectPrompts',
      projectId: body.projectId,
    }),
  )

  if (projectPromptRows.length === 0) {
    set.status = 400
    return {data: null, error: 'Project has no prompts configured'}
  }

  const existingUnanswered = await getAppDatabaseService().queryJson<{id: string; articleId: string}>(
    `
    SELECT id, article_id AS articleId
    FROM app.judgment_human
    WHERE project_id = '${escapeSqlString(body.projectId)}'
      AND is_answered = FALSE
    ORDER BY created_at DESC
    LIMIT 50
  `,
    getHumanAssessmentWorkloadContext({
      maxResultRows: 50,
      operation: 'init.existingUnanswered',
      projectId: body.projectId,
    }),
  )
  let targetArticleId: string | null = null
  const firstUnanswered = existingUnanswered[0]
  if (firstUnanswered) {
    targetArticleId = firstUnanswered.articleId
  }

  if (!targetArticleId) {
    const servingArticle = await getNextHumanAssessmentArticleFromServing(body.projectId)

    if (!servingArticle) {
      set.status = 404
      return {data: null, error: 'No articles left to judge'}
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
  }>(
    `
    SELECT id, article_title AS articleTitle, article_summary AS articleSummary
    FROM app.article
    WHERE id = '${escapeSqlString(targetId)}'
    LIMIT 1
  `,
    getHumanAssessmentWorkloadContext({maxResultRows: 1, operation: 'init.articleLookup', projectId: body.projectId}),
  )

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
