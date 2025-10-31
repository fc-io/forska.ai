import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'
import {getProcessingArticleIds} from './judgmentsJobsArticlesRepository.ts'
import {judgmentsJobsCronGetArticles} from './judgmentsJobsCronGetArticles.ts'
import type {judgmentsJobsGetJobs} from './judgmentsJobsGetJobs.ts'

type Job = Awaited<ReturnType<typeof judgmentsJobsGetJobs>>[number]

let highestBatchSizePerJob = 0

const fetchArticlesForJob = async (db: PostgresJsDatabase<typeof schema>, job: Job, excludeIds: string[]) => {
  // Track the highest batch size seen and always use that to avoid queue starvation during ramp-up
  highestBatchSizePerJob = Math.max(highestBatchSizePerJob, job.sendToLLMBatchSize)
  const batchSize = Math.max(Math.ceil(highestBatchSizePerJob / 3), 1)
  const existingArticleIds = await getProcessingArticleIds(db, job.id)
  const articleData = await judgmentsJobsCronGetArticles(job.projectId, batchSize, [
    ...existingArticleIds,
    ...excludeIds,
  ])

  return {...articleData, job}
}

const fetchSequentially = async (
  db: PostgresJsDatabase<typeof schema>,
  jobs: Job[],
  acc: Array<Awaited<ReturnType<typeof fetchArticlesForJob>>>,
  excludeIds: string[],
): Promise<Array<Awaited<ReturnType<typeof fetchArticlesForJob>>>> => {
  const [job, ...rest] = jobs
  return !job
    ? acc
    : fetchArticlesForJob(db, job, excludeIds).then((res) => {
        const nextExclude = res.articlesToJudgeIds.length > 0 ? [...excludeIds, ...res.articlesToJudgeIds] : excludeIds
        const nextAcc = [...acc, res]
        return fetchSequentially(db, rest, nextAcc, nextExclude)
      })
}

export const judgmentsJobsGetNewArticles = async (db: PostgresJsDatabase<typeof schema>, allJobs: Job[]) => {
  const result = await fetchSequentially(db, allJobs, [], [])
  return result
}
