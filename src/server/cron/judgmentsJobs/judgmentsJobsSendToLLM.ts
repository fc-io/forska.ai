import {and, eq} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import {judge} from '../../../agent/judge.ts'
import * as schema from '../../../db/schema.ts'
import {markArticlesAsJudged} from './judgmentsJobsArticlesRepository.ts'

type ArticleToProcess = {jobId: string; articleId: string; recordId: string; projectId: string}

const getAndUpdateReadyArticles = async (
  db: PostgresJsDatabase<typeof schema>,
  serverJobId: string,
): Promise<ArticleToProcess[]> => {
  const articlesWithJobs = await db
    .update(schema.judgmentsJobsArticles)
    .set({status: 'sent', updatedAt: new Date()})
    .where(
      and(eq(schema.judgmentsJobsArticles.status, 'ready'), eq(schema.judgmentsJobsArticles.serverId, serverJobId)),
    )
    .returning({
      recordId: schema.judgmentsJobsArticles.id,
      articleId: schema.judgmentsJobsArticles.articleId,
      jobId: schema.judgmentsJobsArticles.jobId,
    })

  const articlesWithProjects = await Promise.all(
    articlesWithJobs.map(async (article) => {
      const [job] = await db
        .select({projectId: schema.judgmentsJobs.projectId})
        .from(schema.judgmentsJobs)
        .where(eq(schema.judgmentsJobs.id, article.jobId))
        .limit(1)

      return {...article, projectId: job?.projectId || ''}
    }),
  )

  return articlesWithProjects.filter((article) => {
    return article.projectId
  })
}

const processArticleWithLLM = async (
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
      await judge({articles: [article], prompts, sessionId})
      await markArticlesAsJudged(db, articleToProcess.jobId, [articleToProcess.articleId])
    }
  } catch (error) {
    console.error('Error sending to LLM:', error)
  }
}

export const judgmentsJobsSendToLLM = async (
  db: PostgresJsDatabase<typeof schema>,
  serverJobId: string,
): Promise<void> => {
  console.log('send to LLM')

  const articlesToProcess = await getAndUpdateReadyArticles(db, serverJobId)
  console.log('articlesToProcess length:', articlesToProcess.length)

  if (articlesToProcess.length === 0) {
    console.log('No articles to process')
    return
  }

  await Promise.all(
    articlesToProcess.map(async (article) => {
      await processArticleWithLLM(db, article)
    }),
  )

  console.log('end send to LLM')
}
