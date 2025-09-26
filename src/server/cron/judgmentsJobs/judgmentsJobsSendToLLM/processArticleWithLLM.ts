import {eq} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import {judge} from '../../../../agent/judge.ts'
import * as schema from '../../../../db/schema.ts'
import {markArticlesAsJudged} from '../judgmentsJobsArticlesRepository.ts'
import type {ArticleToProcess} from './getAndUpdateReadyArticles.ts'

const judgeAndMark = async (
  db: PostgresJsDatabase<typeof schema>,
  articleToProcess: ArticleToProcess,
  article: typeof schema.articles.$inferSelect,
  prompts: (typeof schema.prompts.$inferSelect)[],
): Promise<void> => {
  const sessionId = null
  const randomDelay = Math.floor(Math.random() * (300 - 100 + 1)) + 100
  await new Promise((resolve) => {
    return setTimeout(resolve, randomDelay)
  })
  await judge({
    articles: [article],
    prompts,
    sessionId,
    judgmentsJobId: articleToProcess.jobId,
    modelConfig: {
      modelId: articleToProcess.modelId,
      modelName: articleToProcess.modelName,
      baseURL: articleToProcess.modelBaseUrl,
    },
  })
  await markArticlesAsJudged(db, articleToProcess.jobId, [articleToProcess.articleId])
}

export const processArticleWithLLM = async (
  db: PostgresJsDatabase<typeof schema>,
  articleToProcess: ArticleToProcess,
): Promise<void> => {
  const [article] = await db
    .select()
    .from(schema.articles)
    .where(eq(schema.articles.id, articleToProcess.articleId))
    .limit(1)

  const prompts = await db.select().from(schema.prompts).where(eq(schema.prompts.projectId, articleToProcess.projectId))

  if (article && prompts.length > 0) {
    await judgeAndMark(db, articleToProcess, article, prompts)
  }
}
