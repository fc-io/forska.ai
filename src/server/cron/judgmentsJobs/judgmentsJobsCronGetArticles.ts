import {desc, eq, inArray, notInArray} from 'drizzle-orm'

import {articles, judgments, projects, prompts} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

export const judgmentsJobsCronGetArticles = async ({
  projectId,
  numberOfArticlesToGet,
  articlesAlreadyProccessing = [],
}: {
  numberOfArticlesToGet: number
  projectId: string
  articlesAlreadyProccessing: string[]
}) => {
  const db = getDatabase()

  // Get project and its prompts
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1)

  if (!project) {
    return []
  }

  const projectPrompts = await db.select().from(prompts).where(eq(prompts.projectId, projectId))

  if (projectPrompts.length === 0) {
    // No prompts, return latest articles
    const latestArticles = await db
      .select()
      .from(articles)
      .orderBy(desc(articles.articleUpdatedAt))
      .limit(numberOfArticlesToGet)

    return {articles: latestArticles, prompts: projectPrompts}
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

  // Get latest articles excluding those already judged by all prompts and those currently processing
  let query = db.select().from(articles).orderBy(desc(articles.articleUpdatedAt)).limit(numberOfArticlesToGet)

  const excludeIds = [...fullyJudgedArticleIds, ...articlesAlreadyProccessing]
  if (excludeIds.length > 0) {
    query = query.where(notInArray(articles.id, excludeIds))
  }

  const articlesToJudge = await query

  // return {articles: articlesToJudge, prompts: projectPrompts}
  return articlesToJudge.map((article) => {
    return article.id
  })
}
