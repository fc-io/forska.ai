import {eq} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import {judge} from '../../../../agent/judge.ts'
import * as schema from '../../../../db/schema.ts'
import {markArticlesAsJudged} from '../judgmentsJobsArticlesRepository.ts'
import type {ArticleToProcess} from './types.ts'

export const processArticleWithLLM = async (
  db: PostgresJsDatabase<typeof schema>,
  articleToProcess: ArticleToProcess,
): Promise<void> => {
  const sessionId = null

  try {
    const [article] = await db
      .select()
      .from(schema.articles)
      .where(eq(schema.articles.id, articleToProcess.articleId))
      .limit(1)

    const prompts = await db
      .select()
      .from(schema.prompts)
      .where(eq(schema.prompts.projectId, articleToProcess.projectId))

    if (article && prompts.length > 0) {
      await judge({articles: [article], prompts, sessionId, judgmentsJobId: articleToProcess.jobId})
      await markArticlesAsJudged(db, articleToProcess.jobId, [articleToProcess.articleId])
    }
  } catch (error) {
    console.error('Error sending to LLM:', error)
  }
}
