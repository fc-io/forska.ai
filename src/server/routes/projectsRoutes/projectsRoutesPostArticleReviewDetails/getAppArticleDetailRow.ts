import {getAppDatabaseService} from '../../../services/appDatabaseService.ts'
import {getSqlLiteral} from '../../../services/appQueryHelpers.ts'
import type {ServingArticleDetailRow} from './articleReviewDetailTypes.ts'
import {getProjectReviewDetailsWorkloadContext} from './getProjectReviewDetailsWorkloadContext.ts'
import {getProjectScopeArticleCteSql} from './getProjectScopeArticleCteSql.ts'

export const getAppArticleDetailRow = async (input: {articleId: string; projectId: string}) => {
  const rows = await getAppDatabaseService().queryJson<ServingArticleDetailRow>(
    `
    WITH ${getProjectScopeArticleCteSql(input)}
    SELECT
      article.article_created_at AS article_created_at,
      article.article_id AS article_external_id,
      article.id AS article_id,
      article.article_title AS article_title,
      article.article_updated_at AS article_updated_at,
      article.arxiv_id AS arxiv_id,
      article.biorxiv_id AS biorxiv_id,
      article.doi AS doi,
      article.full_text_conversion_status AS full_text_conversion_status,
      article.full_text_fetched_at AS full_text_fetched_at,
      article.full_text_pdf AS full_text_pdf,
      article.medrxiv_id AS medrxiv_id,
      article.pubmed_id AS pmid,
      article.source_metadata AS source_metadata,
      article.url AS url
    FROM app.article article
    INNER JOIN project_scope_article scope_article ON scope_article.article_id = article.id
    WHERE article.id = ${getSqlLiteral(input.articleId)}
    LIMIT 1
  `,
    getProjectReviewDetailsWorkloadContext({
      maxResultRows: 1,
      operation: 'appArticleDetail',
      projectId: input.projectId,
    }),
  )

  return rows[0] ?? null
}
