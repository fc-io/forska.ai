import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'
import {env} from '../../utils/env.ts'
import {judgmentsJobsCronGetArticles} from './judgmentsJobsCronGetArticles.ts'
import type {judgmentsJobsGetJobs} from './judgmentsJobsGetJobs.ts'

type Job = Awaited<ReturnType<typeof judgmentsJobsGetJobs>>[number]

export const judgmentsJobsGetNewArticles = async (_db: PostgresJsDatabase<typeof schema>, allJobs: Job[]) => {
  const {SGLANG_MAX_RUNNING_REQUESTS} = env
  // Fetch more articles per job to ensure we have enough buffer
  // Since we are fetching in parallel now, this will be much faster
  const articlesPerJob = Math.max(1, Number(SGLANG_MAX_RUNNING_REQUESTS || 1) * 5)

  const results = await Promise.all(
    allJobs.map((job) => {
      return fetchArticlesForJob(job, articlesPerJob)
    }),
  )

  return results
}

const fetchArticlesForJob = async (job: Job, numberOfArticlesToGet: number) => {
  const articleData = await judgmentsJobsCronGetArticles(job.projectId, job.id, numberOfArticlesToGet)

  return {...articleData, job}
}
