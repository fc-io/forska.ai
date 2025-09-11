import {desc, eq, inArray, notInArray} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

const getPromptIds = (projectPrompts: (typeof schema.prompts.$inferSelect)[]) => {
  return projectPrompts.map((p) => {
    return p.id
  })
}

const getProjectJudgments = async ({db, promptIds}: {db: PostgresJsDatabase<typeof schema>; promptIds: string[]}) => {
  // Get all judgments for all prompts in this project
  return await db
    .select({articleId: schema.judgments.articleId, promptId: schema.judgments.promptId})
    .from(schema.judgments)
    .where(inArray(schema.judgments.promptId, promptIds))
}

const getFullyJudgedArticleIds = (
  allJudgments: {articleId: string; promptId: string}[],
  projectPromptsLength: number,
) => {
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
  console.log('articleJudgmentCounts', Object.keys(articleJudgmentCounts).length)

  return Object.entries(articleJudgmentCounts)
    .filter(([_, promptIds]) => {
      return promptIds.size === projectPromptsLength
    })
    .map(([articleId]) => {
      return articleId
    })
}

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

  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1)
  const projectPrompts = await db.select().from(schema.prompts).where(eq(schema.prompts.projectId, projectId))

  if (!project || projectPrompts.length === 0) {
    // No project, return nothing.
    // No prompts, return nothing cause there is no idea to judge when there are no prompts.
    return []
  }
  const promptIds = getPromptIds(projectPrompts)
  console.log('promptIds length', promptIds.length)
  const allJudgments = await getProjectJudgments({db, promptIds})
  console.log('allJudgments', allJudgments.length)
  // Find articles that have been judged by ALL prompts
  const fullyJudgedArticleIds = getFullyJudgedArticleIds(allJudgments, promptIds.length)
  console.log('fullyJudgedArticleIds length', fullyJudgedArticleIds.length)
  console.log('articlesAlreadyProccessing length', articlesAlreadyProccessing.length)

  // Get latest articles excluding those already judged by all prompts and those currently processing
  const excludeIds = [...fullyJudgedArticleIds, ...articlesAlreadyProccessing]

  const articlesToJudge =
    excludeIds.length > 0
      ? await db
          .select()
          .from(schema.articles)
          .where(notInArray(schema.articles.id, excludeIds))
          .orderBy(desc(schema.articles.articleUpdatedAt))
          .limit(numberOfArticlesToGet)
      : await db
          .select()
          .from(schema.articles)
          .orderBy(desc(schema.articles.articleUpdatedAt))
          .limit(numberOfArticlesToGet)

  // return {articles: articlesToJudge, prompts: projectPrompts}
  return articlesToJudge.map((article) => {
    return article.id
  })
}
