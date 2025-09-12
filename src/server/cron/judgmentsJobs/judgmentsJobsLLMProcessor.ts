import {eq} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import {judge} from '../../../agent/judge.ts'
import * as schema from '../../../db/schema.ts'
import {getReadyArticles, markArticlesAsJudged, markArticlesAsSent} from './judgmentsJobsArticlesRepository.ts'
import type {JobData} from './judgmentsJobsTypes.ts'

type ArticleToProcess = {jobId: string; articleId: string; recordId: string; projectId: string}

const getUnsentArticlesForJobs = async (
  db: PostgresJsDatabase<typeof schema>,
  jobs: JobData[],
): Promise<ArticleToProcess[]> => {
  const articlesToProcess: ArticleToProcess[] = []

  await Promise.all(
    jobs.map(async (job) => {
      const readyArticles = await getReadyArticles(db, job.jobId)
      readyArticles.forEach((article) => {
        articlesToProcess.push({
          jobId: job.jobId,
          articleId: article.articleId,
          recordId: article.id,
          projectId: job.projectId,
        })
      })
    }),
  )

  return articlesToProcess
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

export const sendArticlesToLLM = async (db: PostgresJsDatabase<typeof schema>, allJobs: JobData[]): Promise<void> => {
  console.log('send to LLM')

  const articlesToProcess = await getUnsentArticlesForJobs(db, allJobs)
  console.log('articlesToProcess length:', articlesToProcess.length)

  if (articlesToProcess.length === 0) {
    console.log('No articles to process')
    return
  }

  const jobArticleMap = new Map<string, string[]>()

  articlesToProcess.forEach((article) => {
    const existingIds = jobArticleMap.get(article.jobId) || []
    jobArticleMap.set(article.jobId, [...existingIds, article.articleId])
  })

  await Promise.all(
    Array.from(jobArticleMap.entries()).map(async ([jobId, ids]) => {
      await markArticlesAsSent(db, jobId, ids)
    }),
  )

  await Promise.all(
    articlesToProcess.map(async (article) => {
      await processArticleWithLLM(db, article)
    }),
  )

  console.log('end send to LLM')
}
