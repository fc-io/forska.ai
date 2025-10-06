import {and, eq, inArray} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'

export const getProcessingArticles = async (
  db: PostgresJsDatabase<typeof schema>,
  jobId: string,
): Promise<(typeof schema.judgmentsJobsArticles.$inferSelect)[]> => {
  return await db.select().from(schema.judgmentsJobsArticles).where(eq(schema.judgmentsJobsArticles.jobId, jobId))
}

export const getProcessingArticleIds = async (
  db: PostgresJsDatabase<typeof schema>,
  jobId: string,
): Promise<string[]> => {
  const articles = await db
    .select({articleId: schema.judgmentsJobsArticles.articleId})
    .from(schema.judgmentsJobsArticles)
    .where(eq(schema.judgmentsJobsArticles.jobId, jobId))

  return articles.map((a) => {
    return a.articleId
  })
}

export const markArticlesAsSent = async (
  db: PostgresJsDatabase<typeof schema>,
  jobId: string,
  articleIds: string[],
): Promise<void> => {
  if (articleIds.length === 0) return

  await db
    .update(schema.judgmentsJobsArticles)
    .set({status: 'sent', sentAt: new Date(), updatedAt: new Date()})
    .where(
      and(eq(schema.judgmentsJobsArticles.jobId, jobId), inArray(schema.judgmentsJobsArticles.articleId, articleIds)),
    )
}

export const markArticlesAsJudged = async (
  db: PostgresJsDatabase<typeof schema>,
  jobId: string,
  articleIds: string[],
): Promise<void> => {
  if (articleIds.length === 0) return
  // this does not indicate if the article failed to be judged or not
  await db
    .update(schema.judgmentsJobsArticles)
    .set({status: 'judged', judgedAt: new Date(), updatedAt: new Date()})
    .where(
      and(eq(schema.judgmentsJobsArticles.jobId, jobId), inArray(schema.judgmentsJobsArticles.articleId, articleIds)),
    )
}

export const removeArticlesFromProcessing = async (
  db: PostgresJsDatabase<typeof schema>,
  jobId: string,
  articleIds: string[],
): Promise<void> => {
  if (articleIds.length === 0) return

  await db
    .delete(schema.judgmentsJobsArticles)
    .where(
      and(eq(schema.judgmentsJobsArticles.jobId, jobId), inArray(schema.judgmentsJobsArticles.articleId, articleIds)),
    )
}

export const getReadyArticles = async (
  db: PostgresJsDatabase<typeof schema>,
  jobId: string,
): Promise<{articleId: string; id: string}[]> => {
  return await db
    .select({id: schema.judgmentsJobsArticles.id, articleId: schema.judgmentsJobsArticles.articleId})
    .from(schema.judgmentsJobsArticles)
    .where(and(eq(schema.judgmentsJobsArticles.jobId, jobId), eq(schema.judgmentsJobsArticles.status, 'ready')))
}

export const getSentArticles = async (
  db: PostgresJsDatabase<typeof schema>,
  jobId: string,
): Promise<{articleId: string; id: string}[]> => {
  return await db
    .select({id: schema.judgmentsJobsArticles.id, articleId: schema.judgmentsJobsArticles.articleId})
    .from(schema.judgmentsJobsArticles)
    .where(and(eq(schema.judgmentsJobsArticles.jobId, jobId), eq(schema.judgmentsJobsArticles.status, 'sent')))
}
