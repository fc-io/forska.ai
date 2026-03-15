import {Elysia, t} from 'elysia'

import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {
  escapeSqlString,
  getDateValue,
  getProjectScopeClause,
  getQuotedStringList,
  getTimestampLiteral,
} from '../../services/appQueryHelpers.ts'
import {getAppQueryService} from '../../services/getAppQueryService.ts'

export const projectsRoutesGetArticlesReviewsHuman = new Elysia().post(
  '/api/articlesreviewshuman',
  async ({body}) => {
    try {
      const page = parseInt(body?.page || '1', 10)
      const limit = parseInt(body?.limit || '100', 10)
      const offset = (page - 1) * limit

      const fromDate = body.from ? new Date(`${body.from}T00:00:00.000Z`) : null
      const toDate = body.to ? new Date(`${body.to}T23:59:59.999Z`) : null
      const searchTitle = typeof body.search === 'string' ? body.search.trim() : ''

      const projectPromptRows = await getAppDatabaseService().queryJson<{id: string; order: number | null}>(`
        SELECT p.id AS id, pp.prompt_order AS "order"
        FROM app.project_prompt pp
        INNER JOIN app.prompt p ON p.id = pp.prompt_id
        WHERE pp.project_id = '${escapeSqlString(body.projectId)}'
          AND pp.enabled = TRUE
        ORDER BY pp.prompt_order ASC NULLS LAST, p.created_at ASC
      `)

      if (projectPromptRows.length === 0) {
        return {data: [], totalCount: 0, page, limit, totalPages: 0}
      }

      const promptIds = projectPromptRows.map((p) => {
        return p.id
      })

      const fullyAssessedArticleIdsQuery = await getAppDatabaseService().queryJson<{articleId: string}>(`
        SELECT article_id AS articleId
        FROM app.judgment_human
        WHERE project_id = '${escapeSqlString(body.projectId)}'
          AND is_answered = TRUE
          AND prompt_id IN (${getQuotedStringList(promptIds).join(', ')})
        GROUP BY article_id
        HAVING COUNT(DISTINCT prompt_id) = ${promptIds.length}
      `)

      const fullyAssessedArticleIds = [
        ...new Set(
          fullyAssessedArticleIdsQuery.map((r) => {
            return r.articleId
          }),
        ),
      ]

      // If no articles are fully assessed by humans, return early
      if (fullyAssessedArticleIds.length === 0) {
        return {data: [], totalCount: 0, page, limit, totalPages: 0}
      }

      const promptFilters = Object.entries(body.prompts || {}).map(([key, values]) => {
        return [key, Array.isArray(values) ? values : [String(values)]] as const
      })

      let candidateArticleIds = fullyAssessedArticleIds

      for (const [promptId, answers] of promptFilters) {
        const matchingArticles = await getAppDatabaseService().queryJson<{articleId: string}>(`
          SELECT article_id AS articleId
          FROM app.judgment_human
          WHERE article_id IN (${getQuotedStringList(candidateArticleIds).join(', ')})
            AND prompt_id = '${escapeSqlString(promptId)}'
            AND answer IN (${getQuotedStringList(answers).join(', ')})
        `)
        candidateArticleIds = [
          ...new Set(
            matchingArticles.map((r) => {
              return r.articleId
            }),
          ),
        ]
        if (candidateArticleIds.length === 0) {
          return {data: [], totalCount: 0, page, limit, totalPages: 0}
        }
      }

      const projectConfig = await getAppQueryService().getProjectReviewConfig(body.projectId)
      const whereParts = [
        `a.id IN (${getQuotedStringList(candidateArticleIds).join(', ')})`,
        getProjectScopeClause({
          articleAlias: 'a',
          importRouteIds: projectConfig?.importRouteIds ?? [],
          projectId: body.projectId,
        }),
        projectConfig?.dateFrom ? `a.article_created_at >= ${getTimestampLiteral(projectConfig.dateFrom)}` : null,
        projectConfig?.dateTo ? `a.article_created_at <= ${getTimestampLiteral(projectConfig.dateTo)}` : null,
        fromDate ? `a.article_created_at >= ${getTimestampLiteral(fromDate)}` : null,
        toDate ? `a.article_created_at <= ${getTimestampLiteral(toDate)}` : null,
        searchTitle ? `LOWER(COALESCE(a.article_title, '')) LIKE LOWER('%${escapeSqlString(searchTitle)}%')` : null,
      ].filter((part): part is string => {
        return part !== null
      })

      const [countRows, pageArticleIdRows] = await Promise.all([
        getAppDatabaseService().queryJson<{count: number}>(`
          SELECT COUNT(*) AS count
          FROM app.article a
          WHERE ${whereParts.join(' AND ')}
        `),
        getAppDatabaseService().queryJson<{id: string}>(`
          SELECT a.id AS id
          FROM app.article a
          WHERE ${whereParts.join(' AND ')}
          ORDER BY a.article_created_at DESC NULLS LAST, a.id ASC
          LIMIT ${limit}
          OFFSET ${offset}
        `),
      ])

      const totalCount = Number(countRows[0]?.count ?? 0)
      const articleIds = pageArticleIdRows.map((row) => {
        return row.id
      })
      const articlesWithHumanJudgments = await getAppQueryService().getFullArticlesByIds(articleIds)
      const allHumanJudgments =
        articleIds.length > 0
          ? await getAppDatabaseService().queryJson<{
              id: string
              createdAt: unknown
              updatedAt: unknown
              articleId: string
              promptId: string
              isAnswered: boolean
              answer: string | null
              comment: string | null
              projectId: string
            }>(`
              SELECT
                id,
                created_at AS createdAt,
                updated_at AS updatedAt,
                article_id AS articleId,
                prompt_id AS promptId,
                is_answered AS isAnswered,
                answer,
                comment,
                project_id AS projectId
              FROM app.judgment_human
              WHERE article_id IN (${getQuotedStringList(articleIds).join(', ')})
                AND prompt_id IN (${getQuotedStringList(promptIds).join(', ')})
            `)
          : []

      const judgmentsByArticle = allHumanJudgments.reduce(
        (acc, j) => {
          const arr = acc[j.articleId] ?? []
          return {...acc, [j.articleId]: [...arr, j]}
        },
        {} as Record<string, typeof allHumanJudgments>,
      )

      // Build prompt order map and sort judgments accordingly
      const promptOrderMap = projectPromptRows.reduce(
        (acc, p, idx) => {
          const ord = p.order ?? idx
          return {...acc, [p.id]: ord}
        },
        {} as Record<string, number>,
      )

      const articleOrder = new Map(
        articleIds.map((id, index) => {
          return [id, index]
        }),
      )
      const sortedArticles = [...articlesWithHumanJudgments].sort((left, right) => {
        return (
          (articleOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER)
          - (articleOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER)
        )
      })
      const result = sortedArticles.map((article) => {
        const unsorted = (judgmentsByArticle[article.id] || []).map((judgment) => {
          return {...judgment, createdAt: getDateValue(judgment.createdAt), updatedAt: getDateValue(judgment.updatedAt)}
        })
        const sorted = [...unsorted].sort((a, b) => {
          const ao = promptOrderMap[a.promptId] ?? Number.MAX_SAFE_INTEGER
          const bo = promptOrderMap[b.promptId] ?? Number.MAX_SAFE_INTEGER
          return ao - bo
        })
        return {...article, judgments: sorted}
      })

      return {data: result, totalCount, page, limit, totalPages: Math.ceil(totalCount / limit)}
    } catch (error) {
      console.error('Error fetching human articles reviews:', error)
      throw new Error(error instanceof Error ? error.message : 'Failed to fetch human articles reviews', {cause: error})
    }
  },
  {
    body: t.Object({
      from: t.Optional(t.String()),
      limit: t.String(),
      page: t.String(),
      projectId: t.String(),
      prompts: t.Record(t.String(), t.Array(t.String())),
      to: t.Optional(t.String()),
      search: t.Optional(t.String()),
    }),
  },
)
