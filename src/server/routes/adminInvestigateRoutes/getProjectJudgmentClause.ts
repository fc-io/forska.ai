import * as appQueryHelpers from '../../services/appQueryHelpers.ts'
import type {ProjectScope} from './projectScope.ts'

export const getProjectJudgmentClause = (projectScope: ProjectScope | null, judgmentAlias: string) => {
  if (!projectScope) {
    return null
  }

  const curatedClause =
    projectScope.curatedArticleIds.length > 0
      ? `a.id IN (${appQueryHelpers.getQuotedStringList(projectScope.curatedArticleIds).join(', ')})`
      : null
  const routeOrCuratedClause = appQueryHelpers.getAndClause([
    `a.id = ${judgmentAlias}.article_id`,
    projectScope.importRouteIds.length > 0 || curatedClause
      ? `(${[
          projectScope.importRouteIds.length > 0
            ? `EXISTS (
                SELECT 1
                FROM app.article_import_route air
                WHERE air.article_id = a.id
                  AND air.import_route_id IN (${appQueryHelpers.getQuotedStringList(projectScope.importRouteIds).join(', ')})
              )`
            : null,
          curatedClause,
        ]
          .filter(Boolean)
          .join(' OR ')})`
      : null,
    projectScope.dateFrom ? `a.article_created_at >= ${appQueryHelpers.getSqlLiteral(projectScope.dateFrom)}` : null,
    projectScope.dateTo ? `a.article_created_at <= ${appQueryHelpers.getSqlLiteral(projectScope.dateTo)}` : null,
  ])

  return appQueryHelpers.getAndClause([
    `${judgmentAlias}.model_id = ${appQueryHelpers.getSqlLiteral(projectScope.modelId)}`,
    `${judgmentAlias}.use_title = ${appQueryHelpers.getSqlLiteral(projectScope.useTitle)}`,
    `${judgmentAlias}.use_abstract = ${appQueryHelpers.getSqlLiteral(projectScope.useAbstract)}`,
    `${judgmentAlias}.use_fulltext = ${appQueryHelpers.getSqlLiteral(projectScope.useFulltext)}`,
    `${judgmentAlias}.use_fulltext_no_images = ${appQueryHelpers.getSqlLiteral(projectScope.useFulltextNoImages)}`,
    `${judgmentAlias}.use_metadata = ${appQueryHelpers.getSqlLiteral(projectScope.useMetadata)}`,
    `${judgmentAlias}.system_prompt_variant = ${appQueryHelpers.getSqlLiteral(projectScope.systemPromptVariant)}`,
    `${judgmentAlias}.full_text_strategy_id = ${appQueryHelpers.getSqlLiteral(projectScope.fullTextStrategyId)}`,
    routeOrCuratedClause ? `EXISTS (SELECT 1 FROM app.article a WHERE ${routeOrCuratedClause})` : null,
  ])
}
