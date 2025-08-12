import {desc, eq, inArray, notInArray} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {articles, judgments, projects, prompts} from '../../db/schema.ts'
import {getDatabase} from '../utils/getDatabase.ts'

export const judgablesRoutes = new Elysia().post(
  '/api/projects/judgables',
  async ({body}) => {
    try {
      const db = getDatabase()

      // Get project and its prompts
      const [project] = await db
        .select()
        .from(projects)
        .where(eq(projects.id, body.projectId))
        .limit(1)

      if (!project) {
        return {
          data: [] as (typeof articles.$inferSelect)[],
          error: 'Project not found',
        }
      }

      const projectPrompts = await db
        .select()
        .from(prompts)
        .where(eq(prompts.projectId, body.projectId))

      if (projectPrompts.length === 0) {
        // No prompts, return latest articles
        const latestArticles = await db
          .select()
          .from(articles)
          .orderBy(desc(articles.articleUpdatedAt))
          .limit(body.numberOfArticlesToGet)

        return {
          data: latestArticles.map((data) => {
            return {...data, prompts: projectPrompts}
          }),
        }
      }

      // Get all judgments for all prompts in this project
      const allJudgments = await db
        .select({articleId: judgments.articleId, promptId: judgments.promptId})
        .from(judgments)
        .where(
          inArray(
            judgments.promptId,
            projectPrompts.map((p) => {
              return p.id
            }),
          ),
        )

      // Find articles that have been judged by ALL prompts
      const articleJudgmentCounts = allJudgments.reduce(
        (acc, judgment) => {
          const articleId = judgment.articleId
          if (!acc[articleId]) {
            acc[articleId] = new Set()
          }
          acc[articleId].add(judgment.promptId)
          return acc
        },
        {} as Record<string, Set<string>>,
      )

      const fullyJudgedArticleIds = Object.entries(articleJudgmentCounts)
        .filter(([_, promptIds]) => {
          return promptIds.size === projectPrompts.length
        })
        .map(([articleId]) => {
          return articleId
        })

      // Get latest articles excluding those already judged by all prompts
      let query = db
        .select()
        .from(articles)
        .orderBy(desc(articles.articleUpdatedAt))
        .limit(body.numberOfArticlesToGet)

      if (fullyJudgedArticleIds.length > 0) {
        query = query.where(notInArray(articles.id, fullyJudgedArticleIds))
      }

      const articlesToJudge = await query

      return {
        data: articlesToJudge.map((data) => {
          return {...data, prompts: projectPrompts}
        }),
      }
    } catch (error) {
      console.error('Error fetching articles to judge:', error)
      return {
        data: [] as (typeof articles.$inferSelect)[],
        error: 'Failed to fetch articles to judge',
      }
    }
  },
  {body: t.Object({numberOfArticlesToGet: t.Number(), projectId: t.String()})},
)
