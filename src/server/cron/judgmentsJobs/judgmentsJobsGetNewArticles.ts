import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'
import {env} from '../../utils/env.ts'
import {judgmentsJobsCronGetArticles} from './judgmentsJobsCronGetArticles.ts'
import type {judgmentsJobsGetJobs} from './judgmentsJobsGetJobs.ts'

type Job = Awaited<ReturnType<typeof judgmentsJobsGetJobs>>[number]

const fetchArticlesForJob = async (job: Job) => {
  const {SGLANG_MAX_RUNNING_REQUESTS} = env
  const articleData = await judgmentsJobsCronGetArticles(job.projectId, job.id, SGLANG_MAX_RUNNING_REQUESTS)

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
    : fetchArticlesForJob(job).then((res) => {
        const nextAcc = [...acc, res]
        return fetchSequentially(db, rest, nextAcc)
      })
}

export const judgmentsJobsGetNewArticles = async (db: PostgresJsDatabase<typeof schema>, allJobs: Job[]) => {
  const result = await fetchSequentially(db, allJobs, [])
  return result
}
