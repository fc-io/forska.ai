import {type FullTextStrategy, type FullTextStrategyInputs} from '../fullText/fullTextStrategy.ts'
import {appendArticleReviewServingDeltasForIds} from '../reviewServing/articleReviewServingDeltaService.ts'
import {HttpError} from '../utils/httpError.ts'
import {getAppDatabaseService} from './appDatabaseService.ts'
import {getQuotedStringList, getSqlLiteral, getTimestampLiteral} from './appQueryHelpers.ts'

export type ArticleFullTextVersions = {
  canonicalTextVersion: string | null
  converterKind: string | null
  converterOptionsHash: string | null
  converterVersion: string | null
}

type ArticleFullTextVersionKey = keyof ArticleFullTextVersions

type FullTextStrategyConversionInputs = Pick<FullTextStrategyInputs, ArticleFullTextVersionKey>

const articleFullTextVersionKeys: readonly ArticleFullTextVersionKey[] = [
  'canonicalTextVersion',
  'converterKind',
  'converterOptionsHash',
  'converterVersion',
]

const reconversionMutationSource = 'judgmentJobFullTextReconversion'

export const getArticleFullTextVersionDifferences = (
  article: ArticleFullTextVersions,
  inputs: FullTextStrategyConversionInputs,
): ArticleFullTextVersionKey[] => {
  return articleFullTextVersionKeys.filter((key) => {
    return article[key] !== inputs[key]
  })
}

export const isArticleFullTextStaleForStrategy = (
  article: ArticleFullTextVersions,
  inputs: FullTextStrategyConversionInputs,
): boolean => {
  return getArticleFullTextVersionDifferences(article, inputs).length > 0
}

export const getFullTextReconversionMessage = ({
  articleCount,
  strategy,
}: {
  articleCount: number
  strategy: Pick<FullTextStrategy, 'id' | 'label'>
}): string => {
  const articleText = articleCount === 1 ? '1 article is' : `${articleCount} articles are`

  return `${articleText} being reconverted for strategy ${strategy.label} (${strategy.id}); start again when conversion has finished.`
}

const getProjectScopedArticleIdsSql = (projectId: string): string => {
  return `
    WITH scoped_project AS (
      SELECT p.id, p.date_from, p.date_to
      FROM app.project p
      WHERE p.id = ${getSqlLiteral(projectId)}
    )
    SELECT pa.article_id AS article_id
    FROM scoped_project sp
    INNER JOIN app.project_article pa ON pa.project_id = sp.id
    INNER JOIN app.article a ON a.id = pa.article_id
    WHERE (sp.date_from IS NULL OR a.article_created_at >= sp.date_from)
      AND (sp.date_to IS NULL OR a.article_created_at <= sp.date_to)
    UNION
    SELECT air.article_id AS article_id
    FROM scoped_project sp
    INNER JOIN app.project_import_route pir ON pir.project_id = sp.id
    INNER JOIN app.article_import_route air ON air.import_route_id = pir.import_route_id
    INNER JOIN app.article a ON a.id = air.article_id
    WHERE (sp.date_from IS NULL OR a.article_created_at >= sp.date_from)
      AND (sp.date_to IS NULL OR a.article_created_at <= sp.date_to)
  `
}

const getConvertedProjectArticleVersionsSql = (projectId: string): string => {
  return `
    SELECT
      a.id AS id,
      a.full_text_canonical_version AS canonicalTextVersion,
      json_extract_string(a.full_text_conversion_metadata, '$.converterKind') AS converterKind,
      json_extract_string(a.full_text_conversion_metadata, '$.optionsHash') AS converterOptionsHash,
      json_extract_string(a.full_text_conversion_metadata, '$.converterVersion') AS converterVersion
    FROM app.article a
    WHERE a.id IN (${getProjectScopedArticleIdsSql(projectId)})
      AND a.full_text_pdf IS NOT NULL
      AND a.full_text IS NOT NULL
  `
}

const getStaleArticleIds = (
  articles: ReadonlyArray<ArticleFullTextVersions & {id: string}>,
  inputs: FullTextStrategyConversionInputs,
): string[] => {
  return articles
    .filter((article) => {
      return isArticleFullTextStaleForStrategy(article, inputs)
    })
    .map((article) => {
      return article.id
    })
}

export const queueProjectFullTextReconversion = async ({
  projectId,
  strategy,
}: {
  projectId: string
  strategy: FullTextStrategy
}): Promise<string[]> => {
  const queuedAt = new Date()

  return getAppDatabaseService().transaction(async (tx) => {
    const convertedArticles = await tx.queryJson<ArticleFullTextVersions & {id: string}>(
      getConvertedProjectArticleVersionsSql(projectId),
    )
    const articleIds = getStaleArticleIds(convertedArticles, strategy.inputs)

    if (articleIds.length > 0) {
      await tx.run(`
        UPDATE app.article
        SET full_text = NULL,
            full_text_char_count = NULL,
            full_text_canonical_hash = NULL,
            full_text_canonical_version = NULL,
            full_text_figure_mode_built = NULL,
            full_text_conversion_status = NULL,
            full_text_conversion_error = NULL,
            full_text_conversion_attempts = 0,
            updated_at = ${getTimestampLiteral(queuedAt)}
        WHERE id IN (${getQuotedStringList(articleIds).join(', ')})
      `)
      await appendArticleReviewServingDeltasForIds(tx, {
        articleIds,
        changedFields: ['fullText'],
        sourceMutationKey: `${reconversionMutationSource}|${projectId}|${strategy.id}|${queuedAt.toISOString()}`,
        sourceOperation: 'update',
        sourceUpdatedAt: queuedAt,
      })
    }

    return articleIds
  })
}

export const assertProjectFullTextArticlesMatchStrategy = async ({
  projectId,
  strategy,
}: {
  projectId: string
  strategy: FullTextStrategy | null
}): Promise<void> => {
  const queuedArticleIds = strategy ? await queueProjectFullTextReconversion({projectId, strategy}) : []

  if (strategy && queuedArticleIds.length > 0) {
    throw new HttpError(409, getFullTextReconversionMessage({articleCount: queuedArticleIds.length, strategy}))
  }
}
