import {getSqlLiteral} from './appQueryHelpers.ts'

export type ArticleIdResolutionInput = {articleId: string; projectId?: string | null}

export type ArticleIdResolutionRow = {articleId: string; canonicalArticleId: string | null; projectId: string | null}

type ArticleIdResolutionRunner = {queryJson: <T>(statement: string) => Promise<T[]>}

const getResolutionKey = ({articleId, projectId}: ArticleIdResolutionInput) => {
  return `${projectId ?? ''}|${articleId}`
}

const getUniqueResolutionInputs = (inputs: ArticleIdResolutionInput[]) => {
  return Array.from(
    inputs
      .filter((input) => {
        return input.articleId.trim().length > 0
      })
      .reduce((state, input) => {
        const normalizedInput = {articleId: input.articleId, projectId: input.projectId ?? null}
        return state.has(getResolutionKey(normalizedInput))
          ? state
          : new Map(state).set(getResolutionKey(normalizedInput), normalizedInput)
      }, new Map<string, Required<ArticleIdResolutionInput>>())
      .values(),
  )
}

const getResolutionInputValuesSql = (inputs: Array<Required<ArticleIdResolutionInput>>) => {
  return inputs
    .map((input, index) => {
      return `(${index}, ${getSqlLiteral(input.articleId)}, ${getSqlLiteral(input.projectId)})`
    })
    .join(', ')
}

const getArticleIdResolutionSql = (inputs: Array<Required<ArticleIdResolutionInput>>) => {
  return `
    WITH article_id_input(input_order, article_id, project_id) AS (
      VALUES ${getResolutionInputValuesSql(inputs)}
    ),
    article_id_resolution_candidate AS (
      SELECT
        input_order,
        article_id,
        project_id,
        canonical_article_id,
        resolution_rank
      FROM (
        SELECT
          input.input_order,
          input.article_id,
          input.project_id,
          article.id AS canonical_article_id,
          0 AS resolution_rank
        FROM article_id_input input
        INNER JOIN app.article article ON article.id = input.article_id

        UNION ALL

        SELECT
          input.input_order,
          input.article_id,
          input.project_id,
          legacy.article_id AS canonical_article_id,
          3 AS resolution_rank
        FROM article_id_input input
        INNER JOIN app.article_legacy_id_lookup legacy ON legacy.legacy_article_id = input.article_id

        UNION ALL

        SELECT
          input.input_order,
          input.article_id,
          input.project_id,
          current_import.article_id AS canonical_article_id,
          1 AS resolution_rank
        FROM article_id_input input
        INNER JOIN app.project_import_route project_import_route
          ON input.project_id IS NOT NULL
         AND project_import_route.project_id = input.project_id
        INNER JOIN app.article_import_route current_import
          ON current_import.import_route_id = project_import_route.import_route_id
         AND current_import.external_article_id = input.article_id

        UNION ALL

        SELECT
          input.input_order,
          input.article_id,
          input.project_id,
          source_record.article_id AS canonical_article_id,
          2 AS resolution_rank
        FROM article_id_input input
        INNER JOIN app.project_import_route project_import_route
          ON input.project_id IS NOT NULL
         AND project_import_route.project_id = input.project_id
        INNER JOIN app.article_import_route_source_record source_record
          ON source_record.import_route_id = project_import_route.import_route_id
         AND source_record.external_article_id = input.article_id
         AND source_record.quarantined_at IS NULL
      ) article_id_resolution_candidates
    ),
    selected_article_id_resolution AS (
      SELECT
        candidate.input_order,
        candidate.article_id,
        candidate.project_id,
        CASE
          WHEN COUNT(DISTINCT candidate.canonical_article_id) = 1 THEN MIN(candidate.canonical_article_id)
          ELSE NULL
        END AS canonical_article_id
      FROM article_id_resolution_candidate candidate
      INNER JOIN (
        SELECT input_order, MIN(resolution_rank) AS resolution_rank
        FROM article_id_resolution_candidate
        GROUP BY input_order
      ) best_candidate
        ON best_candidate.input_order = candidate.input_order
       AND best_candidate.resolution_rank = candidate.resolution_rank
      GROUP BY candidate.input_order, candidate.article_id, candidate.project_id
    )
    SELECT
      input.article_id AS articleId,
      resolution.canonical_article_id AS canonicalArticleId,
      input.project_id AS projectId
    FROM article_id_input input
    LEFT JOIN selected_article_id_resolution resolution
      ON resolution.input_order = input.input_order
    ORDER BY input.input_order ASC
  `
}

export const resolveCanonicalArticleIds = async (
  runner: ArticleIdResolutionRunner,
  inputs: ArticleIdResolutionInput[],
): Promise<ArticleIdResolutionRow[]> => {
  const uniqueInputs = getUniqueResolutionInputs(inputs)

  return uniqueInputs.length === 0
    ? []
    : runner.queryJson<ArticleIdResolutionRow>(getArticleIdResolutionSql(uniqueInputs))
}

export const getCanonicalArticleIdResolutionMap = async (
  runner: ArticleIdResolutionRunner,
  inputs: ArticleIdResolutionInput[],
): Promise<Map<string, string>> => {
  const rows = await resolveCanonicalArticleIds(runner, inputs)

  return rows.reduce((state, row) => {
    const canonicalArticleId = row.canonicalArticleId
    return canonicalArticleId === null
      ? state
      : new Map(state).set(getResolutionKey({articleId: row.articleId, projectId: row.projectId}), canonicalArticleId)
  }, new Map<string, string>())
}

export const getCanonicalArticleIdResolutionKey = getResolutionKey
