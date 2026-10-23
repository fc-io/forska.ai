import * as appQueryHelpers from '../../services/appQueryHelpers.ts'
import {appDatabaseService, appQueryService} from './adminInvestigateRoutesServices.ts'
import type {ProjectScope} from './projectScope.ts'

export const fetchProjectScope = async (projectId: string): Promise<ProjectScope | null> => {
  const [projectConfig, curatedRows] = await Promise.all([
    appQueryService.getProjectReviewConfig(projectId),
    appDatabaseService.queryJson<{articleId: string}>(`
      SELECT article_id AS articleId
      FROM app.project_article
      WHERE project_id = '${appQueryHelpers.escapeSqlString(projectId)}'
    `),
  ])

  return projectConfig
    ? {
        modelId: projectConfig.modelId,
        useTitle: projectConfig.useTitle,
        useAbstract: projectConfig.useAbstract,
        useFulltext: projectConfig.useFulltext,
        useFulltextNoImages: projectConfig.useFulltextNoImages,
        useMetadata: projectConfig.useMetadata,
        systemPromptVariant: projectConfig.systemPromptVariant,
        fullTextStrategyId: projectConfig.fullTextStrategyId,
        dateFrom: projectConfig.dateFrom,
        dateTo: projectConfig.dateTo,
        importRouteIds: projectConfig.importRouteIds,
        curatedArticleIds: curatedRows.map((row) => {
          return row.articleId
        }),
      }
    : null
}
