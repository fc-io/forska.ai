import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'
import {judgmentsJobsCronGetArticles} from './judgmentsJobsCronGetArticles.ts'
import type {judgmentsJobsGetJobs} from './judgmentsJobsGetJobs.ts'

type Job = Awaited<ReturnType<typeof judgmentsJobsGetJobs>>[number]

let highestBatchSizePerJob = 0

const fetchArticlesForJob = async (db: PostgresJsDatabase<typeof schema>, job: Job) => {
  // Track the highest batch size seen and always use that to avoid queue starvation during ramp-up
  highestBatchSizePerJob = Math.max(highestBatchSizePerJob, job.sendToLLMBatchSize)
  const batchSize = Math.max(Math.ceil(highestBatchSizePerJob / 3), 1)
  const articleData = await judgmentsJobsCronGetArticles(job.projectId, job.id, batchSize)

  return {...articleData, job}
}

const fetchSequentially = async (
  db: PostgresJsDatabase<typeof schema>,
  jobs: Job[],
  acc: Array<Awaited<ReturnType<typeof fetchArticlesForJob>>>,
): Promise<Array<Awaited<ReturnType<typeof fetchArticlesForJob>>>> => {
  const [job, ...rest] = jobs
  return !job
    ? acc
    : fetchArticlesForJob(db, job).then((res) => {
        const nextAcc = [...acc, res]
        return fetchSequentially(db, rest, nextAcc)
      })
}

export const judgmentsJobsGetNewArticles = async (db: PostgresJsDatabase<typeof schema>, allJobs: Job[]) => {
  const result = await fetchSequentially(db, allJobs, [])
  return result
}
