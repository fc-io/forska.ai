import {getHumanAnsweredPairJoin} from '../../reviewServing/reviewServingJudgmentJobQueueService.ts'
import {getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {
  getProjectScopeMartArticleCountSql,
  getProjectScopeMartArticleSql,
  getProjectScopeTableArticleSql,
} from '../../services/projectScopeArticleCount.ts'
import {getJudgmentJobCurrentAdmittedArticleCount, getJudgmentJobTotalTokens} from './judgmentJobAdmittedArticles.ts'

type JudgmentJobStopDefaultsQueryRunner = {queryJson: <T>(statement: string) => Promise<T[]>}

export type JudgmentJobStopConditionDefaults = {
  admittedArticleCount: number
  articleCount: number
  humanJudgedArticleCount: number
  totalTokens: number
}

const stopConditionDefaultsCacheTtlMs = 30_000
const stopConditionDefaultsCache = new Map<
  string,
  {expiresAt: number; value: Promise<JudgmentJobStopConditionDefaults>}
>()

export const resetJudgmentJobStopConditionDefaultsCacheForTests = (): void => {
  stopConditionDefaultsCache.clear()
}

const getHumanJudgedArticleCountSql = ({
  humanJudgmentMode,
  projectId,
  scopeArticleSql,
}: {
  humanJudgmentMode: 'prompt' | 'summary'
  projectId: string
  scopeArticleSql: string
}) => {
  return `
    WITH scope_article AS (
      ${scopeArticleSql}
    ),
    human_touched_article AS (
      SELECT human.article_id
      FROM app.judgment_human human
      WHERE human.project_id = ${getSqlLiteral(projectId)}
      UNION
      SELECT human_summary.article_id
      FROM app.judgment_human_summary human_summary
      WHERE human_summary.project_id = ${getSqlLiteral(projectId)}
    ),
    enabled_prompt AS (
      SELECT project_prompt.prompt_id
      FROM app.project_prompt project_prompt
      INNER JOIN app.prompt prompt
        ON prompt.id = project_prompt.prompt_id
      WHERE project_prompt.project_id = ${getSqlLiteral(projectId)}
        AND project_prompt.enabled = TRUE
        AND NOT project_prompt.archived
        AND COALESCE(prompt.archived, FALSE) = FALSE
    ),
    candidate_pair AS (
      SELECT DISTINCT scope_article.articleId AS article_id, enabled_prompt.prompt_id
      FROM scope_article
      INNER JOIN human_touched_article
        ON human_touched_article.article_id = scope_article.articleId
      CROSS JOIN enabled_prompt
    )
    SELECT CAST(COUNT(DISTINCT queue.article_id) AS INTEGER) AS humanJudgedArticleCount
    FROM candidate_pair queue
    ${getHumanAnsweredPairJoin(projectId, humanJudgmentMode)}
  `
}

const getProjectStopConditionArticleCounts = async ({
  db,
  projectId,
}: {
  db: JudgmentJobStopDefaultsQueryRunner
  projectId: string
}): Promise<{articleCount: number; humanJudgedArticleCount: number}> => {
  const [[martScope], [project]] = await Promise.all([
    db.queryJson<{totalArticleCount: number | string | null}>(getProjectScopeMartArticleCountSql(projectId)),
    db.queryJson<{humanJudgmentMode: string | null}>(`
      SELECT COALESCE(human_judgment_mode, 'prompt') AS humanJudgmentMode
      FROM app.project
      WHERE id = ${getSqlLiteral(projectId)}
      LIMIT 1
    `),
  ])
  const martArticleCount = Number(martScope?.totalArticleCount ?? 0)
  const scopeArticleSql =
    martArticleCount > 0 ? getProjectScopeMartArticleSql(projectId) : getProjectScopeTableArticleSql(projectId)
  const [[tableScope], [human]] = await Promise.all([
    martArticleCount > 0
      ? Promise.resolve([{totalArticleCount: martArticleCount}])
      : db.queryJson<{totalArticleCount: number | string | null}>(`
          SELECT CAST(COUNT(DISTINCT articleId) AS INTEGER) AS totalArticleCount
          FROM (${scopeArticleSql}) scope_article
        `),
    db.queryJson<{humanJudgedArticleCount: number | string | null}>(
      getHumanJudgedArticleCountSql({
        humanJudgmentMode: project?.humanJudgmentMode === 'summary' ? 'summary' : 'prompt',
        projectId,
        scopeArticleSql,
      }),
    ),
  ])

  return {
    articleCount: Number(tableScope?.totalArticleCount ?? 0),
    humanJudgedArticleCount: Number(human?.humanJudgedArticleCount ?? 0),
  }
}

const loadJudgmentJobStopConditionDefaults = async ({
  db,
  jobId,
  projectId,
}: {
  db: JudgmentJobStopDefaultsQueryRunner
  jobId: string
  projectId: string
}): Promise<JudgmentJobStopConditionDefaults> => {
  const [articleCounts, admittedArticleCount, totalTokens] = await Promise.all([
    getProjectStopConditionArticleCounts({db, projectId}),
    getJudgmentJobCurrentAdmittedArticleCount({db, jobId}),
    getJudgmentJobTotalTokens({db, jobId}),
  ])

  return {...articleCounts, admittedArticleCount, totalTokens}
}

export const getJudgmentJobStopConditionDefaults = async (input: {
  db: JudgmentJobStopDefaultsQueryRunner
  jobId: string
  projectId: string
}): Promise<JudgmentJobStopConditionDefaults> => {
  const cached = stopConditionDefaultsCache.get(input.jobId)

  if (cached && cached.expiresAt > Date.now()) {
    return cached.value
  }

  const value = loadJudgmentJobStopConditionDefaults(input)

  stopConditionDefaultsCache.set(input.jobId, {expiresAt: Date.now() + stopConditionDefaultsCacheTtlMs, value})
  void value.catch(() => {
    stopConditionDefaultsCache.delete(input.jobId)
  })

  return value
}
