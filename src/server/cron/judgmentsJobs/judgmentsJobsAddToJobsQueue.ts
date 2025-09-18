// import {and, eq, inArray} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'

const addArticlesToProcessing = async (
  db: PostgresJsDatabase<typeof schema>,
  jobId: string,
  articleIds: string[],
  serverJobId: string,
): Promise<void> => {
  if (articleIds.length === 0) return

  await db.insert(schema.judgmentsJobsArticles).values(
    articleIds.map((articleId) => {
      return {jobId, articleId, status: 'ready' as const, serverId: serverJobId}
    }),
  )
}

export const judgmentsJobsAddToJobsQueue = (
  db: PostgresJsDatabase<typeof schema>,
  articlesData: Array<{job: {id: string}; articlesToJudgeIds: string[]}>,
  serverJobId: string,
) => {
  return Promise.all(
    articlesData.map(({job, articlesToJudgeIds}) => {
      return addArticlesToProcessing(db, job.id, articlesToJudgeIds, serverJobId)
    }),
  )
}
