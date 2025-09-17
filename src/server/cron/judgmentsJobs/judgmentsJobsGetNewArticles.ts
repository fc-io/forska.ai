import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'
import {MAX_ARTICLES_BATCH_SIZE} from '../judgmentsJobs.ts'
import {getProcessingArticleIds} from './judgmentsJobsArticlesRepository.ts'
import {judgmentsJobsCronGetArticles} from './judgmentsJobsCronGetArticles.ts'
import type {JobData} from './judgmentsJobsTypes.ts'

const fetchArticlesForJob = async (db: PostgresJsDatabase<typeof schema>, job: JobData) => {
  const existingArticleIds = await getProcessingArticleIds(db, job.jobId)

  const {articlesToJudgeIds} = await judgmentsJobsCronGetArticles(
    job.projectId,
    MAX_ARTICLES_BATCH_SIZE,
    existingArticleIds,
  )

  return {jobId: job.jobId, articlesToJudgeIds}
}

export const judgmentsJobsGetNewArticles = async (db: PostgresJsDatabase<typeof schema>, allJobs: JobData[]) => {
  const articlesData = await Promise.all(
    allJobs.map((job) => {
      return fetchArticlesForJob(db, job)
    }),
  )

  return articlesData
}
