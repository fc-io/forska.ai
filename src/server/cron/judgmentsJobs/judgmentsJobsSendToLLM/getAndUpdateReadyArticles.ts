import {and, eq, inArray} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../../db/schema.ts'
import type {ArticleToProcess} from './types.ts'

const onNoReadyArticles = async (): Promise<ArticleToProcess[]> => {
  return []
}

const getProjectIdForJob = async (db: PostgresJsDatabase<typeof schema>, jobId: string): Promise<string> => {
  const [job] = await db
    .select({projectId: schema.judgmentsJobs.projectId})
    .from(schema.judgmentsJobs)
    .where(eq(schema.judgmentsJobs.id, jobId))
    .limit(1)
  return job?.projectId || ''
}

const processReadyRows = async (
  db: PostgresJsDatabase<typeof schema>,
  serverJobId: string,
  readyRows: {id: string; articleId: string; jobId: string}[],
): Promise<ArticleToProcess[]> => {
  const readyIds = readyRows.map((r) => {
    return r.id
  })

  const articlesWithJobs = await db
    .update(schema.judgmentsJobsArticles)
    .set({status: 'sent', updatedAt: new Date()})
    .where(
      and(eq(schema.judgmentsJobsArticles.serverId, serverJobId), inArray(schema.judgmentsJobsArticles.id, readyIds)),
    )
    .returning({
      recordId: schema.judgmentsJobsArticles.id,
      articleId: schema.judgmentsJobsArticles.articleId,
      jobId: schema.judgmentsJobsArticles.jobId,
    })

  const selectedMap = new Set(readyIds)
  const selectedArticles = articlesWithJobs.filter((row) => {
    return selectedMap.has(row.recordId)
  })

  const articlesWithProjects = await Promise.all(
    selectedArticles.map(async (article) => {
      const projectId = await getProjectIdForJob(db, article.jobId)
      return {...article, projectId}
    }),
  )

  return articlesWithProjects.filter((article) => {
    return article.projectId
  })
}

export const getAndUpdateReadyArticles = async (
  db: PostgresJsDatabase<typeof schema>,
  serverJobId: string,
  limit: number,
): Promise<ArticleToProcess[]> => {
  const readyRows = await db
    .select({
      id: schema.judgmentsJobsArticles.id,
      articleId: schema.judgmentsJobsArticles.articleId,
      jobId: schema.judgmentsJobsArticles.jobId,
    })
    .from(schema.judgmentsJobsArticles)
    .where(
      and(eq(schema.judgmentsJobsArticles.status, 'ready'), eq(schema.judgmentsJobsArticles.serverId, serverJobId)),
    )
    .orderBy(schema.judgmentsJobsArticles.createdAt)
    .limit(limit)

  const isEmpty = readyRows.length === 0
  return isEmpty ? onNoReadyArticles() : processReadyRows(db, serverJobId, readyRows)
}
