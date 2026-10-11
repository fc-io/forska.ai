import {getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {getProjectVisibleJudgmentNaturalKeySql} from '../../services/projectVisibleJudgmentRule.ts'
import {canCurrentServerOwnDuckdb} from '../../utils/serverRuntimeRole.ts'
import {getJudgmentJobSqliteService} from './judgmentJobSqliteService.ts'

type JudgmentJobStopQueryRunner = {queryJson: <T>(statement: string) => Promise<T[]>}
type CachedCount = {expiresAt: number; value: number}

const judgedArticleCountCacheTtlMs = 30_000
const judgedArticleCountCache = new Map<string, CachedCount>()

const getProducedJudgmentSql = (jobId: string) => {
  return `
    FROM app.judgment_job produced_job
    INNER JOIN app.project project
      ON project.id = produced_job.project_id
    INNER JOIN app.judgment produced
      ON produced.project_id = produced_job.project_id
    WHERE produced_job.id = ${getSqlLiteral(jobId)}
      AND produced.deleted_at IS NULL
      AND produced.created_at >= produced_job.created_at
      AND ${getProjectVisibleJudgmentNaturalKeySql({judgmentAlias: 'produced', projectAlias: 'project'})}
  `
}

export const getJudgmentJobJudgedArticleIds = async ({
  db,
  jobId,
}: {
  db: JudgmentJobStopQueryRunner
  jobId: string
}): Promise<string[]> => {
  const rows = await db.queryJson<{articleId: string}>(`
    SELECT DISTINCT produced.article_id AS articleId
    ${getProducedJudgmentSql(jobId)}
  `)

  return rows.map((row) => {
    return row.articleId
  })
}

const getJudgmentJobJudgedArticleCount = async ({
  db,
  jobId,
}: {
  db: JudgmentJobStopQueryRunner
  jobId: string
}): Promise<number> => {
  const cached = judgedArticleCountCache.get(jobId)

  if (cached && cached.expiresAt > Date.now()) {
    return cached.value
  }

  const [row] = await db.queryJson<{count: number | string | null}>(`
    SELECT COUNT(DISTINCT produced.article_id) AS count
    ${getProducedJudgmentSql(jobId)}
  `)
  const value = Number(row?.count ?? 0)

  judgedArticleCountCache.set(jobId, {expiresAt: Date.now() + judgedArticleCountCacheTtlMs, value})

  return value
}

export const resetJudgmentJobJudgedArticleCountCacheForTests = (): void => {
  judgedArticleCountCache.clear()
}

export const getJudgmentJobAdmittedArticleCount = async ({
  db,
  jobId,
  stopAfterArticles,
}: {
  db: JudgmentJobStopQueryRunner
  jobId: string
  stopAfterArticles: number | null
}): Promise<number | null> => {
  const localState =
    stopAfterArticles !== null && canCurrentServerOwnDuckdb()
      ? await getJudgmentJobSqliteService().getAdmittedArticleState(jobId)
      : {backfilled: false, count: 0}

  return stopAfterArticles === null
    ? null
    : localState.backfilled
      ? localState.count
      : getJudgmentJobJudgedArticleCount({db, jobId})
}

export const getJudgmentJobTotalTokens = async ({
  db,
  jobId,
}: {
  db: JudgmentJobStopQueryRunner
  jobId: string
}): Promise<number> => {
  const [row] = await db.queryJson<{totalTokens: number | string | null}>(`
    SELECT SUM(total_tokens) AS totalTokens
    FROM app.token_use
    WHERE judgment_job_id = ${getSqlLiteral(jobId)}
  `)

  return Number(row?.totalTokens ?? 0)
}

export const getPendingPairsForAdmittedArticles = async ({
  articleIds,
  db,
  jobId,
}: {
  articleIds: string[]
  db: JudgmentJobStopQueryRunner
  jobId: string
}): Promise<Array<{articleId: string; promptId: string}>> => {
  return articleIds.length === 0
    ? []
    : db.queryJson<{articleId: string; promptId: string}>(`
        WITH admitted(article_id) AS (
          VALUES ${articleIds
            .map((articleId) => {
              return `(${getSqlLiteral(articleId)})`
            })
            .join(', ')}
        ),
        pending_job AS (
          SELECT pending_job.project_id
          FROM app.judgment_job pending_job
          INNER JOIN app.project project
            ON project.id = pending_job.project_id
          WHERE pending_job.id = ${getSqlLiteral(jobId)}
            AND project.archived = FALSE
        ),
        scoped_admitted AS (
          SELECT admitted.article_id
          FROM admitted
          INNER JOIN app.article_import_route article_route
            ON article_route.article_id = admitted.article_id
          INNER JOIN app.project_import_route project_route
            ON project_route.import_route_id = article_route.import_route_id
          INNER JOIN pending_job
            ON pending_job.project_id = project_route.project_id
          UNION
          SELECT admitted.article_id
          FROM admitted
          INNER JOIN app.project_article project_article
            ON project_article.article_id = admitted.article_id
          INNER JOIN pending_job
            ON pending_job.project_id = project_article.project_id
        ),
        candidate_pair AS (
          SELECT scoped_admitted.article_id, project_prompt.prompt_id
          FROM scoped_admitted
          CROSS JOIN pending_job
          INNER JOIN app.project_prompt project_prompt
            ON project_prompt.project_id = pending_job.project_id
            AND project_prompt.enabled = TRUE
            AND NOT project_prompt.archived
          INNER JOIN app.prompt prompt
            ON prompt.id = project_prompt.prompt_id
            AND COALESCE(prompt.archived, FALSE) = FALSE
        ),
        visible_pair AS (
          SELECT DISTINCT visible.article_id, visible.prompt_id
          FROM candidate_pair pair
          CROSS JOIN pending_job
          INNER JOIN app.project project
            ON project.id = pending_job.project_id
          INNER JOIN app.judgment visible
            ON visible.article_id = pair.article_id
            AND visible.prompt_id = pair.prompt_id
          WHERE visible.deleted_at IS NULL
            AND ${getProjectVisibleJudgmentNaturalKeySql({judgmentAlias: 'visible', projectAlias: 'project'})}
        )
        SELECT pair.article_id AS articleId, pair.prompt_id AS promptId
        FROM candidate_pair pair
        LEFT JOIN visible_pair
          ON visible_pair.article_id = pair.article_id
          AND visible_pair.prompt_id = pair.prompt_id
        WHERE visible_pair.article_id IS NULL
        ORDER BY pair.article_id ASC, pair.prompt_id ASC
      `)
}
