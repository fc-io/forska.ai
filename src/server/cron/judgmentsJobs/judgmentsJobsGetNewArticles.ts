import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'
import {getProcessingArticleIds} from './judgmentsJobsArticlesRepository.ts'
import {judgmentsJobsCronGetArticles} from './judgmentsJobsCronGetArticles.ts'
import type {judgmentsJobsGetJobs} from './judgmentsJobsGetJobs.ts'

type Job = Awaited<ReturnType<typeof judgmentsJobsGetJobs>>[number]

const fetchArticlesForJob = async (db: PostgresJsDatabase<typeof schema>, job: Job, excludeIds: string[]) => {
  const batchSize = Math.max(Math.ceil(job.sendToLLMBatchSize / 3), 1)
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
