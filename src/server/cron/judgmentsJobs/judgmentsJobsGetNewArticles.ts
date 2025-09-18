import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'
import {MAX_ARTICLES_BATCH_SIZE} from '../judgmentsJobs.ts'
import {getProcessingArticleIds} from './judgmentsJobsArticlesRepository.ts'
import {judgmentsJobsCronGetArticles} from './judgmentsJobsCronGetArticles.ts'
import type {judgmentsJobsGetJobs} from './judgmentsJobsGetJobs.ts'

type Job = Awaited<ReturnType<typeof judgmentsJobsGetJobs>>[number]

const fetchArticlesForJob = async (db: PostgresJsDatabase<typeof schema>, job: Job) => {
  const batchSize = Math.floor(job.sendToLLMBatchSize ?? MAX_ARTICLES_BATCH_SIZE / 3)
  const existingArticleIds = await getProcessingArticleIds(db, job.id)
  const articleData = await judgmentsJobsCronGetArticles(job.projectId, batchSize, existingArticleIds)

  return {...articleData, job}
}

export const judgmentsJobsGetNewArticles = async (db: PostgresJsDatabase<typeof schema>, allJobs: Job[]) => {
  const articlesData = await Promise.all(
    allJobs.map((job) => {
      return fetchArticlesForJob(db, job)
    }),
  )

  return articlesData
}
