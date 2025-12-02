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
  prompts: Array<{
    id: string
    originalText: string
    promptHeading: string | null
    order: number | null
    type: string | null
  }>,
): Promise<void> => {
  const sessionId = null
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
    projectId: articleToProcess.projectId,
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

  const prompts = await db
    .select({
      id: schema.prompts.id,
      originalText: schema.prompts.originalText,
      promptHeading: schema.prompts.promptHeading,
      order: schema.projectPrompts.order,
      type: schema.prompts.type,
    })
    .from(schema.projectPrompts)
    .innerJoin(schema.prompts, eq(schema.projectPrompts.promptId, schema.prompts.id))
    .where(
      and(eq(schema.projectPrompts.projectId, articleToProcess.projectId), eq(schema.projectPrompts.enabled, true)),
    )
    .orderBy(schema.projectPrompts.order)

  if (article && prompts.length > 0) {
    await judgeAndMark(db, articleToProcess, article, prompts)
  }
}
