import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'
import {env} from '../../utils/env.ts'
import {getNumberOfArticlesInReadyQueue} from './getNumberOfArticlesInReadyQueue.ts'
import {isReadyToGetMoreArticles} from './isReadyToGetMoreArticles.ts'
import {judgmentsJobsCronGetArticles} from './judgmentsJobsCronGetArticles.ts'
import type {judgmentsJobsGetJobs} from './judgmentsJobsGetJobs.ts'

type Job = Awaited<ReturnType<typeof judgmentsJobsGetJobs>>[number]

export const judgmentsJobsGetNewArticles = async (
  db: PostgresJsDatabase<typeof schema>,
  allJobs: Job[],
  serverJobId: string,
) => {
  const {SGLANG_MAX_RUNNING_REQUESTS} = env
  // Fetch more articles per job to ensure we have enough buffer
  // Since we are fetching in parallel now, this will be much faster
  const articlesPerJob = Math.max(1, Number(SGLANG_MAX_RUNNING_REQUESTS || 1) * 5)

  const results = await Promise.all(
    allJobs.map(async (job) => {
      const readyCount = await getNumberOfArticlesInReadyQueue(db, serverJobId, job.id)
      if (isReadyToGetMoreArticles(readyCount)) {
        return fetchArticlesForJob(job, articlesPerJob)
      }
      return {articlesToJudgeIds: [], articlesToJudge: [], projectPrompts: [], job}
    }),
  )

  return results
}

const fetchArticlesForJob = async (job: Job, numberOfArticlesToGet: number) => {
  const articleData = await judgmentsJobsCronGetArticles(job.projectId, job.id, numberOfArticlesToGet)

  return {...articleData, job}
}
