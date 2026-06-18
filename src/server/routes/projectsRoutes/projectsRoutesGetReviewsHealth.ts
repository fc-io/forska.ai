import {Elysia, t} from 'elysia'

import {getReviewServingDiagnostics} from '../../reviewServing/reviewServingDiagnosticsRepository.ts'
import {readReviewServingRows} from '../../reviewServing/reviewServingReader.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString} from '../../services/appQueryHelpers.ts'
import {getCurrentReviewConfigHash} from '../../services/reviewServingProjectConfigIdentity.ts'
import {assertProjectIsActive} from './projectAccessGuard.ts'

const getEnabledPromptCount = async (projectId: string): Promise<number> => {
  const rows = await getAppDatabaseService().queryJson<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.project_prompt
    WHERE project_id = '${escapeSqlString(projectId)}'
      AND enabled = TRUE
  `)

  return rows[0]?.count ?? 0
}

const getHasCuratedArticles = async (projectId: string): Promise<boolean> => {
  const rows = await getAppDatabaseService().queryJson<{articleId: string}>(`
    SELECT article_id AS articleId
    FROM app.project_article
    WHERE project_id = '${escapeSqlString(projectId)}'
    LIMIT 1
  `)

  return rows.length > 0
}

const getHasRouteArticles = async (projectId: string): Promise<boolean> => {
  const rows = await getAppDatabaseService().queryJson<{articleId: string}>(`
    SELECT air.article_id AS articleId
    FROM app.project_import_route pir
    INNER JOIN app.article_import_route air ON air.import_route_id = pir.import_route_id
    WHERE pir.project_id = '${escapeSqlString(projectId)}'
    LIMIT 1
  `)

  return rows.length > 0
}

export const projectsRoutesGetReviewsHealth = new Elysia().post(
  '/api/projectsreviewshealth',
  async ({body}) => {
    const projectId = body.projectId
    await assertProjectIsActive(projectId)
    const reviewConfigHash = await getCurrentReviewConfigHash(projectId)
    const [enabledPromptCount, hasCuratedArticles] = await Promise.all([
      getEnabledPromptCount(projectId),
      getHasCuratedArticles(projectId),
    ])
    const hasAnyArticlesInScope =
      enabledPromptCount === 0 || hasCuratedArticles ? hasCuratedArticles : await getHasRouteArticles(projectId)
    const [servingDiagnostics, healthSnapshot] = await Promise.all([
      getReviewServingDiagnostics({projectId, reviewConfigHash}),
      readReviewServingRows({
        allowStale: true,
        contractKey: 'review.health.snapshot',
        estimatedResultRows: 1,
        limit: 1,
        projectId,
        reviewConfigHash,
      }),
    ])

    return {
      data: {
        projectId,
        enabledPromptCount,
        scope: {hasAnyArticlesInScope},
        serving: {
          diagnostics: servingDiagnostics,
          manifest: healthSnapshot.diagnostics.manifest,
          status: healthSnapshot.status,
        },
      },
    }
  },
  {body: t.Object({projectId: t.String()})},
)
